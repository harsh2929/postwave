#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_PREFIX = "desktop-v";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, "..");
const refName = currentRefName();
const dryRun = process.argv.slice(2).includes("--dry-run");
const unknownArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== "--dry-run" && argument !== "--");

if (unknownArgs.length > 0) {
  console.error(`[postwave-desktop] unknown version preflight argument: ${unknownArgs[0]}`);
  process.exit(2);
}

const packageJson = readJson(join(appDir, "package.json"));
const packageVersion = String(packageJson?.version ?? "").trim();

if (!refName || !refName.startsWith(TAG_PREFIX)) {
  if (!dryRun) {
    console.error(
      "[postwave-desktop] no desktop-v* tag detected; pass --dry-run to validate the package version contract explicitly",
    );
    process.exit(2);
  }
}

const tagVersion = refName.startsWith(TAG_PREFIX)
  ? refName.slice(TAG_PREFIX.length)
  : packageVersion;
const tauriConfig = readJson(join(appDir, "src-tauri", "tauri.conf.json"));
const cargoToml = readFileSync(join(appDir, "src-tauri", "Cargo.toml"), "utf8");
const changelog = readFileSync(join(appDir, "CHANGELOG.md"), "utf8");

const tauriVersion = String(tauriConfig?.version ?? "").trim();
const cargoVersion = matchFirst(cargoToml, /^\s*version\s*=\s*"([^"]+)"/m);
const changelogHeader = new RegExp(
  `^## \\[${escapeRegExp(tagVersion)}\\] - (?!YYYY-MM-DD)\\d{4}-\\d{2}-\\d{2}\\s*$`,
  "m",
);

const mismatches = [];
if (!SEMVER_RE.test(tagVersion)) {
  mismatches.push(`tag version "${tagVersion}" is not valid SemVer`);
}
if (packageVersion !== tagVersion) {
  mismatches.push(`package.json version is ${packageVersion || "<missing>"}`);
}
if (tauriVersion !== tagVersion) {
  mismatches.push(`src-tauri/tauri.conf.json version is ${tauriVersion || "<missing>"}`);
}
if (cargoVersion !== tagVersion) {
  mismatches.push(`src-tauri/Cargo.toml version is ${cargoVersion || "<missing>"}`);
}
if (!changelogHeader.test(changelog)) {
  mismatches.push(
    `CHANGELOG.md must contain "## [${tagVersion}] - YYYY-MM-DD" with a real date`,
  );
}

if (mismatches.length > 0) {
  console.error(`[postwave-desktop] release tag ${refName} failed version preflight.`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(
  dryRun && !refName.startsWith(TAG_PREFIX)
    ? `[postwave-desktop] dry-run version contract matches ${tagVersion}`
    : `[postwave-desktop] release tag ${refName} matches version ${tagVersion}`,
);

function currentRefName() {
  const explicit = process.env.GITHUB_REF_NAME?.trim();
  if (explicit) return explicit;
  const ref = process.env.GITHUB_REF?.trim();
  if (!ref) return "";
  return ref.replace(/^refs\/tags\//, "").replace(/^refs\/heads\//, "");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function matchFirst(content, re) {
  return content.match(re)?.[1]?.trim() ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
