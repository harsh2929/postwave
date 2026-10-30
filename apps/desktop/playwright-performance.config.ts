import { defineConfig } from "@playwright/test";

import desktopConfig from "./playwright.config";

/**
 * Deterministic renderer performance gate against the optimized Vite output.
 * Native package qualification is a separate, artifact-bound evidence gate;
 * see scripts/verify-installed-performance.mjs.
 */
export default defineConfig({
  ...desktopConfig,
  testDir: "./tests/performance",
  outputDir: "test-results/performance",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...desktopConfig.use,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm exec vite preview --port 1421 --strictPort",
    url: "http://localhost:1421",
    // Local audit sessions may serve an isolated direct-Vite build while a
    // separate full typecheck owns the canonical dist directory. CI and the
    // default command remain fail-closed and always build their own server.
    reuseExistingServer: process.env.POSTWAVE_PERF_REUSE_SERVER === "1",
    timeout: 120_000,
  },
});
