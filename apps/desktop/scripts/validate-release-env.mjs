#!/usr/bin/env node

const TAG_PREFIX = "desktop-v";
const dryRun = process.argv.slice(2).includes("--dry-run");
const unknownArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== "--dry-run" && argument !== "--");

if (unknownArgs.length > 0) {
  console.error(`[postwave-desktop] unknown environment preflight argument: ${unknownArgs[0]}`);
  process.exit(2);
}

const refName = currentRefName();
const isReleaseTag =
  process.env.GITHUB_REF_TYPE === "tag" || refName.startsWith(TAG_PREFIX);

if (!isReleaseTag) {
  if (!dryRun) {
    console.error(
      "[postwave-desktop] non-tag build requires --dry-run; an implicit skipped preflight is not a pass",
    );
    process.exit(2);
  }
}

const platform = (
  process.env.MATRIX_PLATFORM ||
  process.env.RUNNER_OS ||
  ""
)
  .trim()
  .toLowerCase();

const required = dryRun
  ? []
  : [
      "TAURI_SIGNING_PRIVATE_KEY",
      "POSTWAVE_UPDATER_PUBKEY",
      "POSTWAVE_UPDATER_ENDPOINT",
    ];

const isMacOS = platform.includes("macos") || platform === "macos";
const isWindows = platform.includes("windows");
if (!isMacOS && !isWindows) {
  console.error(
    "[postwave-desktop] MATRIX_PLATFORM or RUNNER_OS must identify macOS or Windows",
  );
  process.exit(2);
}

if (!dryRun && isMacOS) {
  required.push(
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_TEAM_ID",
    "APPLE_PASSWORD",
  );
}

if (!dryRun && isWindows) {
  required.push("WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD");
}

const missing = required.filter((name) => !process.env[name]?.trim());
const errors = [...missing.map((name) => `missing required env ${name}`)];

const endpoint = process.env.POSTWAVE_UPDATER_ENDPOINT?.trim() ?? "";
if (endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      errors.push("POSTWAVE_UPDATER_ENDPOINT must use https for tagged releases");
    }
  } catch {
    errors.push("POSTWAVE_UPDATER_ENDPOINT must be a valid URL");
  }
}

const appleTeamId = process.env.APPLE_TEAM_ID?.trim() ?? "";
if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
  errors.push("APPLE_TEAM_ID must be a 10-character Apple Team ID");
}

if (errors.length > 0) {
  console.error("[postwave-desktop] production release secret preflight failed.");
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log(
  dryRun
    ? `[postwave-desktop] dry-run ${platform} release environment contract passed; signing credentials were not consumed.`
    : "[postwave-desktop] production release secret preflight passed.",
);

function currentRefName() {
  const explicit = process.env.GITHUB_REF_NAME?.trim();
  if (explicit) return explicit;
  const ref = process.env.GITHUB_REF?.trim();
  if (!ref) return "";
  return ref.replace(/^refs\/tags\//, "").replace(/^refs\/heads\//, "");
}
