import { spawn } from "node:child_process";
import { CAMERAS, STREAM_PROFILES, streamPathForProfile } from "../src/config/cameras.ts";
import {
  SNAPSHOT_CONCURRENCY,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LEASE_GRACE_MS,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_TIMEOUT_MS,
} from "./config.ts";

export type SnapshotStatus = "waiting" | "capturing" | "ready" | "stale" | "error" | "locked";
export type SnapshotStatusEntry = {
  cameraId: string;
  status: SnapshotStatus;
  capturedAt: string | null;
  ageMs: number | null;
  revision: number;
};

type SnapshotCacheEntry = {
  cameraId: string;
  status: Exclude<SnapshotStatus, "locked">;
  capturedAt: string | null;
  revision: number;
  image: Buffer | null;
  error: string | null;
};

export type SnapshotService = {
  acquireLease(priorityCameraIds: readonly string[]): Promise<void>;
  releaseLease(): void;
  isLeaseActive(): boolean;
  statuses(): SnapshotStatusEntry[];
  get(cameraId: string): { image: Buffer; capturedAt: string; revision: number } | null;
  getError(cameraId: string): string | null;
  stop(): void;
};

function cameraForSnapshot(cameraId: string) {
  return CAMERAS.find((camera) => camera.id === cameraId && camera.enabled);
}

export function createSnapshotService(options: {
  ffmpeg: string;
  rtspOrigin: string;
}): SnapshotService {
  const snapshotProfile =
    STREAM_PROFILES.find((profile) => profile.subtype === 1) ??
    (() => {
      throw new Error("A subtype=1 stream profile is required for snapshots");
    })();
  const cache = new Map<string, SnapshotCacheEntry>();
  let leaseAt = 0;
  let scheduler: ReturnType<typeof setTimeout> | undefined;
  let refreshPromise: Promise<void> | undefined;
  let revision = 0;
  let priorityCameraIds: string[] = [];

  function snapshotPath(cameraId: string) {
    const camera = cameraForSnapshot(cameraId);
    return camera ? `${options.rtspOrigin}/${streamPathForProfile(camera, snapshotProfile)}` : null;
  }

  function ensureEntry(cameraId: string) {
    const current = cache.get(cameraId);
    if (current) return current;
    const created: SnapshotCacheEntry = {
      cameraId,
      status: "waiting",
      capturedAt: null,
      revision: 0,
      image: null,
      error: null,
    };
    cache.set(cameraId, created);
    return created;
  }

  function leaseActive() {
    return Date.now() - leaseAt <= SNAPSHOT_LEASE_GRACE_MS;
  }

  function scheduleRefresh(delayMs = SNAPSHOT_INTERVAL_MS) {
    if (scheduler) return;
    scheduler = setTimeout(() => {
      scheduler = undefined;
      if (leaseActive()) {
        void refresh();
        scheduleRefresh();
      }
    }, delayMs);
    scheduler.unref();
  }

  function capture(cameraId: string): Promise<Buffer> {
    const input = snapshotPath(cameraId);
    if (!input) return Promise.reject(new Error("camera_not_available"));
    return new Promise((resolveCapture, rejectCapture) => {
      const child = spawn(
        options.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-rtsp_transport",
          "tcp",
          "-timeout",
          String(SNAPSHOT_TIMEOUT_MS * 1_000),
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          "-q:v",
          "5",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => child.kill("SIGKILL"), SNAPSHOT_TIMEOUT_MS);
      const finish = (error: Error | null, image?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectCapture(error);
        else if (image) resolveCapture(image);
        else rejectCapture(new Error("snapshot_empty"));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > SNAPSHOT_MAX_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("snapshot_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-400);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (code === 0 && size > 0) finish(null, Buffer.concat(chunks));
        else finish(new Error(stderr.trim() || `ffmpeg_exit_${String(code)}`));
      });
    });
  }

  async function refresh() {
    if (refreshPromise || !leaseActive()) return refreshPromise;
    refreshPromise = (async () => {
      const enabled = CAMERAS.filter((camera) => camera.enabled);
      const priority = priorityCameraIds
        .map((cameraId) => enabled.find((camera) => camera.id === cameraId))
        .filter((camera): camera is (typeof enabled)[number] => camera !== undefined);
      const ordered = [
        ...priority,
        ...enabled.filter((camera) => !priorityCameraIds.includes(camera.id)),
      ];
      let cursor = 0;
      const worker = async () => {
        while (cursor < ordered.length && leaseActive()) {
          const camera = ordered[cursor];
          cursor += 1;
          const entry = ensureEntry(camera.id);
          entry.status = "capturing";
          try {
            const image = await capture(camera.id);
            revision += 1;
            entry.image = image;
            entry.revision = revision;
            entry.capturedAt = new Date().toISOString();
            entry.status = "ready";
            entry.error = null;
          } catch (error) {
            entry.status = entry.image ? "stale" : "error";
            entry.error = error instanceof Error ? error.message.slice(0, 120) : "snapshot_failed";
          }
        }
      };
      await Promise.all(Array.from({ length: SNAPSHOT_CONCURRENCY }, () => worker()));
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  }

  return {
    async acquireLease(requested) {
      priorityCameraIds = requested.slice(0, CAMERAS.length);
      leaseAt = Date.now();
      void refresh();
      scheduleRefresh(0);
    },
    releaseLease() {
      leaseAt = 0;
      priorityCameraIds = [];
      if (scheduler) {
        clearTimeout(scheduler);
        scheduler = undefined;
      }
    },
    isLeaseActive: leaseActive,
    statuses() {
      const now = Date.now();
      return CAMERAS.map((camera) => {
        if (!camera.enabled) {
          return {
            cameraId: camera.id,
            status: "locked" as const,
            capturedAt: null,
            ageMs: null,
            revision: 0,
          };
        }
        const entry = ensureEntry(camera.id);
        const ageMs = entry.capturedAt ? Math.max(0, now - Date.parse(entry.capturedAt)) : null;
        const status: SnapshotStatus =
          entry.status === "ready" && ageMs !== null && ageMs > SNAPSHOT_INTERVAL_MS * 2.5
            ? "stale"
            : entry.status;
        return {
          cameraId: camera.id,
          status,
          capturedAt: entry.capturedAt,
          ageMs,
          revision: entry.revision,
        };
      });
    },
    get(cameraId) {
      const entry = cache.get(cameraId);
      return entry?.image && entry.capturedAt
        ? { image: entry.image, capturedAt: entry.capturedAt, revision: entry.revision }
        : null;
    },
    getError(cameraId) {
      return cache.get(cameraId)?.error ?? null;
    },
    stop() {
      if (scheduler) clearTimeout(scheduler);
      scheduler = undefined;
      leaseAt = 0;
      priorityCameraIds = [];
    },
  };
}
