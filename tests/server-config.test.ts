import { describe, expect, it } from "vitest";
import { loadCameraCredentials, loadServerConfig } from "../server/config.ts";

describe("camera environment credentials", () => {
  it("loads the password directly from CAMERA_PASSWORD", () => {
    expect(
      loadCameraCredentials({ CAMERA_PASSWORD: "test-password", CAMERA_USERNAME: "admin" }),
    ).toEqual({
      username: "admin",
      password: "test-password",
    });
  });

  it("fails clearly when CAMERA_PASSWORD is absent without exposing a secret", () => {
    const env = { CAMERA_USERNAME: "admin" };

    const result = (() => {
      try {
        loadCameraCredentials(env);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      "CAMERA_PASSWORD and a valid CAMERA_USERNAME are required",
    );
    expect((result as Error).message).not.toContain("password=");
  });
});

describe("container service configuration", () => {
  it("accepts the pinned MediaMTX Docker service for snapshots", () => {
    expect(
      loadServerConfig({
        SNAPSHOT_RTSP_ORIGIN: "rtsp://mediamtx:8554",
        MEDIAMTX_API_URL: "http://mediamtx:9997",
        MEDIAMTX_METRICS_URL: "http://mediamtx:9998/metrics",
      }),
    ).toMatchObject({
      snapshotRtspOrigin: "rtsp://mediamtx:8554",
      mediamtxApiUrl: "http://mediamtx:9997",
      mediamtxMetricsUrl: "http://mediamtx:9998/metrics",
    });
  });
});
