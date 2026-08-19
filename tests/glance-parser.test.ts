import { describe, expect, it } from "vitest";
import { parseSnapshotResponse, parseSnapshotStatus } from "../src/hooks/useGlanceSnapshots";

describe("glance snapshot response validation", () => {
  it("accepts bounded status values and rejects malformed payloads", () => {
    expect(
      parseSnapshotStatus({
        cameraId: "cam-114",
        status: "ready",
        capturedAt: "2026-08-18T12:00:00.000Z",
        ageMs: 500,
        revision: 4,
      }),
    ).toMatchObject({ cameraId: "cam-114", status: "ready", revision: 4 });
    expect(
      parseSnapshotStatus({
        cameraId: "cam-future",
        status: "locked",
        capturedAt: null,
        ageMs: null,
        revision: 0,
      }),
    ).toEqual(expect.objectContaining({ status: "locked" }));
    expect(parseSnapshotStatus({ cameraId: "cam-114", status: "ready", revision: -1 })).toBeNull();
    expect(parseSnapshotStatus({ cameraId: "cam-114", status: "unknown", revision: 0 })).toBeNull();
  });

  it("requires every returned status to be valid", () => {
    expect(
      parseSnapshotResponse({
        active: true,
        statuses: [
          { cameraId: "cam-future", status: "locked", capturedAt: null, ageMs: null, revision: 0 },
        ],
      }),
    ).toMatchObject({ active: true, statuses: [{ status: "locked" }] });
    expect(parseSnapshotResponse({ active: true, statuses: [{ cameraId: "cam-114" }] })).toBeNull();
    expect(parseSnapshotResponse({ statuses: "not-an-array" })).toBeNull();
  });

  it("accepts a truthful capture error state", () => {
    expect(
      parseSnapshotStatus({
        cameraId: "cam-114",
        status: "error",
        capturedAt: null,
        ageMs: null,
        revision: 0,
      }),
    ).toMatchObject({ status: "error", revision: 0 });
  });
});
