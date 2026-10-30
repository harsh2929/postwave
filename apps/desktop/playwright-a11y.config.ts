import { defineConfig } from "@playwright/test";

import desktopConfig from "./playwright.config";

export default defineConfig({
  ...desktopConfig,
  testDir: "./tests/accessibility",
  outputDir: "test-results/accessibility",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...desktopConfig.use,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Exercise the same optimized lazy chunks that ship in the Tauri bundle.
  // The dev server's source-module graph is useful for visual authoring, but
  // it can report a generic dynamic-import failure while a large route graph
  // is still being transformed. A production build + preview is deterministic
  // and makes this gate cover renderer build integrity as well as WCAG rules.
  webServer: {
    command: "pnpm build && pnpm exec vite preview --port 1421 --strictPort",
    url: "http://localhost:1421",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
