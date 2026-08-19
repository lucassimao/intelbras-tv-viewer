import { describe, expect, it, vi } from "vitest";
import {
  APP_IMAGE,
  RELAY_CONFIG_IMAGE,
  buildCommands,
  requiredImages,
  upCommand,
} from "../scripts/container-commands.mjs";
import { main as buildMain } from "../scripts/containers-build.mjs";
import { main as upMain } from "../scripts/containers-up.mjs";

describe("container lifecycle scripts", () => {
  it("requires the private Faro source-map key before invoking Docker", async () => {
    const run = vi.fn();

    await expect(buildMain({ env: {}, run })).rejects.toThrow(
      "FARO_SOURCE_MAP_API_KEY is required",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("builds app and relay-config sequentially with a non-secret cache nonce", () => {
    expect(buildCommands("20260819-abc")).toEqual([
      ["docker", ["compose", "build", "--build-arg", "FARO_UPLOAD_NONCE=20260819-abc", "app"]],
      [
        "docker",
        ["compose", "build", "--build-arg", "FARO_UPLOAD_NONCE=20260819-abc", "relay-config"],
      ],
    ]);
  });

  it("checks both local images and starts Compose without build or pull", async () => {
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args]);
      return 0;
    });

    await expect(upMain({ env: {}, run })).resolves.toBe(0);
    expect(calls).toEqual([
      ["docker", ["info"]],
      ["docker", ["image", "inspect", APP_IMAGE]],
      ["docker", ["image", "inspect", RELAY_CONFIG_IMAGE]],
      ["docker", ["compose", "up", "-d", "--no-build", "--pull", "never"]],
    ]);
    expect(upCommand()).toContain("--no-build");
    expect(requiredImages()).toEqual([APP_IMAGE, RELAY_CONFIG_IMAGE]);
  });

  it("stops before Compose when a required local image is missing", async () => {
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args]);
      return args.at(-1) === APP_IMAGE ? 1 : 0;
    });

    await expect(upMain({ env: {}, run })).rejects.toThrow(`Missing local image ${APP_IMAGE}`);
    expect(calls).toHaveLength(2);
  });
});
