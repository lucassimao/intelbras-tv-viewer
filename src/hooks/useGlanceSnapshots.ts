import { useEffect, useMemo, useState } from "react";

export type SnapshotStatus = "waiting" | "capturing" | "ready" | "stale" | "error" | "locked";

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
  const statuses: SnapshotStatus[] = ["waiting", "capturing", "ready", "stale", "error", "locked"];
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

export type GlanceSnapshotOptions = {
  priorityCameraIds?: readonly string[];
};

export function useGlanceSnapshots(active: boolean, options: GlanceSnapshotOptions = {}) {
  const [result, setResult] = useState<SnapshotResult>({ active: false, statuses: [] });
  const [unavailable, setUnavailable] = useState(false);
  const priorityCameraIds = useMemo(
    () => options.priorityCameraIds ?? [],
    [options.priorityCameraIds],
  );

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    const inFlight = new Set<AbortController>();
    const load = async (lease: boolean) => {
      if (disposed) return;
      const controller = new AbortController();
      inFlight.add(controller);
      try {
        const response = await fetch(lease ? "/api/snapshots/lease" : "/api/snapshots/status", {
          method: lease ? "POST" : "GET",
          ...(lease
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ priorityCameraIds }),
              }
            : {}),
          cache: "no-store",
          signal: controller.signal,
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
      } finally {
        inFlight.delete(controller);
      }
    };

    void load(true);
    const statusTimer = window.setInterval(() => void load(false), 3_000);
    const leaseTimer = window.setInterval(() => void load(true), 10_000);
    return () => {
      disposed = true;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      window.clearInterval(statusTimer);
      window.clearInterval(leaseTimer);
      void fetch("/api/snapshots/lease", { method: "DELETE", keepalive: true }).catch(() => {
        // Cleanup is best effort; the server also expires inactive leases.
      });
    };
  }, [active, priorityCameraIds]);

  return { ...result, unavailable };
}
