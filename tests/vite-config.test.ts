import { describe, expect, it } from "vitest";
import { sourceMapUploadOptions } from "../vite.config";

describe("Vite Faro source-map upload configuration", () => {
  it("does not configure an uploader without the server-only API key", () => {
    expect(
      sourceMapUploadOptions(
        { VITE_FARO_URL: "https://collector.example.invalid/collect" },
        "build",
      ),
    ).toBeNull();
    expect(
      sourceMapUploadOptions({ FARO_SOURCE_MAP_API_KEY: "ignored-in-dev" }, "serve"),
    ).toBeNull();
  });

  it("configures private upload defaults only for keyed builds", () => {
    const options = sourceMapUploadOptions(
      { FARO_SOURCE_MAP_API_KEY: "server-only-token", FARO_SOURCE_MAP_VERBOSE: "false" },
      "build",
    );

    expect(options).toMatchObject({
      appName: "intelbras-tv-viewer",
      endpoint: "https://faro-api-prod-sa-east-1.grafana.net/faro/api/v1",
      appId: "1413",
      stackId: "1798618",
      gzipContents: true,
      keepSourcemaps: false,
      verbose: false,
    });
    expect(options?.apiKey).toBe("server-only-token");
  });
});
