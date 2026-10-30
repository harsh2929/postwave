import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./performance",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "performance-results",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL:
      process.env.POSTWAVE_PERFORMANCE_URL ??
      process.env.POSTWAVE_E2E_URL ??
      "http://localhost:3000",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--enable-precise-memory-info"],
    },
  },
  projects: [
    {
      name: "performance-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "performance-mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
