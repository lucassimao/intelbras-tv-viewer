import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { CAMERAS, STREAM_PROFILES, streamPathForProfile } from "../src/config/cameras.ts";
import { MAX_CAMERA_NAME_LENGTH, normalizeCameraName } from "./camera-names.ts";
import { loadCameraCredentials } from "./camera-credentials.ts";
import {
  createDigestPtzTransport,
  PTZ_ACTIONS,
  PTZ_DIRECTIONS,
  PtzController,
  type PtzAction,
  type PtzDirection,
} from "./ptz.ts";

const PORT = Number.parseInt(process.env.CAMERA_API_PORT ?? "8787", 10);
const HOST = process.env.CAMERA_API_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  throw new Error("CAMERA_API_HOST must be a loopback address");
}
const DATABASE_PATH = resolve(process.env.CAMERA_DB_PATH ?? "runtime/cameras.sqlite");
const CAMERA_IDS = new Set(CAMERAS.map((camera) => camera.id));
const STREAM_PROFILE_IDS = new Set(STREAM_PROFILES.map((profile) => profile.id));
const MEDIAMTX_API_URL = process.env.MEDIAMTX_API_URL ?? "http://127.0.0.1:9997";
const MEDIAMTX_METRICS_URL = process.env.MEDIAMTX_METRICS_URL ?? "http://127.0.0.1:9998/metrics";
const TELEMETRY_POLL_MS = 5_000;
const TELEMETRY_TIMEOUT_MS = 1_500;
const TELEMETRY_HISTORY_LIMIT = 60;
const STARTUP_HISTORY_LIMIT = 20;
const SNAPSHOT_INTERVAL_MS = 10_000;
const SNAPSHOT_LEASE_GRACE_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const SNAPSHOT_MAX_BYTES = 2_000_000;
const SNAPSHOT_FFMPEG = process.env.SNAPSHOT_FFMPEG ?? "ffmpeg";
const SNAPSHOT_RTSP_ORIGIN = (() => {
  const candidate = process.env.SNAPSHOT_RTSP_ORIGIN ?? "rtsp://127.0.0.1:8554";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("SNAPSHOT_RTSP_ORIGIN must be a loopback RTSP URL");
  }
  if (
    parsed.protocol !== "rtsp:" ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("SNAPSHOT_RTSP_ORIGIN must be a credential-free loopback RTSP origin");
  }
  return `rtsp://${parsed.host}`;
})();
const SNAPSHOT_PROFILE =
  STREAM_PROFILES.find((profile) => profile.subtype === 1) ??
  (() => {
    throw new Error("A subtype=1 stream profile is required for snapshots");
  })();

type JsonObject = Record<string, unknown>;

let database: DatabaseSync | undefined;
let ptzController: PtzController | undefined;

type TelemetryState = "online" | "offline" | "degraded" | "idle" | "unknown";
type MetricPoint = { name: string; labels: Record<string, string>; value: number };
type PathTelemetry = {
  cameraId: string;
  profileId: string;
  path: string;
  state: TelemetryState;
  ready: boolean | null;
  readers: number | null;
  inboundFramesInError: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  lastFrameAgeMs: number | null;
  lastFrameStatus: "unsupported";
  startupMs: number | null;
  startupSamples: number;
  observedAt: string | null;
  history: Array<{ at: string; ready: boolean | null; inboundBytes: number | null }>;
};
type ReliabilitySnapshot = {
  generatedAt: string;
  stale: boolean;
  source: {
    api: "MediaMTX Control API v3";
    metrics: "MediaMTX Prometheus /metrics";
    version: "1.20.1";
  };
  cameras: PathTelemetry[];
  limitations: {
    lastFrameAge: string;
    packetLoss: string;
    startup: string;
  };
};
type TelemetryHistoryEntry = { at: number; ready: boolean | null; inboundBytes: number | null };

