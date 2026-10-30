#!/usr/bin/env node
import fs from "node:fs";

const MOBILE_TAG_PREFIX = "mobile-v";
const appJsonPath = new URL("../app.json", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

const refName = currentRefName();
const refType = currentRefType();
const appJson = readJson(appJsonPath);
const expoVersion = String(appJson?.expo?.version ?? "").trim();

// runtimeVersion is {policy: "appVersion"}: every binary built at one
// expo.version takes every OTA update published for it. Nothing bumps that
// version when the native surface changes, so the mobile-v<version> tag is the
// only thing that keeps one runtime to one native build. A store submission
// from anywhere else could ship a second binary under an existing runtime —
// Play accepts the same versionName with a higher versionCode — and an update
// meant for one would then reach the other.
if (process.env.SUBMIT_AFTER_BUILD?.trim() === "true") {
  const fromTag =
    refName.startsWith(MOBILE_TAG_PREFIX) && refType !== "branch";
  if (!fromTag) {
    console.error(
      `[postwave-mobile] a store submission must be built from a ${MOBILE_TAG_PREFIX}${expoVersion || "<version>"} tag so its runtimeVersion is unique (this run is on ${refType || "ref"} "${refName || "<none>"}").`,
    );
    process.exit(1);
  }
}

if (!refName || !refName.startsWith(MOBILE_TAG_PREFIX)) {
  console.log("[postwave-mobile] no mobile-v* tag detected; skipping version check");
  process.exit(0);
}

const tagVersion = refName.slice(MOBILE_TAG_PREFIX.length);
const packageJson = readJson(packageJsonPath);
const packageVersion = String(packageJson?.version ?? "").trim();

const mismatches = [];
if (tagVersion !== expoVersion) {
  mismatches.push(`app.json expo.version is ${expoVersion || "<missing>"}`);
}
if (packageVersion && packageVersion !== expoVersion) {
  mismatches.push(`package.json version is ${packageVersion}`);
}

if (mismatches.length > 0) {
  console.error(
    `[postwave-mobile] release tag ${refName} does not match mobile version ${expoVersion || "<missing>"}`,
  );
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(`[postwave-mobile] release tag ${refName} matches version ${expoVersion}`);

function currentRefName() {
  const explicit = process.env.GITHUB_REF_NAME?.trim();
  if (explicit) return explicit;
  const ref = process.env.GITHUB_REF?.trim();
  if (!ref) return "";
  return ref.replace(/^refs\/tags\//, "").replace(/^refs\/heads\//, "");
}

/** "tag", "branch", or "" when the environment does not say. */
function currentRefType() {
  const explicit = process.env.GITHUB_REF_TYPE?.trim();
  if (explicit) return explicit;
  const ref = process.env.GITHUB_REF?.trim() ?? "";
  if (ref.startsWith("refs/tags/")) return "tag";
  if (ref.startsWith("refs/heads/")) return "branch";
  return "";
}

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}
