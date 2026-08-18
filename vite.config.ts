import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    legacy({
      // Some supported browsers are Chromium 38-era. Keep the legacy path
      // conservative while the modern bundle remains the default elsewhere.
      targets: ["chrome >= 38", "safari >= 8"],
      renderLegacyChunks: true,
      modernPolyfills: true,
    }),
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
  },
});
