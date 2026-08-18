import { createHash, randomBytes } from "node:crypto";
import type { Camera, PtzCapability } from "../src/config/cameras.ts";

export const PTZ_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type PtzDirection = (typeof PTZ_DIRECTIONS)[number];
export const PTZ_ACTIONS = ["start", "stop"] as const;
export type PtzAction = (typeof PTZ_ACTIONS)[number];

const PTZ_CODES: Record<PtzDirection, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

export const PTZ_MAX_MOVEMENT_MS = 750;
export const PTZ_COMMAND_TIMEOUT_MS = 2_000;
export const PTZ_MIN_COMMAND_INTERVAL_MS = 150;

export type PtzTransport = (request: {
  camera: Camera;
  action: PtzAction;
  direction: PtzDirection;
}) => Promise<void>;

export type PtzResult =
  | { ok: true; action: PtzAction; direction?: PtzDirection }
  | { ok: false; error: "camera_not_ptz" | "already_moving" | "rate_limited" | "transport_failed" };

type ActiveMovement = {
  direction: PtzDirection;
  timer?: ReturnType<typeof setTimeout>;
};

export function hasDirectionalPtz(camera: Camera): camera is Camera & { ptz: PtzCapability } {
  return camera.enabled && camera.ptz?.directions === true;
}

export function ptzUrl(camera: Camera, action: PtzAction, direction: PtzDirection) {
  const query = new URLSearchParams({
    action,
    // Intelbras/Dahua PTZ CGI channels are one-based, unlike RTSP channel names.
    channel: "1",
    code: PTZ_CODES[direction],
    arg1: "0",
    arg2: "1",
    arg3: "0",
  });
  return `http://${camera.ip}/cgi-bin/ptz.cgi?${query.toString()}`;
}

function md5(value: string) {
  return createHash("md5").update(value).digest("hex");
}

type DigestChallenge = {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
};

function digestChallenge(header: string | null): DigestChallenge | null {
  if (!header?.startsWith("Digest ")) return null;
  const values: Record<string, string> = {};
  for (const match of header.slice("Digest ".length).matchAll(/([a-z]+)=(?:"([^"]*)"|([^,]+))/gi)) {
    values[match[1].toLowerCase()] = (match[2] ?? match[3]).trim();
  }
  if (!values.realm || !values.nonce) return null;
  return {
    realm: values.realm,
    nonce: values.nonce,
    ...(values.qop ? { qop: values.qop.split(",")[0].trim() } : {}),
    ...(values.opaque ? { opaque: values.opaque } : {}),
  };
}

export function createDigestPtzTransport(credentials: {
  username: string;
  password: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}): PtzTransport {
  const fetcher = credentials.fetcher ?? fetch;
  return async ({ camera, action, direction }) => {
    const url = ptzUrl(camera, action, direction);
    const first = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(PTZ_COMMAND_TIMEOUT_MS),
    });
    if (first.ok) return;
    if (first.status !== 401) throw new Error(`ptz_http_${first.status}`);

    const challenge = digestChallenge(first.headers.get("www-authenticate"));
    if (!challenge) throw new Error("ptz_digest_challenge_missing");
    const uri = new URL(url).pathname + new URL(url).search;
    const method = "GET";
    const ha1 = md5(`${credentials.username}:${challenge.realm}:${credentials.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const cnonce = randomBytes(12).toString("hex");
    const nonceCount = "00000001";
    const response = challenge.qop
      ? md5(`${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${challenge.qop}:${ha2}`)
      : md5(`${ha1}:${challenge.nonce}:${ha2}`);
    const authorization = [
      `Digest username="${credentials.username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
      ...(challenge.opaque ? [`opaque="${challenge.opaque}"`] : []),
      ...(challenge.qop ? [`qop=${challenge.qop}`, `nc=${nonceCount}`, `cnonce="${cnonce}"`] : []),
    ].join(", ");
    const authenticated = await fetcher(url, {
      method,
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(PTZ_COMMAND_TIMEOUT_MS),
    });
    if (!authenticated.ok) throw new Error(`ptz_http_${authenticated.status}`);
    const body = (await authenticated.text()).trim().toUpperCase();
    if (body.startsWith("ERROR") || body.includes("BAD REQUEST"))
      throw new Error("ptz_command_rejected");
  };
}

export class PtzController {
  private readonly active = new Map<string, ActiveMovement>();
  private readonly lastCommandAt = new Map<string, number>();
  private readonly cameras: readonly Camera[];
  private readonly transport: PtzTransport;
  private readonly now: () => number;

  public constructor(
    cameras: readonly Camera[],
    transport: PtzTransport,
    now: () => number = Date.now,
  ) {
    this.cameras = cameras;
    this.transport = transport;
    this.now = now;
  }

  public async command(
    cameraId: string,
    action: PtzAction,
    direction?: PtzDirection,
  ): Promise<PtzResult> {
    const camera = this.cameras.find((candidate) => candidate.id === cameraId);
    if (!camera || !hasDirectionalPtz(camera)) return { ok: false, error: "camera_not_ptz" };
    if (action === "stop")
      return this.stop(camera, direction ?? this.active.get(cameraId)?.direction ?? "up");
    if (!direction || this.active.has(cameraId)) return { ok: false, error: "already_moving" };

    const last = this.lastCommandAt.get(cameraId) ?? 0;
    if (this.now() - last < PTZ_MIN_COMMAND_INTERVAL_MS)
      return { ok: false, error: "rate_limited" };
    this.lastCommandAt.set(cameraId, this.now());
    const movement: ActiveMovement = { direction };
    this.active.set(cameraId, movement);
    try {
      await this.transport({ camera, action: "start", direction });
    } catch {
      if (this.active.get(cameraId) === movement) this.active.delete(cameraId);
      return { ok: false, error: "transport_failed" };
    }
    if (this.active.get(cameraId) !== movement) {
      // A release can arrive while the start request is in flight. The stop
      // path already ran, so send one final idempotent stop after start.
      try {
        await this.transport({ camera, action: "stop", direction });
      } catch {
        return { ok: false, error: "transport_failed" };
      }
      return { ok: true, action: "start", direction };
    }
    movement.timer = setTimeout(() => {
      void this.stop(camera, direction);
    }, PTZ_MAX_MOVEMENT_MS);
    return { ok: true, action: "start", direction };
  }

  private async stop(camera: Camera, direction: PtzDirection): Promise<PtzResult> {
    const movement = this.active.get(camera.id);
    if (movement) {
      if (movement.timer) clearTimeout(movement.timer);
      this.active.delete(camera.id);
    }
    try {
      await this.transport({ camera, action: "stop", direction });
    } catch {
      return { ok: false, error: "transport_failed" };
    }
    return { ok: true, action: "stop", direction };
  }

  public async stopAll() {
    await Promise.all(
      [...this.active.entries()].map(([cameraId, movement]) =>
        this.command(cameraId, "stop", movement.direction),
      ),
    );
  }
}
