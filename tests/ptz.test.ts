import { afterEach, describe, expect, it, vi } from "vitest";
import { CAMERAS } from "../src/config/cameras";
import {
  createDigestPtzTransport,
  hasDirectionalPtz,
  ptzUrl,
  PtzController,
  PTZ_MAX_MOVEMENT_MS,
} from "../server/ptz";

const ptzCamera = CAMERAS.find((camera) => camera.id === "cam-122")!;
const regularCamera = CAMERAS.find((camera) => camera.id === "cam-114")!;

afterEach(() => {
  vi.useRealTimers();
});

describe("PTZ capability and command safety", () => {
  it("gates controls to the confirmed directional camera", () => {
    expect(hasDirectionalPtz(ptzCamera)).toBe(true);
    expect(hasDirectionalPtz(regularCamera)).toBe(false);
    expect(ptzUrl(ptzCamera, "start", "left")).toBe(
      "http://192.168.0.122/cgi-bin/ptz.cgi?action=start&channel=1&code=Left&arg1=0&arg2=1&arg3=0",
    );
    expect(ptzUrl(ptzCamera, "start", "left")).not.toContain("@");
  });

  it("rejects non-PTZ cameras and invalid directions before transport", async () => {
    const transport = vi.fn();
    const controller = new PtzController(CAMERAS, transport);
    expect(await controller.command(regularCamera.id, "start", "left")).toEqual({
      ok: false,
      error: "camera_not_ptz",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(await controller.command(ptzCamera.id, "start", undefined)).toEqual({
      ok: false,
      error: "already_moving",
    });
  });

  it("sends only allowlisted start and stop commands", async () => {
    const calls: string[] = [];
    const transport = vi.fn(
      async ({ action, direction }: { action: string; direction: string }) => {
        calls.push(`${action}:${direction}`);
      },
    );
    const controller = new PtzController([ptzCamera], transport, () => 1_000);
    expect(await controller.command(ptzCamera.id, "start", "up")).toEqual({
      ok: true,
      action: "start",
      direction: "up",
    });
    expect(await controller.command(ptzCamera.id, "start", "right")).toEqual({
      ok: false,
      error: "already_moving",
    });
    expect(await controller.command(ptzCamera.id, "stop", "up")).toEqual({
      ok: true,
      action: "stop",
      direction: "up",
    });
    expect(calls).toEqual(["start:up", "stop:up"]);
  });

  it("rate-limits a new movement after a stop", async () => {
    let now = 2_000;
    const transport = vi.fn(async () => undefined);
    const controller = new PtzController([ptzCamera], transport, () => now);
    await controller.command(ptzCamera.id, "start", "left");
    await controller.command(ptzCamera.id, "stop", "left");
    expect(await controller.command(ptzCamera.id, "start", "right")).toEqual({
      ok: false,
      error: "rate_limited",
    });
    now += 200;
    expect((await controller.command(ptzCamera.id, "start", "right")).ok).toBe(true);
  });

  it("automatically stops a movement at the bounded timeout", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transport = vi.fn(
      async ({ action, direction }: { action: string; direction: string }) => {
        calls.push(`${action}:${direction}`);
      },
    );
    const controller = new PtzController([ptzCamera], transport, () => 3_000);
    await controller.command(ptzCamera.id, "start", "down");
    await vi.advanceTimersByTimeAsync(PTZ_MAX_MOVEMENT_MS);
    expect(calls).toEqual(["start:down", "stop:down"]);
  });

  it("stops after transport failure and keeps stop idempotent", async () => {
    let first = true;
    const transport = vi.fn(async ({ action }: { action: string }) => {
      if (action === "start" && first) {
        first = false;
        throw new Error("offline");
      }
    });
    const controller = new PtzController([ptzCamera], transport, () => 4_000);
    expect(await controller.command(ptzCamera.id, "start", "right")).toEqual({
      ok: false,
      error: "transport_failed",
    });
    expect((await controller.command(ptzCamera.id, "stop", "right")).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("digest PTZ transport", () => {
  it("keeps the password out of request URLs and authorization headers", async () => {
    const password = "a-secret-that-must-not-leak";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        return new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Digest realm="camera", nonce="nonce", qop="auth"' },
        });
      }
      return new Response("OK", { status: 200 });
    });
    const transport = createDigestPtzTransport({ username: "admin", password, fetcher });
    await transport({ camera: ptzCamera, action: "stop", direction: "up" });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => !url.includes(password))).toBe(true);
    expect(String(requests[1].init?.headers)).not.toContain(password);
  });
});
