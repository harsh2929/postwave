import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.POSTWAVE_WEB_URL || "http://localhost:3000";
const apiURL = process.env.POSTWAVE_API_URL || "http://localhost:8080";
const channel = process.env.PLAYWRIGHT_CHANNEL || "chrome";

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    channel,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  metadata: {
    apiURL,
  },
});
