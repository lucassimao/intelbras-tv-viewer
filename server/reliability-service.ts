import { CAMERAS, STREAM_PROFILES } from "../src/config/cameras.ts";
import {
  CAMERA_IDS,
  STARTUP_HISTORY_LIMIT,
  STREAM_PROFILE_IDS,
  TELEMETRY_HISTORY_LIMIT,
  TELEMETRY_POLL_MS,
  TELEMETRY_TIMEOUT_MS,
} from "./config.ts";

export type TelemetryState = "online" | "offline" | "degraded" | "idle" | "unknown";
type MetricPoint = { name: string; labels: Record<string, string>; value: number };
type TelemetryHistoryEntry = { at: number; ready: boolean | null; inboundBytes: number | null };
export type PathTelemetry = {
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
export type ReliabilitySnapshot = {
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

const limitations = {
  lastFrameAge:
    "MediaMTX 1.20.1 exposes no per-path last-frame timestamp for HLS; this dashboard reports N/A.",
  packetLoss:
    "RTSP packet-loss and jitter counters are aggregate session metrics without a path label; HLS profiles report N/A.",
  startup:
    "Measured by the viewer from profile selection or retry until the HTML video emits playing.",
};

function emptySource(): ReliabilitySnapshot["source"] {
  return {
    api: "MediaMTX Control API v3",
    metrics: "MediaMTX Prometheus /metrics",
    version: "1.20.1",
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export function parsePrometheusMetrics(body: string): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const value = Number(match[3]);
    if (Number.isFinite(value)) {
      points.push({ name: match[1], labels: parsePrometheusLabels(match[2]), value });
    }
  }
  return points;
}

export type ReliabilityService = {
  refresh(): Promise<void> | undefined;
  snapshot(): ReliabilitySnapshot;
  recordStartup(cameraId: string, profileId: string, startupMs: number): boolean;
  start(): void;
  stop(): void;
};

export function createReliabilityService(options: {
  apiUrl: string;
  metricsUrl: string;
}): ReliabilityService {
  const history = new Map<string, TelemetryHistoryEntry[]>();
  const startups = new Map<string, number[]>();
  let latest: ReliabilitySnapshot | undefined;
  let refreshPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function recordHistory(
    key: string,
    ready: boolean | null,
    inboundBytes: number | null,
    at: number,
  ) {
    const entries = history.get(key) ?? [];
    entries.push({ at, ready, inboundBytes });
    if (entries.length > TELEMETRY_HISTORY_LIMIT)
      entries.splice(0, entries.length - TELEMETRY_HISTORY_LIMIT);
    history.set(key, entries);
  }

  function historyFor(key: string) {
    return (history.get(key) ?? []).slice(-12).map((entry) => ({
      at: new Date(entry.at).toISOString(),
      ready: entry.ready,
      inboundBytes: entry.inboundBytes,
    }));
  }

  function latestStartup(cameraId: string, profileId: string) {
    const samples = startups.get(`${cameraId}:${profileId}`) ?? [];
    return { startupMs: samples.at(-1) ?? null, startupSamples: samples.length };
  }

  async function fetchWithTimeout(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const now = Date.now();
      try {
        const [apiResponse, metricsResponse] = await Promise.all([
          fetchWithTimeout(`${options.apiUrl}/v3/paths/list`),
          fetchWithTimeout(options.metricsUrl),
        ]);
        if (!apiResponse.ok || !metricsResponse.ok)
          throw new Error("mediamtx_telemetry_unavailable");
        const apiPayload = parseJsonObject(await apiResponse.json());
        const items = Array.isArray(apiPayload?.items) ? apiPayload.items : [];
        await metricsResponse.text();
        const paths = new Map<string, Record<string, unknown>>();
        for (const item of items) {
          const path = parseJsonObject(item);
          if (typeof path?.name === "string") paths.set(path.name, path);
        }
        const cameraTelemetry: PathTelemetry[] = [];
        for (const camera of CAMERAS) {
          for (const profile of STREAM_PROFILES) {
            const path = camera.enabled ? `${camera.streamPath}${profile.pathSuffix}` : null;
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
        latest = {
          generatedAt: new Date(now).toISOString(),
          stale: false,
          source: emptySource(),
          cameras: cameraTelemetry,
          limitations,
        };
      } catch (error) {
        console.warn(
          "MediaMTX telemetry refresh failed",
          error instanceof Error ? error.message : "unknown_error",
        );
        if (latest) latest = { ...latest, stale: true };
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  }

  function emptySnapshot(): ReliabilitySnapshot {
    return {
      generatedAt: new Date(0).toISOString(),
      stale: true,
      source: emptySource(),
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
      limitations,
    };
  }

  return {
    refresh,
    snapshot() {
      return latest ?? emptySnapshot();
    },
    recordStartup(cameraId, profileId, startupMs) {
      if (
        !CAMERA_IDS.has(cameraId) ||
        !CAMERAS.some((camera) => camera.id === cameraId && camera.enabled) ||
        !STREAM_PROFILE_IDS.has(profileId) ||
        !Number.isInteger(startupMs) ||
        startupMs < 0 ||
        startupMs > 120_000
      ) {
        return false;
      }
      const key = `${cameraId}:${profileId}`;
      const samples = startups.get(key) ?? [];
      samples.push(startupMs);
      if (samples.length > STARTUP_HISTORY_LIMIT)
        samples.splice(0, samples.length - STARTUP_HISTORY_LIMIT);
      startups.set(key, samples);
      if (latest) {
        latest = {
          ...latest,
          cameras: latest.cameras.map((camera) =>
            camera.cameraId === cameraId && camera.profileId === profileId
              ? { ...camera, startupMs, startupSamples: samples.length }
              : camera,
          ),
        };
      }
      return true;
    },
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), TELEMETRY_POLL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