const telemetryHistory = new Map<string, TelemetryHistoryEntry[]>();
const startupHistory = new Map<string, number[]>();
let latestReliability: ReliabilitySnapshot | undefined;
let telemetryRefresh: Promise<void> | undefined;

type SnapshotStatus = "waiting" | "capturing" | "ready" | "stale" | "offline" | "locked";
type SnapshotCacheEntry = {
  cameraId: string;
  status: Exclude<SnapshotStatus, "locked">;
  capturedAt: string | null;
  revision: number;
  image: Buffer | null;
  error: string | null;
};

const snapshotCache = new Map<string, SnapshotCacheEntry>();
let snapshotLeaseAt = 0;
let snapshotScheduler: ReturnType<typeof setTimeout> | undefined;
let snapshotRefresh: Promise<void> | undefined;
let snapshotRevision = 0;

function snapshotCamera(cameraId: string) {
  return CAMERAS.find((camera) => camera.id === cameraId && camera.enabled);
}

function snapshotPath(cameraId: string) {
  const camera = snapshotCamera(cameraId);
  return camera
    ? `${SNAPSHOT_RTSP_ORIGIN}/${streamPathForProfile(camera, SNAPSHOT_PROFILE)}`
    : null;
}

function ensureSnapshotEntry(cameraId: string): SnapshotCacheEntry {
  const current = snapshotCache.get(cameraId);
  if (current) return current;
  const created: SnapshotCacheEntry = {
    cameraId,
    status: "waiting",
    capturedAt: null,
    revision: 0,
    image: null,
    error: null,
  };
  snapshotCache.set(cameraId, created);
  return created;
}

function snapshotLeaseActive() {
  return Date.now() - snapshotLeaseAt <= SNAPSHOT_LEASE_GRACE_MS;
}

function scheduleSnapshotRefresh(delayMs = SNAPSHOT_INTERVAL_MS) {
  if (snapshotScheduler) return;
  snapshotScheduler = setTimeout(() => {
    snapshotScheduler = undefined;
    if (snapshotLeaseActive()) {
      void refreshSnapshots();
      scheduleSnapshotRefresh();
    }
  }, delayMs);
}

