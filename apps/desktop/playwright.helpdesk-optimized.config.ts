import { defineConfig, devices } from "@playwright/test";

process.env.POSTWAVE_HELPDESK_OPTIMIZED_DIST = "1";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "helpdesk-99p9.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/helpdesk-99p9-playwright",
  use: {
    baseURL: "http://localhost:1421",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "no-preference",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
