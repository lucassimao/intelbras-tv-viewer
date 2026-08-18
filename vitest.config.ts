import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/runtime/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./artifacts/coverage",
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 50,
        statements: 60,
      },
      // The browser/media lifecycle portions of these hooks are covered by
      // runtime smoke tests; keep their pure parsing and retry helpers covered
      // by Vitest without making jsdom pretend to be a TV media stack.
      exclude: [
        "src/main.tsx",
        "src/assets/**",
        "src/**/*.css",
        "src/i18n/locales/**",
        "src/hooks/useHlsPlayer.ts",
        "src/hooks/useGlanceSnapshots.ts",
      ],
    },
  },
});
