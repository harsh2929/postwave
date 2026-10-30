// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "config/distribution-assets.json");
const failures = [];

function fail(message) {
  failures.push(message);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (error) {
  console.error(`distribution hygiene: cannot parse policy: ${error.message}`);
  process.exit(1);
}

const topKeys = new Set([
  "schemaVersion",
  "forbiddenTrackedRoots",
  "allowedRasterRoots",
]);
for (const key of Object.keys(config)) {
  if (!topKeys.has(key)) fail(`unknown policy key ${key}`);
}
if (config.schemaVersion !== 1) fail("schemaVersion must equal 1");
if (!Array.isArray(config.forbiddenTrackedRoots) || config.forbiddenTrackedRoots.length === 0) {
  fail("forbiddenTrackedRoots must be a non-empty array");
}
if (!Array.isArray(config.allowedRasterRoots) || config.allowedRasterRoots.length === 0) {
  fail("allowedRasterRoots must be a non-empty array");
}

const allowedKeys = new Set(["path", "owner", "purpose", "maxFileBytes"]);
const allowedRoots = [];
for (const [index, entry] of (config.allowedRasterRoots ?? []).entries()) {
  const context = `allowedRasterRoots[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${context} must be an object`);
    continue;
  }
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) fail(`${context} has unknown key ${key}`);
  }
  if (typeof entry.path !== "string" || !entry.path.endsWith("/") || entry.path.startsWith("/")) {
    fail(`${context}.path must be a repository-relative directory ending in /`);
  }
  if (typeof entry.owner !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.owner)) {
    fail(`${context}.owner must be a stable lower-kebab identifier`);
  }
  if (typeof entry.purpose !== "string" || entry.purpose.trim().length < 12) {
    fail(`${context}.purpose must explain the distribution need`);
  }
  if (!Number.isSafeInteger(entry.maxFileBytes) || entry.maxFileBytes < 1024 || entry.maxFileBytes > 20 * 1024 * 1024) {
    fail(`${context}.maxFileBytes must be an integer from 1 KiB through 20 MiB`);
  }
  const absolute = resolve(ROOT, entry.path);
  const back = relative(ROOT, absolute);
  if (back === ".." || back.startsWith(`..${sep}`)) {
    fail(`${context}.path escapes the repository`);
  }
  allowedRoots.push(entry);
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const existingTracked = tracked.filter((path) => {
  try {
    lstatSync(resolve(ROOT, path));
    return true;
  } catch {
    // A deletion in the current remediation worktree is absent from the
    // distributable tree. A clean release tag cannot contain this state.
    return false;
  }
});

for (const root of config.forbiddenTrackedRoots ?? []) {
  if (typeof root !== "string" || !root || root.startsWith("/") || root.includes("..")) {
    fail(`invalid forbidden tracked root ${JSON.stringify(root)}`);
    continue;
  }
  for (const path of existingTracked) {
    if (path.startsWith(root)) fail(`generated audit/review artifact is tracked: ${path}`);
  }
}

const rasterPattern = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/iu;
const secretPatterns = [
  /AKIA[0-9A-Z]{16}/u,
  /ASIA[0-9A-Z]{16}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk_live_[0-9A-Za-z]{16,}\b/u,
  /\bghp_[0-9A-Za-z]{20,}\b/u,
];
let rasterCount = 0;
for (const path of existingTracked.filter((path) => rasterPattern.test(path))) {
  rasterCount += 1;
  const matches = allowedRoots.filter((entry) => path.startsWith(entry.path));
  if (matches.length !== 1) {
    fail(`tracked raster is outside exactly one reviewed distribution root: ${path}`);
    continue;
  }
  const absolute = resolve(ROOT, path);
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`reviewed raster must be a regular non-symlink file: ${path}`);
    continue;
  }
  if (realpathSync(absolute) !== absolute) {
    fail(`reviewed raster resolves outside its canonical path: ${path}`);
  }
  if (stats.size > matches[0].maxFileBytes) {
    fail(`${path} exceeds its reviewed ${matches[0].maxFileBytes}-byte ceiling`);
  }
  const bytes = readFileSync(absolute);
  const searchable = bytes.toString("latin1");
  for (const pattern of secretPatterns) {
    if (pattern.test(searchable)) fail(`${path} contains a high-confidence credential marker`);
  }
}

if (failures.length > 0) {
  console.error(`distribution hygiene: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `distribution hygiene: PASS (${rasterCount} tracked raster assets in ${allowedRoots.length} reviewed roots; no tracked ad-hoc audit artifacts)`,
);
