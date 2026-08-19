import { Hono } from "hono";
import { REQUEST_BODY_MAX_BYTES } from "./config.ts";
import { MAX_CAMERA_NAME_LENGTH, normalizeCameraName } from "./camera-names.ts";
import type { CameraNamesRepository } from "./camera-names-repository.ts";
import type { ReliabilityService } from "./reliability-service.ts";
import type { SnapshotService } from "./snapshot-service.ts";
import {
  PTZ_ACTIONS,
  PTZ_DIRECTIONS,
  type PtzAction,
  type PtzController,
  type PtzDirection,
} from "./ptz.ts";

export type AppDependencies = {
  cameraIds: ReadonlySet<string>;
  names: CameraNamesRepository;
  snapshots: SnapshotService;
  reliability: ReliabilityService;
  getPtzController: () => Promise<PtzController>;
};

type JsonObject = Record<string, unknown>;

class RequestBodyError extends Error {
  public readonly code: "request_too_large";

  public constructor(code: "request_too_large") {
    super(code);
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, payload: unknown, extraHeaders?: Record<string, string>) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      ...extraHeaders,
    },
  });
}

async function readBodyText(c: { req: { raw: Request } }) {
  const body = c.req.raw.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancelled = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (size + chunk.byteLength > REQUEST_BODY_MAX_BYTES) {
        cancelled = true;
        await reader.cancel("request_too_large").catch(() => undefined);
        throw new RequestBodyError("request_too_large");
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } catch (error) {
    if (!cancelled) {
      cancelled = true;
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readJson(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return JSON.parse(await readBodyText(c));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new SyntaxError("invalid_json");
  }
}

function isPtzAction(value: unknown): value is PtzAction {
  return typeof value === "string" && (PTZ_ACTIONS as readonly string[]).includes(value);
}

function isPtzDirection(value: unknown): value is PtzDirection {
  return typeof value === "string" && (PTZ_DIRECTIONS as readonly string[]).includes(value);
}

export function createApp(dependencies: AppDependencies) {
  const app = new Hono();

  app.get("/api/health", () => json(200, { ok: true }));

  app.post("/api/snapshots/lease", async (c) => {
    let priorityCameraIds: string[] = [];
    const statuses = dependencies.snapshots.statuses();
    const availableCameraIds = new Set(
      statuses.filter((status) => status.status !== "locked").map((status) => status.cameraId),
    );
    try {
      const rawBody = await readBodyText(c);
      if (rawBody.trim()) {
        const parsed = JSON.parse(rawBody);
        const requested = isObject(parsed) ? parsed.priorityCameraIds : undefined;
        priorityCameraIds = Array.isArray(requested)
          ? requested
              .filter(
                (cameraId): cameraId is string =>
                  typeof cameraId === "string" &&
                  dependencies.cameraIds.has(cameraId) &&
                  availableCameraIds.has(cameraId),
              )
              .slice(0, dependencies.cameraIds.size)
          : [];
      }
    } catch (error) {
      if (error instanceof RequestBodyError) return json(503, { error: "storage_unavailable" });
      priorityCameraIds = [];
    }
    await dependencies.snapshots.acquireLease(priorityCameraIds);
    return json(202, { active: true, statuses });
  });

  app.delete("/api/snapshots/lease", () => {
    dependencies.snapshots.releaseLease();
    return json(200, { active: false, statuses: dependencies.snapshots.statuses() });
  });

  app.get("/api/snapshots/status", () =>
    json(200, {
      active: dependencies.snapshots.isLeaseActive(),
      statuses: dependencies.snapshots.statuses(),
    }),
  );

  app.get("/api/snapshots/:cameraId", (c) => {
    const cameraId = c.req.param("cameraId");
    if (!cameraId) return json(400, { error: "invalid_camera_id" });
    const status = dependencies.snapshots.statuses().find((entry) => entry.cameraId === cameraId);
    if (!status) return json(404, { error: "camera_not_found" });
    if (status.status === "locked") return json(423, { error: "camera_locked" });
    const snapshot = dependencies.snapshots.get(cameraId);
    if (!snapshot) {
      return json(404, {
        error: dependencies.snapshots.getError(cameraId) ?? "snapshot_unavailable",
      });
    }
    const etag = `"${snapshot.revision.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-cache, max-age=0, must-revalidate" },
      });
    }
    return new Response(new Uint8Array(snapshot.image), {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, max-age=0, must-revalidate",
        "Content-Type": "image/jpeg",
        "Content-Length": String(snapshot.image.byteLength),
        ETag: etag,
        "X-Snapshot-Captured-At": snapshot.capturedAt,
      },
    });
  });

  app.get("/api/reliability", () => {
    void dependencies.reliability.refresh();
    return json(200, dependencies.reliability.snapshot());
  });

  app.post("/api/reliability/startup", async (c) => {
    let payload: unknown;
    try {
      payload = await readJson(c);
    } catch (error) {
      return error instanceof RequestBodyError
        ? json(503, { error: "storage_unavailable" })
        : json(400, { error: "invalid_json" });
    }
    const body = isObject(payload) ? payload : {};
    if (
      typeof body.cameraId !== "string" ||
      typeof body.profileId !== "string" ||
      typeof body.startupMs !== "number" ||
      !dependencies.reliability.recordStartup(body.cameraId, body.profileId, body.startupMs)
    ) {
      return json(400, { error: "invalid_startup_measurement" });
    }
    return json(202, { accepted: true });
  });

  app.post("/api/ptz", async (c) => {
    let payload: unknown;
    try {
      payload = await readJson(c);
    } catch (error) {
      return error instanceof RequestBodyError
        ? json(503, { error: "storage_unavailable" })
        : json(400, { error: "invalid_json" });
    }
    const body = isObject(payload) ? payload : {};
    if (
      typeof body.cameraId !== "string" ||
      !dependencies.cameraIds.has(body.cameraId) ||
      !isPtzAction(body.action) ||
      (body.direction !== undefined && !isPtzDirection(body.direction))
    ) {
      return json(400, { error: "invalid_ptz_command" });
    }
    try {
      const result = await (
        await dependencies.getPtzController()
      ).command(body.cameraId, body.action, body.direction);
      if (result.ok) return json(200, result);
      const status =
        result.error === "camera_not_ptz"
          ? 403
          : result.error === "already_moving"
            ? 409
            : result.error === "rate_limited"
              ? 429
              : 502;
      return json(status, result);
    } catch (error) {
      console.error("PTZ API failure", error);
      return json(503, { error: "storage_unavailable" });
    }
  });

  app.get("/api/cameras/names", () => {
    try {
      return json(200, { names: dependencies.names.getAll() });
    } catch (error) {
      console.error("Camera names API failure", error);
      return json(503, { error: "storage_unavailable" });
    }
  });

  app.on("DELETE", "/api/cameras/:cameraId/name", (c) => {
    const cameraId = c.req.param("cameraId");
    if (!cameraId || !dependencies.cameraIds.has(cameraId))
      return json(404, { error: "camera_not_found" });
    try {
      dependencies.names.remove(cameraId);
      return json(200, { cameraId, name: null });
    } catch (error) {
      console.error("Camera names API failure", error);
      return json(503, { error: "storage_unavailable" });
    }
  });

  app.put("/api/cameras/:cameraId/name", async (c) => {
    const cameraId = c.req.param("cameraId");
    if (!cameraId || !dependencies.cameraIds.has(cameraId))
      return json(404, { error: "camera_not_found" });
    let body: unknown;
    try {
      body = await readJson(c);
    } catch (error) {
      return error instanceof RequestBodyError
        ? json(503, { error: "storage_unavailable" })
        : json(400, { error: "invalid_json" });
    }
    if (!isObject(body) || !("name" in body)) return json(400, { error: "name_required" });
    try {
      if (body.name === null) {
        dependencies.names.remove(cameraId);
        return json(200, { cameraId, name: null });
      }
      const name = normalizeCameraName(body.name);
      if (!name) return json(400, { error: "invalid_name", maxLength: MAX_CAMERA_NAME_LENGTH });
      dependencies.names.upsert(cameraId, name, new Date().toISOString());
      return json(200, { cameraId, name });
    } catch (error) {
      console.error("Camera names API failure", error);
      return json(503, { error: "storage_unavailable" });
    }
  });

  app.all("/api/cameras/:cameraId/name", (c) => {
    const cameraId = c.req.param("cameraId");
    if (!cameraId || !dependencies.cameraIds.has(cameraId))
      return json(404, { error: "camera_not_found" });
    return json(405, { error: "method_not_allowed" }, { Allow: "PUT, DELETE" });
  });

  app.notFound(() => json(404, { error: "camera_not_found" }));
  app.onError((error) => {
    console.error("Camera API failure", error);
    return json(503, { error: "storage_unavailable" });
  });
  return app;
}
