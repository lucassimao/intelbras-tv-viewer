import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CAMERAS, STREAM_PROFILES } from "../src/config/cameras";
import {
  isProfileId,
  readStoredSelections,
  useStreamProfilePreferences,
} from "../src/hooks/useStreamProfilePreferences";

describe("stream profile preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("rejects malformed stored values and unknown profile IDs", () => {
    window.localStorage.setItem("intelbras-viewer-stream-profiles", "{malformed");
    expect(readStoredSelections()).toEqual({});
    expect(isProfileId("unknown")).toBe(false);
    expect(isProfileId(STREAM_PROFILES[0].id)).toBe(true);
  });

  it("persists a valid profile per camera and falls back for invalid choices", () => {
    const camera = CAMERAS.find((candidate) => candidate.enabled)!;
    const { result } = renderHook(() => useStreamProfilePreferences());
    expect(result.current.profileForCamera(camera)?.id).toBe(STREAM_PROFILES[0].id);

    act(() => result.current.selectProfile(camera, STREAM_PROFILES[1].id));
    expect(result.current.profileForCamera(camera)?.id).toBe(STREAM_PROFILES[1].id);
    expect(JSON.parse(window.localStorage.getItem("intelbras-viewer-stream-profiles")!)).toEqual({
      [camera.id]: STREAM_PROFILES[1].id,
    });

    window.localStorage.setItem(
      "intelbras-viewer-stream-profiles",
      JSON.stringify({ [camera.id]: "not-a-profile" }),
    );
    const reread = renderHook(() => useStreamProfilePreferences());
    expect(reread.result.current.profileForCamera(camera)?.id).toBe(STREAM_PROFILES[0].id);
  });
});
