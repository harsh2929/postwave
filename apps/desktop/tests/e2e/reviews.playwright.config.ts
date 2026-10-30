import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceMode = process.env["POSTWAVE_REVIEWS_E2E_SOURCE"] === "1";
const port = sourceMode ? 1422 : 1421;

export default defineConfig({
  testDir: ".",
  testMatch: "reviews-maturity.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1_440, height: 1_000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    deviceScaleFactor: 1,
    colorScheme: "no-preference",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: fileURLToPath(
    new URL("../../test-results/reviews-e2e", import.meta.url),
  ),
  webServer: {
    command: sourceMode
      ? `pnpm exec vite --port ${port} --strictPort`
      : `pnpm build && pnpm exec vite preview --port ${port} --strictPort`,
    cwd: desktopRoot,
    url: `http://localhost:${port}`,
    reuseExistingServer:
      !sourceMode && process.env["POSTWAVE_VISUAL_REUSE_SERVER"] === "1",
    timeout: 240_000,
  },
});
