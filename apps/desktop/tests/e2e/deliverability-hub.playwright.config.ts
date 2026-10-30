import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceMode = process.env["POSTWAVE_DELIVERABILITY_E2E_SOURCE"] === "1";
const evidenceMode = sourceMode ? "source" : "optimized";
const port = sourceMode ? 1425 : 1426;
const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: desktopRoot,
  encoding: "utf8",
}).trim();
const evidenceRoot = fileURLToPath(
  new URL(
    `../../../../.audit-screenshots/deliverability-hub-evidence/`,
    import.meta.url,
  ),
);

export default defineConfig({
  testDir: ".",
  testMatch: "deliverability-hub-maturity.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [
        ["github"],
        ["html", { open: "never" }],
        [
          "json",
          { outputFile: `${evidenceRoot}/reports/${evidenceMode}.json` },
        ],
      ]
    : [
        ["list"],
        [
          "json",
          { outputFile: `${evidenceRoot}/reports/${evidenceMode}.json` },
        ],
      ],
  metadata: {
    deliverabilityEvidenceMode: evidenceMode,
    deliverabilityBaseCommitSha: baseCommitSha,
    deliverabilityDeclaredTestCount: 4,
  },
  timeout: 70_000,
  expect: { timeout: 10_000 },
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
    new URL(
      `../../../../.audit-screenshots/deliverability-hub-evidence/results/${evidenceMode}/`,
      import.meta.url,
    ),
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
