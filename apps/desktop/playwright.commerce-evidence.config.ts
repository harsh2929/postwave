import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

/**
 * Reproducible, source-mode Commerce audit harness.
 *
 * This intentionally does not inherit the canonical optimized-build
 * webServer command. See vite.commerce-evidence.config.ts for the explicit
 * qualification boundary.
 */
export default defineConfig({
  ...baseConfig,
  outputDir: "test-results/commerce-final-evidence",
  reporter: "list",
  use: {
    ...baseConfig.use,
    baseURL: "http://127.0.0.1:1422",
  },
  webServer: {
    command: "pnpm exec vite --config vite.commerce-evidence.config.ts",
    url: "http://127.0.0.1:1422",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
