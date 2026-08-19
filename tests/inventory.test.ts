import { readFile, rm, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CAMERAS,
  DEFAULT_CAMERA,
  STREAM_PROFILES,
  resolveDefaultCamera,
  streamPathForProfile,
  streamProfilesForCamera,
} from "../src/config/cameras";
import {
  CAMERA_CATALOG_PAGE_SIZE,
  catalogPageForCamera,
  camerasOnCatalogPage,
  cycleCamera,
} from "../src/config/navigation";

const execFileAsync = promisify(execFile);

describe("shared camera inventory", () => {
  it("keeps camera identity and relay path invariants", () => {
    expect(CAMERAS).toHaveLength(12);
    expect(CAMERAS.filter((camera) => camera.enabled)).toHaveLength(12);
    expect(CAMERAS.find((camera) => camera.id === "cam-116")).toMatchObject({
      availability: "available",
      enabled: true,
    });
    expect(CAMERAS.find((camera) => camera.id === "cam-122")).toMatchObject({
      model: "iM7-FC",
      ptz: { directions: true },
    });
    expect(new Set(CAMERAS.map((camera) => camera.id)).size).toBe(CAMERAS.length);
    expect(new Set(CAMERAS.map((camera) => camera.ip)).size).toBe(CAMERAS.length);
    expect(new Set(CAMERAS.map((camera) => camera.streamPath)).size).toBe(CAMERAS.length);
    expect(CAMERAS.every((camera) => /^[a-z0-9][a-z0-9_-]*$/.test(camera.streamPath))).toBe(true);
    expect(CAMERAS.filter((camera) => camera.enabled)).toHaveLength(
      CAMERAS.filter((camera) => camera.availability === "available").length,
    );
    expect(
      CAMERAS.filter((camera) => !camera.enabled).every(
        (camera) => camera.availability === "locked",
      ),
    ).toBe(true);
    expect(CAMERAS.filter((camera) => camera.isDefault)).toHaveLength(1);
    expect(DEFAULT_CAMERA).toMatchObject({
      id: "cam-124",
      ip: "192.168.0.124",
      enabled: true,
      availability: "available",
    });
    expect(streamPathForProfile(DEFAULT_CAMERA, STREAM_PROFILES[0])).toBe("cam-124");
  });

  it("rejects an invalid default instead of silently choosing another camera", () => {
    const camerasWithoutDefault = CAMERAS.map((camera) => ({ ...camera, isDefault: false }));
    expect(() => resolveDefaultCamera(camerasWithoutDefault)).toThrow("exactly one default camera");

    const camerasWithTwoDefaults = CAMERAS.map((camera) => ({
      ...camera,
      isDefault: camera.id === "cam-114" || camera.id === "cam-124",
    }));
    expect(() => resolveDefaultCamera(camerasWithTwoDefaults)).toThrow(
      "exactly one default camera",
    );

    const lockedDefault = CAMERAS.map((camera) =>
      camera.id === DEFAULT_CAMERA.id
        ? { ...camera, isDefault: true, enabled: false, availability: "locked" as const }
        : { ...camera, isDefault: false },
    );
    expect(() => resolveDefaultCamera(lockedDefault)).toThrow("must be available");
  });

  it("provides safe, known stream profiles for every camera", () => {
    expect(STREAM_PROFILES.length).toBeGreaterThanOrEqual(2);
    for (const camera of CAMERAS.filter((candidate) => candidate.enabled)) {
      const profiles = streamProfilesForCamera(camera);
      expect(profiles.length).toBeGreaterThan(0);
      for (const profile of profiles) {
        expect(streamPathForProfile(camera, profile)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
        expect(profile.subtype).toBeGreaterThanOrEqual(0);
      }
    }
    expect(streamProfilesForCamera(CAMERAS.find((camera) => camera.id === "cam-116")!)).toEqual(
      STREAM_PROFILES,
    );
  });

  it("generates both relay paths for every available camera", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intelbras-relay-test-"));
    const outputFile = join(directory, "mediamtx.yml");
    try {
      await execFileAsync(
        process.execPath,
        ["scripts/generate-mediamtx-config.mjs", "--output", outputFile],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CAMERA_PASSWORD: "test-password",
          },
        },
      );
      const generated = await readFile(outputFile, "utf8");
      const paths = [...generated.matchAll(/^  (cam-[^:]+):$/gm)].map((match) => match[1]);
      expect(paths).toHaveLength(24);
      expect(paths).toContain("cam-116");
      expect(paths).toContain("cam-116--main");
      expect(paths).toEqual(
        expect.arrayContaining(
          CAMERAS.flatMap((camera) =>
            STREAM_PROFILES.map((profile) => streamPathForProfile(camera, profile)),
          ),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("camera navigation and catalog paging", () => {
  const available = CAMERAS.filter((camera) => camera.enabled);

  it("cycles across available cameras and wraps in both directions", () => {
    expect(cycleCamera(CAMERAS, available[0].id, -1)?.id).toBe(available.at(-1)?.id);
    expect(cycleCamera(CAMERAS, available.at(-1)?.id ?? "", 1)?.id).toBe(available[0].id);
    const locked = { ...available[1], availability: "locked" as const, enabled: false };
    const inventoryWithLockedCamera = [available[0], locked, ...available.slice(2)];
    expect(cycleCamera(inventoryWithLockedCamera, available[0].id, 1)?.id).toBe(available[2].id);
    expect(cycleCamera(CAMERAS, available[0].id, 1)?.enabled).toBe(true);
  });

  it("keeps six-card pages synchronized with selected camera", () => {
    expect(catalogPageForCamera(CAMERAS, DEFAULT_CAMERA.id, CAMERA_CATALOG_PAGE_SIZE)).toBe(1);
    expect(catalogPageForCamera(CAMERAS, "cam-114", CAMERA_CATALOG_PAGE_SIZE)).toBe(0);
    expect(catalogPageForCamera(CAMERAS, "cam-121", CAMERA_CATALOG_PAGE_SIZE)).toBe(0);
    expect(catalogPageForCamera(CAMERAS, "missing", CAMERA_CATALOG_PAGE_SIZE)).toBe(0);
    expect(camerasOnCatalogPage(CAMERAS, 0)).toHaveLength(6);
    expect(camerasOnCatalogPage(CAMERAS, 1).map((camera) => camera.id)).toEqual([
      "cam-124",
      "cam-125",
      "cam-126",
      "cam-127",
      "cam-129",
      "cam-135",
    ]);
    expect(camerasOnCatalogPage(CAMERAS, 99).at(-1)?.id).toBe("cam-135");
  });
});
