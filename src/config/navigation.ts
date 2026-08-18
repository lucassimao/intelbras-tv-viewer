import type { Camera } from "./cameras";

export const CAMERA_CATALOG_PAGE_SIZE = 6;

export function availableCameras(cameras: readonly Camera[]) {
  return cameras.filter((camera) => camera.enabled);
}

export function cycleCamera(
  cameras: readonly Camera[],
  currentId: string,
  direction: -1 | 1,
): Camera | undefined {
  const enabled = availableCameras(cameras);
  if (enabled.length === 0) return undefined;
  const currentIndex = enabled.findIndex((camera) => camera.id === currentId);
  const index = currentIndex < 0 ? 0 : (currentIndex + direction + enabled.length) % enabled.length;
  return enabled[index];
}

export function catalogPageForCamera(
  cameras: readonly Camera[],
  cameraId: string,
  pageSize = CAMERA_CATALOG_PAGE_SIZE,
) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be positive");
  const index = cameras.findIndex((camera) => camera.id === cameraId);
  return index < 0 ? 0 : Math.floor(index / pageSize);
}

export function catalogPageCount(cameras: readonly Camera[], pageSize = CAMERA_CATALOG_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be positive");
  return Math.max(1, Math.ceil(cameras.length / pageSize));
}

export function camerasOnCatalogPage(
  cameras: readonly Camera[],
  page: number,
  pageSize = CAMERA_CATALOG_PAGE_SIZE,
) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be positive");
  const count = catalogPageCount(cameras, pageSize);
  const safePage = Math.min(Math.max(0, page), count - 1);
  return cameras.slice(safePage * pageSize, (safePage + 1) * pageSize);
}
