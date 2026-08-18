import { useCallback, useEffect, useState } from "react";

export type ReliabilityState = "online" | "offline" | "degraded" | "idle" | "unknown";

export type ReliabilityCamera = {
  cameraId: string;
  profileId: string;
  path: string;
  state: ReliabilityState;
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
};

export type ReliabilityData = {
  generatedAt: string;
  stale: boolean;
  source: { api: string; metrics: string; version: string };
  cameras: ReliabilityCamera[];
  limitations: { lastFrameAge: string; packetLoss: string; startup: string };
};

type ReliabilityResult = {
  data: ReliabilityData | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReliability(value: unknown): ReliabilityData | null {
  if (!isRecord(value) || !Array.isArray(value.cameras) || typeof value.generatedAt !== "string")
    return null;
  const cameras = value.cameras
    .filter(isRecord)
    .filter(
      (camera): camera is ReliabilityCamera =>
        typeof camera.cameraId === "string" &&
        typeof camera.profileId === "string" &&
        typeof camera.path === "string" &&
        typeof camera.state === "string" &&
        ["online", "offline", "degraded", "idle", "unknown"].includes(camera.state) &&
        (camera.packetLossPct === null || typeof camera.packetLossPct === "number") &&
        (camera.jitterMs === null || typeof camera.jitterMs === "number") &&
        (camera.lastFrameAgeMs === null || typeof camera.lastFrameAgeMs === "number") &&
        (camera.startupMs === null || typeof camera.startupMs === "number"),
    );
  if (!isRecord(value.source) || !isRecord(value.limitations)) return null;
  if (
    typeof value.source.api !== "string" ||
    typeof value.source.metrics !== "string" ||
    typeof value.source.version !== "string"
  )
    return null;
  if (
    typeof value.limitations.lastFrameAge !== "string" ||
    typeof value.limitations.packetLoss !== "string" ||
    typeof value.limitations.startup !== "string"
  )
    return null;
  return {
    generatedAt: value.generatedAt,
    stale: value.stale === true,
    source: { api: value.source.api, metrics: value.source.metrics, version: value.source.version },
    cameras,
    limitations: {
      lastFrameAge: value.limitations.lastFrameAge,
      packetLoss: value.limitations.packetLoss,
      startup: value.limitations.startup,
    },
  };
}

export function useReliability(): ReliabilityResult {
  const [data, setData] = useState<ReliabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const reload = useCallback(() => setRequestVersion((version) => version + 1), []);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/reliability", { cache: "no-store" });
        if (!response.ok) throw new Error("reliability_unavailable");
        const parsed = parseReliability((await response.json()) as unknown);
        if (!parsed) throw new Error("reliability_invalid");
        if (!disposed) {
          setData(parsed);
          setError(false);
          setLoading(false);
        }
      } catch {
        if (!disposed) {
          setError(true);
          setLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [requestVersion]);

  return { data, loading, error, reload };
}