function captureSnapshot(cameraId: string): Promise<Buffer> {
  const input = snapshotPath(cameraId);
  if (!input) return Promise.reject(new Error("camera_not_available"));

  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(
      SNAPSHOT_FFMPEG,
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

async function refreshSnapshots() {
  if (snapshotRefresh || !snapshotLeaseActive()) return snapshotRefresh;
  snapshotRefresh = (async () => {
    // One capture at a time keeps camera and CPU load predictable. The cursor
    // rotates after each pass so a single slow camera cannot starve the wall.
    for (const camera of CAMERAS) {
      if (!camera.enabled || !snapshotLeaseActive()) continue;
      const entry = ensureSnapshotEntry(camera.id);
      entry.status = "capturing";
      try {
        const image = await captureSnapshot(camera.id);
        snapshotRevision += 1;
        entry.image = image;
        entry.revision = snapshotRevision;
        entry.capturedAt = new Date().toISOString();
        entry.status = "ready";
        entry.error = null;
      } catch (error) {
        entry.status = entry.image ? "stale" : "offline";
        entry.error = error instanceof Error ? error.message.slice(0, 120) : "snapshot_failed";
      }
    }
  })().finally(() => {
    snapshotRefresh = undefined;
  });
  return snapshotRefresh;
}

function snapshotStatuses() {
  const now = Date.now();
  return CAMERAS.map((camera) => {
    if (!camera.enabled)
      return {
        cameraId: camera.id,
        status: "locked" as const,
        capturedAt: null,
        ageMs: null,
        revision: 0,
      };
    const entry = ensureSnapshotEntry(camera.id);
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
}

function profilePath(cameraId: string, profileId: string) {
  const camera = CAMERAS.find((candidate) => candidate.id === cameraId);
  const profile = STREAM_PROFILES.find((candidate) => candidate.id === profileId);
  return camera?.enabled && profile ? `${camera.streamPath}${profile.pathSuffix}` : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePrometheusLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
  for (const match of raw.matchAll(pattern)) {
    labels[match[1]] = match[2].replace(/\\([\\"])\s?/g, "$1");
  }
  return labels;
}

function parsePrometheusMetrics(body: string): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const value = Number(match[3]);
    if (Number.isFinite(value))
      points.push({ name: match[1], labels: parsePrometheusLabels(match[2]), value });
  }
  return points;
}

function metricValues(points: readonly MetricPoint[], name: string) {
  return points.filter((point) => point.name === name);
}

function recordHistory(
  key: string,
  ready: boolean | null,
  inboundBytes: number | null,
  at: number,
) {
  const entries = telemetryHistory.get(key) ?? [];
  entries.push({ at, ready, inboundBytes });
  if (entries.length > TELEMETRY_HISTORY_LIMIT)
    entries.splice(0, entries.length - TELEMETRY_HISTORY_LIMIT);
  telemetryHistory.set(key, entries);
}

function historyFor(key: string) {
  return (telemetryHistory.get(key) ?? []).slice(-12).map((entry) => ({
    at: new Date(entry.at).toISOString(),
    ready: entry.ready,
    inboundBytes: entry.inboundBytes,
  }));
}

function latestStartup(cameraId: string, profileId: string) {
  const samples = startupHistory.get(`${cameraId}:${profileId}`) ?? [];
  return { startupMs: samples.at(-1) ?? null, startupSamples: samples.length };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshReliability() {
  if (telemetryRefresh) return telemetryRefresh;
  telemetryRefresh = (async () => {
    const now = Date.now();
    try {
      const [apiResponse, metricsResponse] = await Promise.all([
        fetchWithTimeout(`${MEDIAMTX_API_URL}/v3/paths/list`),
        fetchWithTimeout(MEDIAMTX_METRICS_URL),
      ]);
      if (!apiResponse.ok || !metricsResponse.ok) throw new Error("mediamtx_telemetry_unavailable");
      const apiPayload = parseJsonObject(await apiResponse.json());
      const items = Array.isArray(apiPayload?.items) ? apiPayload.items : [];
      const metrics = parsePrometheusMetrics(await metricsResponse.text());
      const paths = new Map<string, Record<string, unknown>>();
      for (const item of items) {
        const path = parseJsonObject(item);
        if (typeof path?.name === "string") paths.set(path.name, path);
      }

      const cameraTelemetry: PathTelemetry[] = [];
      for (const camera of CAMERAS) {
        for (const profile of STREAM_PROFILES) {
          const path = profilePath(camera.id, profile.id);
          if (!path) continue;
          const apiPath = paths.get(path);
          const ready = typeof apiPath?.ready === "boolean" ? apiPath.ready : null;
          const online = typeof apiPath?.online === "boolean" ? apiPath.online : null;
          const readers = Array.isArray(apiPath?.readers) ? apiPath.readers.length : null;
          const inboundFramesInError = numberOrNull(apiPath?.inboundFramesInError);
          const inboundBytes = numberOrNull(apiPath?.inboundBytes ?? apiPath?.bytesReceived);
          const observedAt = new Date(now).toISOString();
          recordHistory(`${camera.id}:${profile.id}`, ready, inboundBytes, now);

          const pathError = inboundFramesInError !== null && inboundFramesInError > 0;
          const state: TelemetryState =
            ready === true
              ? pathError
                ? "degraded"
                : "online"
              : online === false
                ? "offline"
                : online === true
                  ? "idle"
                  : "unknown";
          const startup = latestStartup(camera.id, profile.id);
          cameraTelemetry.push({
            cameraId: camera.id,
            profileId: profile.id,
            path,
            state,
            ready,
            readers,
            inboundFramesInError,
            packetLossPct: null,
            jitterMs: null,
            lastFrameAgeMs: null,
            lastFrameStatus: "unsupported",
            startupMs: startup.startupMs,
            startupSamples: startup.startupSamples,
            observedAt,
            history: historyFor(`${camera.id}:${profile.id}`),
          });
        }
      }

      // These counters are intentionally parsed to validate their availability,
      // but are not attached to a path: MediaMTX exposes them as aggregate RTSP
      // session metrics without a path label, so attributing them would be false.
      metricValues(metrics, "rtsp_sessions_inbound_rtp_packets_lost");
      metricValues(metrics, "rtsp_sessions_inbound_rtp_packets_jitter");
      latestReliability = {
        generatedAt: new Date(now).toISOString(),
        stale: false,
        source: {
          api: "MediaMTX Control API v3",
          metrics: "MediaMTX Prometheus /metrics",
          version: "1.20.1",
        },
        cameras: cameraTelemetry,
        limitations: {
          lastFrameAge:
            "MediaMTX 1.20.1 exposes no per-path last-frame timestamp for HLS; this dashboard reports N/A.",
          packetLoss:
            "RTSP packet-loss and jitter counters are aggregate session metrics without a path label; HLS profiles report N/A.",
          startup:
            "Measured by the viewer from profile selection or retry until the HTML video emits playing.",
        },
      };
    } catch (error) {
      console.warn(
        "MediaMTX telemetry refresh failed",
        error instanceof Error ? error.message : "unknown_error",
      );
      if (latestReliability) latestReliability = { ...latestReliability, stale: true };
    } finally {
      telemetryRefresh = undefined;
    }
  })();
  return telemetryRefresh;
}

function reliabilitySnapshot(): ReliabilitySnapshot {
  if (!latestReliability) {
    return {
      generatedAt: new Date(0).toISOString(),
      stale: true,
      source: {
        api: "MediaMTX Control API v3",
        metrics: "MediaMTX Prometheus /metrics",
        version: "1.20.1",
      },
      cameras: CAMERAS.filter((camera) => camera.enabled).flatMap((camera) =>
        STREAM_PROFILES.map((profile) => ({
          cameraId: camera.id,
          profileId: profile.id,
          path: `${camera.streamPath}${profile.pathSuffix}`,
          state: "unknown" as const,
          ready: null,
          readers: null,
          inboundFramesInError: null,
          packetLossPct: null,
          jitterMs: null,
          lastFrameAgeMs: null,
          lastFrameStatus: "unsupported" as const,
          startupMs: latestStartup(camera.id, profile.id).startupMs,
          startupSamples: latestStartup(camera.id, profile.id).startupSamples,
          observedAt: null,
          history: [],
        })),
      ),
      limitations: {
        lastFrameAge:
          "MediaMTX 1.20.1 exposes no per-path last-frame timestamp for HLS; this dashboard reports N/A.",
        packetLoss:
          "RTSP packet-loss and jitter counters are aggregate session metrics without a path label; HLS profiles report N/A.",
        startup:
          "Measured by the viewer from profile selection or retry until the HTML video emits playing.",
      },
    };
  }
  return latestReliability;
}

void refreshReliability();
const telemetryTimer = setInterval(() => void refreshReliability(), TELEMETRY_POLL_MS);
telemetryTimer.unref();

function getDatabase() {
  if (database) return database;

  mkdirSync(dirname(DATABASE_PATH), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(DATABASE_PATH, { timeout: 2_000, defensive: true });
  connection.exec(`
    CREATE TABLE IF NOT EXISTS camera_names (
      camera_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_CAMERA_NAME_LENGTH}),
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  database = connection;
  return connection;
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getPtzController() {
  if (ptzController) return ptzController;
  const credentials = await loadCameraCredentials();
  ptzController = new PtzController(CAMERAS, createDigestPtzTransport(credentials));
  return ptzController;
}

function readRequestBody(request: IncomingMessage) {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.byteLength;
      if (size > 16_384) {
        reject(new Error("request_too_large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function getNames() {
  const rows = getDatabase().prepare("SELECT camera_id, name FROM camera_names").all();
  const names: Record<string, string> = {};
  for (const row of rows) {
    const cameraId = row.camera_id;
    const name = row.name;
    if (typeof cameraId === "string" && typeof name === "string" && CAMERA_IDS.has(cameraId)) {
      names[cameraId] = name;
    }
  }
  return names;
}

function pathCameraId(pathname: string) {
  const match = /^\/api\/cameras\/([^/]+)\/name$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/api/health" && request.method === "GET") {
    jsonResponse(response, 200, { ok: true });
    return;
  }

  try {
    if (requestUrl.pathname === "/api/snapshots/lease" && request.method === "POST") {
      snapshotLeaseAt = Date.now();
      void refreshSnapshots();
      scheduleSnapshotRefresh(0);
      jsonResponse(response, 202, { active: true, statuses: snapshotStatuses() });
      return;
    }

    if (requestUrl.pathname === "/api/snapshots/lease" && request.method === "DELETE") {
      snapshotLeaseAt = 0;
      if (snapshotScheduler) {
        clearTimeout(snapshotScheduler);
        snapshotScheduler = undefined;
      }
      jsonResponse(response, 200, { active: false, statuses: snapshotStatuses() });
      return;
    }

    if (requestUrl.pathname === "/api/snapshots/status" && request.method === "GET") {
      jsonResponse(response, 200, { active: snapshotLeaseActive(), statuses: snapshotStatuses() });
      return;
    }

    const snapshotMatch = /^\/api\/snapshots\/([^/]+)$/.exec(requestUrl.pathname);
    if (snapshotMatch && request.method === "GET") {
      let cameraId: string;
      try {
        cameraId = decodeURIComponent(snapshotMatch[1]);
      } catch {
        jsonResponse(response, 400, { error: "invalid_camera_id" });
        return;
      }
      const camera = snapshotCamera(cameraId);
      if (!camera) {
        const knownCamera = CAMERAS.some((candidate) => candidate.id === cameraId);
        jsonResponse(response, knownCamera ? 423 : 404, {
          error: knownCamera ? "camera_locked" : "camera_not_found",
        });
        return;
      }
      const entry = ensureSnapshotEntry(cameraId);
      if (!entry.image || !entry.capturedAt) {
        jsonResponse(response, 404, { error: entry.error ?? "snapshot_unavailable" });
        return;
      }
      const etag = `"${entry.revision.toString(36)}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        "Content-Length": entry.image.byteLength,
        ETag: etag,
        "X-Snapshot-Captured-At": entry.capturedAt,
      });
      response.end(entry.image);
      return;
    }

    if (requestUrl.pathname === "/api/reliability" && request.method === "GET") {
      void refreshReliability();
      jsonResponse(response, 200, reliabilitySnapshot());
      return;
    }

    if (requestUrl.pathname === "/api/reliability/startup" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        jsonResponse(response, 400, { error: "invalid_json" });
        return;
      }
      const payload = parseJsonObject(body);
      const cameraId = payload?.cameraId;
      const profileId = payload?.profileId;
      const startupMs = payload?.startupMs;
      if (
        typeof cameraId !== "string" ||
        !CAMERA_IDS.has(cameraId) ||
        !CAMERAS.some((camera) => camera.id === cameraId && camera.enabled) ||
        typeof profileId !== "string" ||
        !STREAM_PROFILE_IDS.has(profileId) ||
        typeof startupMs !== "number" ||
        !Number.isInteger(startupMs) ||
        startupMs < 0 ||
        startupMs > 120_000
      ) {
        jsonResponse(response, 400, { error: "invalid_startup_measurement" });
        return;
      }
      const key = `${cameraId}:${profileId}`;
      const samples = startupHistory.get(key) ?? [];
      samples.push(startupMs);
      if (samples.length > STARTUP_HISTORY_LIMIT)
        samples.splice(0, samples.length - STARTUP_HISTORY_LIMIT);
      startupHistory.set(key, samples);
      if (latestReliability) {
        latestReliability = {
          ...latestReliability,
          cameras: latestReliability.cameras.map((camera) =>
            camera.cameraId === cameraId && camera.profileId === profileId
              ? { ...camera, startupMs, startupSamples: samples.length }
              : camera,
          ),
        };
      }
      jsonResponse(response, 202, { accepted: true });
      return;
    }

    if (requestUrl.pathname === "/api/ptz" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        jsonResponse(response, 400, { error: "invalid_json" });
        return;
      }
      const payload = parseJsonObject(body);
      const cameraId = payload?.cameraId;
      const action = payload?.action;
      const direction = payload?.direction;
      if (
        typeof cameraId !== "string" ||
        !CAMERA_IDS.has(cameraId) ||
        typeof action !== "string" ||
        !(PTZ_ACTIONS as readonly string[]).includes(action) ||
        (direction !== undefined &&
          (typeof direction !== "string" ||
            !(PTZ_DIRECTIONS as readonly string[]).includes(direction)))
      ) {
        jsonResponse(response, 400, { error: "invalid_ptz_command" });
        return;
      }
      const controller = await getPtzController();
      const result = await controller.command(
        cameraId,
        action as PtzAction,
        direction as PtzDirection | undefined,
      );
      if (result.ok) {
        jsonResponse(response, 200, result);
        return;
      }
      const status =
        result.error === "camera_not_ptz"
          ? 403
          : result.error === "already_moving"
            ? 409
            : result.error === "rate_limited"
              ? 429
              : 502;
      jsonResponse(response, status, result);
      return;
    }

    if (requestUrl.pathname === "/api/cameras/names" && request.method === "GET") {
      jsonResponse(response, 200, { names: getNames() });
      return;
    }

    const cameraId = pathCameraId(requestUrl.pathname);
    if (!cameraId || !CAMERA_IDS.has(cameraId)) {
      jsonResponse(response, 404, { error: "camera_not_found" });
      return;
    }

    if (request.method === "DELETE") {
      getDatabase().prepare("DELETE FROM camera_names WHERE camera_id = ?").run(cameraId);
      jsonResponse(response, 200, { cameraId, name: null });
      return;
    }

    if (request.method !== "PUT") {
      jsonResponse(response, 405, { error: "method_not_allowed" });
      return;
    }

    const rawBody = await readRequestBody(request);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      jsonResponse(response, 400, { error: "invalid_json" });
      return;
    }
    if (!isJsonObject(body) || !("name" in body)) {
      jsonResponse(response, 400, { error: "name_required" });
      return;
    }

    if (body.name === null) {
      getDatabase().prepare("DELETE FROM camera_names WHERE camera_id = ?").run(cameraId);
      jsonResponse(response, 200, { cameraId, name: null });
      return;
    }

    const name = normalizeCameraName(body.name);
    if (!name) {
      jsonResponse(response, 400, { error: "invalid_name", maxLength: MAX_CAMERA_NAME_LENGTH });
      return;
    }

    getDatabase()
      .prepare(`
      INSERT INTO camera_names (camera_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(camera_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `)
      .run(cameraId, name, new Date().toISOString());
    jsonResponse(response, 200, { cameraId, name });
  } catch (error) {
    console.error("Camera name API failure", error);
    jsonResponse(response, 503, { error: "storage_unavailable" });
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Camera name API listening on http://${HOST}:${PORT}`);
  console.log(`Camera names database: ${DATABASE_PATH}`);
});

function closeDatabase() {
  database?.close();
  database = undefined;
}

process.once("SIGINT", () => {
  void ptzController?.stopAll();
  closeDatabase();
  if (snapshotScheduler) clearTimeout(snapshotScheduler);
  server.close();
});
process.once("SIGTERM", () => {
  void ptzController?.stopAll();
  closeDatabase();
  if (snapshotScheduler) clearTimeout(snapshotScheduler);
  server.close();
});
