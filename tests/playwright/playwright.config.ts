import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Moosewave web app.
 *
 * Tests target the docker-compose stack on http://localhost:3000 by default.
 * Override with POSTWAVE_E2E_URL when pointing at a remote preview environment.
 *
 * The stack must be started with:
 *   - POSTWAVE_LOCAL_AUTH_BYPASS=1
 *   - POSTWAVE_DEV_TENANT_SLUG_HEADER=1
 * so the helpers in helpers/auth.ts can authenticate as the demo tenant without
 * walking through the real login flow.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["github"],
        ["list"],
      ]
    : "list",
  outputDir: "test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.POSTWAVE_E2E_URL ?? "http://localhost:3000",
    // Deterministic route fixtures must see every request. A previously
    // installed production worker can otherwise claim API traffic before
    // Playwright's page/context routes and leak live tenant state into tests.
    // A future PWA-specific spec can opt back in locally.
    serviceWorkers: "block",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    extraHTTPHeaders: process.env.POSTWAVE_DEV_TENANT_SLUG_HEADER
      ? { "X-Tenant-Slug": "demo" }
      : undefined,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "chromium-tablet",
      use: { ...devices["Galaxy Tab S4"] },
    },
    {
      name: "firefox-desktop",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 15"] },
    },
  ],
});
