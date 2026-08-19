import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../server/app.ts";
import type { CameraNamesRepository } from "../server/camera-names-repository.ts";
import type { ReliabilityService, ReliabilitySnapshot } from "../server/reliability-service.ts";
import type { SnapshotService, SnapshotStatusEntry } from "../server/snapshot-service.ts";

const FIXTURE_CAMERA_ID = "fixture-camera";

function dependencies(): AppDependencies {
  const names: CameraNamesRepository = {
    getAll: vi.fn(() => ({ [FIXTURE_CAMERA_ID]: "Entrada" })),
    remove: vi.fn(),
    upsert: vi.fn(),
    close: vi.fn(),
  };
  const snapshots: SnapshotService = {
    acquireLease: vi.fn(async () => undefined),
    releaseLease: vi.fn(),
    isLeaseActive: vi.fn(() => false),
    statuses: vi.fn((): SnapshotStatusEntry[] => [
      {
        cameraId: FIXTURE_CAMERA_ID,
        status: "waiting",
        capturedAt: null,
        ageMs: null,
        revision: 0,
      },
    ]),
    get: vi.fn(() => null),
    getError: vi.fn(() => null),
    stop: vi.fn(),
  };
  const reliability: ReliabilityService = {
    refresh: vi.fn(async () => undefined),
    snapshot: vi.fn((): ReliabilitySnapshot => ({
      generatedAt: new Date(0).toISOString(),
      stale: true,
      source: {
        api: "MediaMTX Control API v3",
        metrics: "MediaMTX Prometheus /metrics",
        version: "1.20.1",
      },
      cameras: [],
      limitations: { lastFrameAge: "N/A", packetLoss: "N/A", startup: "N/A" },
    })),
    recordStartup: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    cameraIds: new Set([FIXTURE_CAMERA_ID]),
    names,
    snapshots,
    reliability,
    getPtzController: vi.fn(),
  };
}

describe("Hono camera API contract", () => {
  it("serves health and camera names through app.request", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const health = await app.request("http://localhost/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const names = await app.request("http://localhost/api/cameras/names");
    expect(names.status).toBe(200);
    await expect(names.json()).resolves.toEqual({ names: { [FIXTURE_CAMERA_ID]: "Entrada" } });
  });

  it("keeps validation and status codes for name writes", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const unknown = await app.request("http://localhost/api/cameras/unknown/name", {
      method: "PUT",
      body: JSON.stringify({ name: "Unknown" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(unknown.status).toBe(404);

    const malformed = await app.request(`http://localhost/api/cameras/${FIXTURE_CAMERA_ID}/name`, {
      method: "PUT",
      body: "{",
      headers: { "Content-Type": "application/json" },
    });
    expect(malformed.status).toBe(400);

    const update = await app.request(`http://localhost/api/cameras/${FIXTURE_CAMERA_ID}/name`, {
      method: "PUT",
      body: JSON.stringify({ name: "  Portão  " }),
      headers: { "Content-Type": "application/json" },
    });
    expect(update.status).toBe(200);
    expect(deps.names.upsert).toHaveBeenCalledWith(FIXTURE_CAMERA_ID, "Portão", expect.any(String));
  });

  it("accepts snapshot leases and startup measurements without network access", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const lease = await app.request("http://localhost/api/snapshots/lease", {
      method: "POST",
      body: JSON.stringify({ priorityCameraIds: [FIXTURE_CAMERA_ID, "unknown"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(lease.status).toBe(202);
    expect(deps.snapshots.acquireLease).toHaveBeenCalledWith([FIXTURE_CAMERA_ID]);
    expect(deps.snapshots.statuses).toHaveBeenCalledTimes(1);

    const startup = await app.request("http://localhost/api/reliability/startup", {
      method: "POST",
      body: JSON.stringify({ cameraId: FIXTURE_CAMERA_ID, profileId: "sub", startupMs: 250 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(startup.status).toBe(202);
  });

  it("returns the legacy storage response for bodies over the hard limit", async () => {
    const app = createApp(dependencies());
    const response = await app.request("http://localhost/api/reliability/startup", {
      method: "POST",
      body:
        JSON.stringify({ cameraId: FIXTURE_CAMERA_ID, profileId: "sub", startupMs: 250 }) +
        "x".repeat(16_384),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({ error: "storage_unavailable" });
  });

  it("uses Hono's decoded path parameter exactly once", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    const response = await app.request("http://localhost/api/cameras/fixture-%63amera/name", {
      method: "PUT",
      body: JSON.stringify({ name: "Entrada" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(deps.names.upsert).toHaveBeenCalledWith(
      FIXTURE_CAMERA_ID,
      "Entrada",
      expect.any(String),
    );
  });

  it.each(["POST", "PATCH", "HEAD", "OPTIONS"])(
    "returns 405 and Allow for %s on camera name route",
    async (method) => {
      const response = await createApp(dependencies()).request(
        `http://localhost/api/cameras/${FIXTURE_CAMERA_ID}/name`,
        { method },
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("PUT, DELETE");
      if (method !== "HEAD") {
        await expect(response.json()).resolves.toEqual({ error: "method_not_allowed" });
      }
    },
  );
});
