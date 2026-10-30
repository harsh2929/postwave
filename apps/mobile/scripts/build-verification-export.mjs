#!/usr/bin/env node

import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const outputRoot = join(appRoot, ".expo", "verification-export");
const expoCli = require.resolve("expo/bin/cli");
const budgetScript = join(scriptDir, "check-export-budgets.mjs");

rmSync(outputRoot, { force: true, recursive: true });

const cleanEnv = {
  ...process.env,
  CI: "1",
  EXPO_NO_TELEMETRY: "1",
  NODE_ENV: "production",
  EXPO_APPLE_TEAM_ID: "ABCDE12345",
  EXPO_PUBLIC_API_URL: "https://api.invalid",
  EXPO_PUBLIC_APP_URL: "https://app.invalid",
  EXPO_PUBLIC_BUILD_PROFILE: "verification",
  EXPO_PUBLIC_POSTWAVE_ENV: "verification",
  EXPO_PUBLIC_EAS_PROJECT_ID: "",
  EXPO_PUBLIC_POSTHOG_HOST: "",
  EXPO_PUBLIC_POSTHOG_KEY: "",
  EXPO_PUBLIC_POSTWAVE_RELEASE: "",
  EXPO_PUBLIC_SENTRY_DSN_MOBILE: "",
  SENTRY_AUTH_TOKEN: "",
  SENTRY_ORG: "postwave-verification",
  SENTRY_PROJECT: "postwave-mobile",
};

for (const [index, platform] of ["ios", "android"].entries()) {
  const outputDir = join(outputRoot, platform);
  const args = [
    expoCli,
    "export",
    "--platform",
    platform,
    "--source-maps",
    "--output-dir",
    outputDir,
  ];
  if (index === 0) args.push("--clear");
  const result = spawnSync(process.execPath, args, {
    cwd: appRoot,
    env: cleanEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const check = spawnSync(process.execPath, [budgetScript, outputRoot], {
  cwd: appRoot,
  env: cleanEnv,
  stdio: "inherit",
});
if (check.error) throw check.error;
process.exit(check.status ?? 1);
