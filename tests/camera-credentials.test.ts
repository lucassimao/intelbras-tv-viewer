import { afterEach, describe, expect, it } from "vitest";
import { loadCameraCredentials } from "../server/camera-credentials.ts";

const originalPassword = process.env.CAMERA_PASSWORD;
const originalUsername = process.env.CAMERA_USERNAME;

afterEach(() => {
  if (originalPassword === undefined) delete process.env.CAMERA_PASSWORD;
  else process.env.CAMERA_PASSWORD = originalPassword;
  if (originalUsername === undefined) delete process.env.CAMERA_USERNAME;
  else process.env.CAMERA_USERNAME = originalUsername;
});

describe("camera environment credentials", () => {
  it("loads the password directly from CAMERA_PASSWORD", async () => {
    process.env.CAMERA_PASSWORD = "test-password";
    process.env.CAMERA_USERNAME = "admin";

    await expect(loadCameraCredentials()).resolves.toEqual({
      username: "admin",
      password: "test-password",
    });
  });

  it("fails clearly when CAMERA_PASSWORD is absent without exposing a secret", async () => {
    delete process.env.CAMERA_PASSWORD;

    const result = await loadCameraCredentials().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      "CAMERA_PASSWORD and a valid CAMERA_USERNAME are required",
    );
    expect((result as Error).message).not.toContain("password=");
  });
});
