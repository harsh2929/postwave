import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const rawEvidenceMode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
if (rawEvidenceMode !== "source" && rawEvidenceMode !== "optimized") {
  throw new Error(
    `PW_EVIDENCE_MODE must be source or optimized; received ${rawEvidenceMode}`,
  );
}
const evidenceMode: "source" | "optimized" = rawEvidenceMode;
const sourceMode = evidenceMode === "source";
const port = sourceMode ? 1463 : 1464;
const optimizedEvidenceApiOrigin =
  "https://migrations-evidence.example.invalid";
const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: desktopRoot,
  encoding: "utf8",
}).trim();
const evidenceRoot = fileURLToPath(
  new URL(
    "../../../../.audit-screenshots/migrations-evidence/",
    import.meta.url,
  ),
);

export default defineConfig({
  testDir: ".",
  testMatch: "migrations-maturity.spec.ts",
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
    migrationsEvidenceMode: evidenceMode,
    migrationsBaseCommitSha: baseCommitSha,
    migrationsDeclaredTestCount: 10,
  },
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${port}`,
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
      `../../../../.audit-screenshots/migrations-evidence/results/${evidenceMode}/`,
      import.meta.url,
    ),
  ),
  webServer: {
    command: sourceMode
      ? `pnpm exec vite --port ${port} --strictPort`
      : `VITE_API_URL=${optimizedEvidenceApiOrigin} pnpm exec vite build && pnpm exec vite preview --port ${port} --strictPort`,
    cwd: desktopRoot,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
