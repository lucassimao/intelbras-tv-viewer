import { useEffect, useState } from "react";

export type SnapshotStatus = "waiting" | "capturing" | "ready" | "stale" | "offline" | "locked";

export type SnapshotCameraStatus = {
  cameraId: string;
  status: SnapshotStatus;
  capturedAt: string | null;
  ageMs: number | null;
  revision: number;
};

type SnapshotResult = {
  active: boolean;
  statuses: SnapshotCameraStatus[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSnapshotStatus(value: unknown): SnapshotCameraStatus | null {
  if (!isRecord(value) || typeof value.cameraId !== "string" || typeof value.status !== "string")
    return null;
  const statuses: SnapshotStatus[] = [
    "waiting",
    "capturing",
    "ready",
    "stale",
    "offline",
    "locked",
  ];
  if (!statuses.includes(value.status as SnapshotStatus)) return null;
  if (value.capturedAt !== null && typeof value.capturedAt !== "string") return null;
  if (
    value.ageMs !== null &&
    (typeof value.ageMs !== "number" || !Number.isFinite(value.ageMs) || value.ageMs < 0)
  )
    return null;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    return null;
  return {
    cameraId: value.cameraId,
    status: value.status as SnapshotStatus,
    capturedAt: value.capturedAt as string | null,
    ageMs: value.ageMs as number | null,
    revision: value.revision,
  };
}

export function parseSnapshotResponse(value: unknown): SnapshotResult | null {
  if (!isRecord(value) || !Array.isArray(value.statuses)) return null;
  const statuses = value.statuses
    .map(parseSnapshotStatus)
    .filter((status): status is SnapshotCameraStatus => status !== null);
  if (statuses.length !== value.statuses.length) return null;
  return { active: value.active === true, statuses };
}

export function useGlanceSnapshots(active: boolean) {
  const [result, setResult] = useState<SnapshotResult>({ active: false, statuses: [] });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    const load = async (lease: boolean) => {
      try {
        const response = await fetch(lease ? "/api/snapshots/lease" : "/api/snapshots/status", {
          method: lease ? "POST" : "GET",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("snapshot_service_unavailable");
        const parsed = parseSnapshotResponse((await response.json()) as unknown);
        if (!parsed) throw new Error("snapshot_service_invalid");
        if (!disposed) {
          setResult(parsed);
          setUnavailable(false);
        }
      } catch {
        if (!disposed) setUnavailable(true);
      }
    };

    void load(true);
    const statusTimer = window.setInterval(() => void load(false), 3_000);
    const leaseTimer = window.setInterval(() => void load(true), 10_000);
    return () => {
      disposed = true;
      window.clearInterval(statusTimer);
      window.clearInterval(leaseTimer);
      void fetch("/api/snapshots/lease", { method: "DELETE", keepalive: true }).catch(() => {
        // Cleanup is best effort; the server also expires inactive leases.
      });
    };
  }, [active]);

  return { ...result, unavailable };
}
