import { resolve } from "node:path";
import { CAMERAS, STREAM_PROFILES } from "../src/config/cameras.ts";

export const TELEMETRY_POLL_MS = 5_000;
export const TELEMETRY_TIMEOUT_MS = 1_500;
export const TELEMETRY_HISTORY_LIMIT = 60;
export const STARTUP_HISTORY_LIMIT = 20;
export const SNAPSHOT_INTERVAL_MS = 10_000;
export const SNAPSHOT_LEASE_GRACE_MS = 30_000;
export const SNAPSHOT_TIMEOUT_MS = 8_000;
export const SNAPSHOT_MAX_BYTES = 2_000_000;
export const SNAPSHOT_CONCURRENCY = 2;
export const REQUEST_BODY_MAX_BYTES = 16_384;

export type CameraCredentials = {
  username: string;
  password: string;
};

export type ServerConfig = {
  host: string;
  port: number;
  databasePath: string;
  mediamtxApiUrl: string;
  mediamtxMetricsUrl: string;
  snapshotFfmpeg: string;
  snapshotRtspOrigin: string;
};

export function loadCameraCredentials(env: NodeJS.ProcessEnv = process.env): CameraCredentials {
  const password = env.CAMERA_PASSWORD;
  const username = env.CAMERA_USERNAME ?? "admin";
  if (!/^[\u0021-\u007e]+$/.test(username) || !password) {
    throw new Error("CAMERA_PASSWORD and a valid CAMERA_USERNAME are required");
  }
  return { username, password };
}

function parsePort(value: string | undefined, fallback: number) {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CAMERA_API_PORT must be a valid TCP port");
  }
  return port;
}

function assertLoopbackHost(host: string) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("CAMERA_API_HOST must be a loopback address");
  }
}

function loadSnapshotRtspOrigin(value: string | undefined) {
  const candidate = value ?? "rtsp://127.0.0.1:8554";
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
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: (() => {
      const host = env.CAMERA_API_HOST ?? "127.0.0.1";
      assertLoopbackHost(host);
      return host;
    })(),
    port: parsePort(env.CAMERA_API_PORT, 8787),
    databasePath: resolve(env.CAMERA_DB_PATH ?? "runtime/cameras.sqlite"),
    mediamtxApiUrl: env.MEDIAMTX_API_URL ?? "http://127.0.0.1:9997",
    mediamtxMetricsUrl: env.MEDIAMTX_METRICS_URL ?? "http://127.0.0.1:9998/metrics",
    snapshotFfmpeg: env.SNAPSHOT_FFMPEG ?? "ffmpeg",
    snapshotRtspOrigin: loadSnapshotRtspOrigin(env.SNAPSHOT_RTSP_ORIGIN),
  };
}

export const CAMERA_IDS = new Set(CAMERAS.map((camera) => camera.id));
export const STREAM_PROFILE_IDS = new Set(STREAM_PROFILES.map((profile) => profile.id));
