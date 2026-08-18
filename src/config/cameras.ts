import rawStreamProfiles from "./stream-profiles.json" with { type: "json" };
import rawCameraInventory from "./camera-inventory.json" with { type: "json" };

export type StreamProfile = {
  id: string;
  subtype: number;
  pathSuffix: string;
  labelKey: string;
  descriptionKey: string;
};

export const STREAM_PROFILES = rawStreamProfiles as readonly StreamProfile[];
export type StreamProfileId = (typeof STREAM_PROFILES)[number]["id"];

export type Camera = {
  id: string;
  ip: string;
  streamPath: string;
  shortcut: string;
  model?: string;
  isDefault: boolean;
  availability: CameraAvailability;
  enabled: boolean;
  profileIds?: readonly StreamProfileId[];
  ptz?: PtzCapability;
};

export type PtzCapability = {
  directions: true;
};

export type CameraAvailability = "available" | "locked";

export type CameraInventoryEntry = {
  id: string;
  ip: string;
  streamPath: string;
  shortcut: string;
  model: string | null;
  isDefault: boolean;
  availability: CameraAvailability;
  ptz?: PtzCapability;
};

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CAMERA_ID_PATTERN = /^cam-[a-z0-9-]+$/;
const CAMERA_PATH_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function validateInventory(
  rawInventory: readonly CameraInventoryEntry[],
): readonly Camera[] {
  if (rawInventory.length !== 12)
    throw new Error("Camera inventory must contain exactly 12 cameras");
  const defaultCameras = rawInventory.filter((camera) => camera.isDefault === true);
  if (defaultCameras.length !== 1)
    throw new Error("Camera inventory must contain exactly one default camera");
  if (defaultCameras[0].availability !== "available")
    throw new Error("The default camera must be available");
  const ids = new Set<string>();
  const ips = new Set<string>();
  const paths = new Set<string>();
  const shortcuts = new Set<string>();

  const cameras = rawInventory.map((camera): Camera => {
    if (!CAMERA_ID_PATTERN.test(camera.id) || ids.has(camera.id))
      throw new Error(`Invalid or duplicate camera id: ${camera.id}`);
    if (
      !IPV4_PATTERN.test(camera.ip) ||
      camera.ip.split(".").some((octet) => Number(octet) > 255) ||
      ips.has(camera.ip)
    )
      throw new Error(`Invalid or duplicate camera IP: ${camera.ip}`);
    if (!CAMERA_PATH_PATTERN.test(camera.streamPath) || paths.has(camera.streamPath))
      throw new Error(`Invalid or duplicate camera path: ${camera.streamPath}`);
    if (!/^\d+$/.test(camera.shortcut) || shortcuts.has(camera.shortcut))
      throw new Error(`Invalid or duplicate camera shortcut: ${camera.shortcut}`);
    if (camera.availability !== "available" && camera.availability !== "locked")
      throw new Error(`Invalid availability for ${camera.id}`);
    ids.add(camera.id);
    ips.add(camera.ip);
    paths.add(camera.streamPath);
    shortcuts.add(camera.shortcut);
    return {
      id: camera.id,
      ip: camera.ip,
      streamPath: camera.streamPath,
      shortcut: camera.shortcut,
      ...(camera.model ? { model: camera.model } : {}),
      isDefault: camera.isDefault,
      availability: camera.availability,
      enabled: camera.availability === "available",
      ...(camera.ptz?.directions === true ? { ptz: { directions: true } as const } : {}),
    };
  });

  return cameras;
}

export const CAMERAS: readonly Camera[] = validateInventory(
  rawCameraInventory as readonly CameraInventoryEntry[],
);

export function resolveDefaultCamera(cameras: readonly Camera[]): Camera {
  const defaults = cameras.filter((camera) => camera.isDefault === true);
  if (defaults.length !== 1) {
    throw new Error("Camera inventory must contain exactly one default camera");
  }
  const [defaultCamera] = defaults;
  if (!defaultCamera.enabled || defaultCamera.availability !== "available") {
    throw new Error("The default camera must be available");
  }
  return defaultCamera;
}

export const DEFAULT_CAMERA = resolveDefaultCamera(CAMERAS);

export function streamProfilesForCamera(camera: Camera): readonly StreamProfile[] {
  if (!camera.profileIds) return STREAM_PROFILES;

  const configured = new Set(camera.profileIds);
  return STREAM_PROFILES.filter((profile) => configured.has(profile.id));
}

export function streamPathForProfile(camera: Camera, profile: StreamProfile): string {
  return `${camera.streamPath}${profile.pathSuffix}`;
}
