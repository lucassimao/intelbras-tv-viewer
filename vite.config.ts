import { createRequire } from "node:module";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

type BuildEnv = Record<string, string | undefined>;

export function sourceMapUploadOptions(env: BuildEnv, command: string) {
  const apiKey = env.FARO_SOURCE_MAP_API_KEY?.trim();
  if (command !== "build" || !apiKey) return null;

  return {
    appName: env.FARO_SOURCE_MAP_APP_NAME?.trim() || "intelbras-tv-viewer",
    endpoint:
      env.FARO_SOURCEMAP_ENDPOINT?.trim() ||
      "https://faro-api-prod-sa-east-1.grafana.net/faro/api/v1",
    apiKey,
    appId: env.FARO_SOURCEMAP_APP_ID?.trim() || "1413",
    stackId: env.FARO_SOURCEMAP_STACK_ID?.trim() || "1798618",
    gzipContents: true,
    keepSourcemaps: false,
    verbose: env.FARO_SOURCE_MAP_VERBOSE?.trim().toLowerCase() === "true",
  };
}

// The plugin currently publishes a CommonJS main entry without an exports map;
// createRequire keeps the Vite config compatible with Node's ESM mode.
type FaroUploader = (options: NonNullable<ReturnType<typeof sourceMapUploadOptions>>) => Plugin;
const faroUploaderModule = createRequire(import.meta.url)("@grafana/faro-rollup-plugin") as
  | FaroUploader
  | { default: FaroUploader };
const createFaroUploader: FaroUploader =
  typeof faroUploaderModule === "function" ? faroUploaderModule : faroUploaderModule.default;

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Read source-map credentials in the Node-only Vite config. They are never
  // passed to define/import.meta.env and therefore cannot enter the browser.
  const env = loadEnv(mode, process.cwd(), "");
  const sourceMapOptions = sourceMapUploadOptions(env, command);

  return {
    plugins: [
      react(),
      legacy({
        // Some supported browsers are Chromium 38-era. Keep the legacy path
        // conservative while the modern bundle remains the default elsewhere.
        targets: ["chrome >= 38", "safari >= 8"],
        renderLegacyChunks: true,
        modernPolyfills: true,
      }),
      ...(sourceMapOptions ? [createFaroUploader(sourceMapOptions)] : []),
    ],
    server: {
      host: "0.0.0.0",
      port: 8080,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:8787",
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 8080,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:8787",
      },
    },
    build: {
      target: "es2018",
      // Keep source maps available for a private upload without adding a
      // sourceMappingURL to served JS. The uploader removes them after upload;
      // without a key, scripts/serve.mjs blocks them from the LAN.
      sourcemap: "hidden",
    },
  };
});
