import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CAMERA_NAME_LENGTH, normalizeCameraName } from "../server/camera-names.ts";

describe("camera name validation", () => {
  it("normalizes Unicode, trims whitespace, and rejects unsafe values", () => {
    expect(normalizeCameraName("  Portão  ")).toBe("Portão");
    const composed = normalizeCameraName("e\u0301");
    expect(composed).toBe("é");
    expect(normalizeCameraName("\u0000bad")).toBeNull();
    expect(normalizeCameraName(" ")).toBeNull();
    expect(normalizeCameraName("x".repeat(MAX_CAMERA_NAME_LENGTH + 1))).toBeNull();
    expect(normalizeCameraName({ name: "Gate" })).toBeNull();
  });
});

describe("camera names API", () => {
  let child: ChildProcess | undefined;
  let databaseDirectory: string;
  let baseUrl: string;

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), "intelbras-tv-viewer-test-"));
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CAMERA_API_HOST: "127.0.0.1",
        CAMERA_API_PORT: String(port),
        CAMERA_DB_PATH: join(databaseDirectory, "names.sqlite"),
        MEDIAMTX_API_URL: "http://127.0.0.1:1",
        MEDIAMTX_METRICS_URL: "http://127.0.0.1:1/metrics",
        SNAPSHOT_FFMPEG: join(process.cwd(), "tests/fixtures/fake-ffmpeg"),
      },
      stdio: "ignore",
    });
    await waitForHealth(baseUrl);
  }, 15_000);

  afterAll(async () => {
    if (child) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child?.once("close", () => resolve()));
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  it("supports normalized PUT, list, reset, and malformed input", async () => {
    const put = await fetch(`${baseUrl}/api/cameras/cam-114/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Garagem  " }),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({ cameraId: "cam-114", name: "Garagem" });

    const list = await fetch(`${baseUrl}/api/cameras/names`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ names: { "cam-114": "Garagem" } });

    const malformed = await fetch(`${baseUrl}/api/cameras/cam-114/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const reset = await fetch(`${baseUrl}/api/cameras/cam-114/name`, { method: "DELETE" });
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toMatchObject({ cameraId: "cam-114", name: null });
  });

  it("rejects unknown IDs and invalid names without writing state", async () => {
    const unknown = await fetch(`${baseUrl}/api/cameras/not-a-camera/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unknown" }),
    });
    expect(unknown.status).toBe(404);

    const invalid = await fetch(`${baseUrl}/api/cameras/cam-115/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "\u0000" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_name" });
  });

  it("keeps the unlocked .116 camera eligible for snapshots and stops its lease", async () => {
    const lease = await fetch(`${baseUrl}/api/snapshots/lease`, { method: "POST" });
    expect(lease.status).toBe(202);
    const leasedPayload = (await lease.json()) as {
      active: boolean;
      statuses: Array<{ cameraId: string; status: string }>;
    };
    expect(leasedPayload.active).toBe(true);
    const unlockedStatus = leasedPayload.statuses.find((status) => status.cameraId === "cam-116");
    expect(unlockedStatus).toBeDefined();
    expect(unlockedStatus?.status).not.toBe("locked");

    const snapshot = await fetch(`${baseUrl}/api/snapshots/cam-116`);
    expect(snapshot.status).not.toBe(423);

    const stopped = await fetch(`${baseUrl}/api/snapshots/lease`, { method: "DELETE" });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({ active: false });
  });

  it("forwards binary JPEG bytes and honors revision ETags", async () => {
    const lease = await fetch(`${baseUrl}/api/snapshots/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priorityCameraIds: ["cam-124", "cam-114"] }),
    });
    expect(lease.status).toBe(202);

    const first = await waitForSnapshot(baseUrl, "cam-124");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/jpeg");
    expect(first.headers.get("etag")).toBeTruthy();
    expect(new Uint8Array(await first.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([0xff, 0xd8]),
    );

    const etag = first.headers.get("etag");
    const notModified = await fetch(`${baseUrl}/api/snapshots/cam-124`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);

    await fetch(`${baseUrl}/api/snapshots/lease`, { method: "DELETE" });
  });
});

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The child can take a moment to load TypeScript and initialize SQLite.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Camera API did not become healthy");
}

async function waitForSnapshot(url: string, cameraId: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/snapshots/${cameraId}`);
    if (response.status === 200) return response;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Snapshot did not become ready: ${cameraId}`);
}
