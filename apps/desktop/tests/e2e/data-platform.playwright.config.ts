import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const rawPort = process.env["POSTWAVE_DATA_PLATFORM_PORT"] ?? "1465";
if (!/^\d{1,5}$/u.test(rawPort)) {
  throw new Error("POSTWAVE_DATA_PLATFORM_PORT must be a decimal TCP port");
}
const port = Number(rawPort);
if (port < 1024 || port > 65_535) {
  throw new Error("POSTWAVE_DATA_PLATFORM_PORT must be between 1024 and 65535");
}
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "data-platform-maturity.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    viewport: { width: 1_440, height: 1_000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    deviceScaleFactor: 1,
    colorScheme: "no-preference",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: fileURLToPath(
    new URL(
      "../../../../.audit-screenshots/data-platform-evidence/results/",
      import.meta.url,
    ),
  ),
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: desktopRoot,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
