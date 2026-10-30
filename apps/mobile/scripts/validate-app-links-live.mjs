#!/usr/bin/env node

import {
  NEGATIVE_AUTH_APP_LINK_FIXTURES,
  POSITIVE_AUTH_APP_LINK_FIXTURES,
  associationClaimsUrl,
} from "./app-link-fixtures.mjs";

const DEFAULT_ORIGIN = "https://app.moosewave.com";
const IOS_BUNDLE_ID = "com.moosewave.app";
const ANDROID_PACKAGE_NAME = "com.moosewave.app";
const REQUIRED_AASA_PATHS = [
  "/auth",
  "/auth/magic",
  "/auth/reset",
  "/auth/oauth-return",
  "/magic-link",
  "/reset-password",
  "/app/approvals/*",
  "/app/subscribers/*",
  "/app/campaigns/*",
  "/app/sequences/*",
];
const ANDROID_RELATION = "delegate_permission/common.handle_all_urls";

const errors = [];
const warnings = [];

function read(name) {
  return (process.env[name] ?? "").trim();
}

function csv(name) {
  return read(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeOrigin(rawOrigin) {
  try {
    const url = new URL(rawOrigin || DEFAULT_ORIGIN);
    if (url.protocol !== "https:") {
      throw new Error("origin must use https");
    }
    return url.origin;
  } catch (err) {
    errors.push(
      `POSTWAVE_APP_LINK_ORIGIN is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_ORIGIN;
  }
}

function selectedPlatform() {
  const platform = (
    read("POSTWAVE_APP_LINK_CHECK_PLATFORM") ||
    read("MATRIX_PLATFORM") ||
    "all"
  ).toLowerCase();

  if (!["all", "ios", "android"].includes(platform)) {
    errors.push(
      `POSTWAVE_APP_LINK_CHECK_PLATFORM must be one of all, ios, android; received "${platform}".`,
    );
    return "all";
  }

  return platform;
}

function validateAppleConfig(teamId) {
  if (!teamId) {
    errors.push(
      "POSTWAVE_APPLE_TEAM_ID, EXPO_APPLE_TEAM_ID, or APPLE_TEAM_ID is required for AASA validation.",
    );
    return;
  }

  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    errors.push("Apple Team ID must be 10 uppercase alphanumeric characters.");
  }
}

function validateFingerprintConfig(fingerprints) {
  if (fingerprints.length === 0) {
    errors.push(
      "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS is required for assetlinks validation.",
    );
    return;
  }

  const pattern = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
  for (const fingerprint of fingerprints) {
    if (!pattern.test(fingerprint)) {
      errors.push(
        `Android SHA-256 fingerprint must be uppercase colon-delimited hex: ${fingerprint}`,
      );
    }
  }
}

async function fetchJson(origin, path) {
  const url = new URL(path, origin);
  let response;

  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    errors.push(
      `${url.href} could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const text = await response.text();
  if (!response.ok) {
    const snippet = text.trim().slice(0, 240);
    errors.push(
      `${url.href} returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
    );
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors.push(
      `${url.href} did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    warnings.push(
      `${url.href} returned content-type "${contentType || "unknown"}"; continuing because JSON parsing succeeded.`,
    );
  }

  return parsed;
}

function collectAppleAppIds(detail) {
  const appIds = [];

  if (typeof detail?.appID === "string") {
    appIds.push(detail.appID);
  }

  if (Array.isArray(detail?.appIDs)) {
    for (const appId of detail.appIDs) {
      if (typeof appId === "string") {
        appIds.push(appId);
      }
    }
  }

  return appIds;
}

function collectApplePaths(detail) {
  const paths = [];

  if (Array.isArray(detail?.paths)) {
    for (const path of detail.paths) {
      if (typeof path === "string") {
        paths.push(path);
      }
    }
  }

  if (Array.isArray(detail?.components)) {
    for (const component of detail.components) {
      const path = component?.["/"];
      if (typeof path === "string") {
        paths.push(path);
      }
    }
  }

  return new Set(paths);
}

function validateApple(body, appId) {
  const details = body?.applinks?.details;
  if (!Array.isArray(details)) {
    errors.push("AASA response must contain applinks.details array.");
    return;
  }

  const detail = details.find((candidate) =>
    collectAppleAppIds(candidate).includes(appId),
  );

  if (!detail) {
    errors.push(`AASA response does not include app ID ${appId}.`);
    return;
  }

  const advertisedPaths = collectApplePaths(detail);
  for (const path of REQUIRED_AASA_PATHS) {
    if (!advertisedPaths.has(path)) {
      errors.push(`AASA response for ${appId} is missing path ${path}.`);
    }
  }
  for (const fixture of POSITIVE_AUTH_APP_LINK_FIXTURES) {
    if (!associationClaimsUrl(advertisedPaths, fixture.url)) {
      errors.push(
        "AASA response for " +
          appId +
          " does not claim " +
          fixture.name +
          ": " +
          fixture.url,
      );
    }
  }
  for (const fixture of NEGATIVE_AUTH_APP_LINK_FIXTURES) {
    if (associationClaimsUrl(advertisedPaths, fixture.url)) {
      errors.push(
        "AASA response for " +
          appId +
          " unexpectedly claims " +
          fixture.name +
          ": " +
          fixture.url,
      );
    }
  }
}

function normalizeFingerprint(value) {
  return value.trim().toUpperCase();
}

function validateAndroid(body, packageName, fingerprints) {
  if (!Array.isArray(body)) {
    errors.push("assetlinks response must be a JSON array.");
    return;
  }

  const expectedFingerprints = fingerprints.map(normalizeFingerprint);
  const entry = body.find((candidate) => {
    const relation = Array.isArray(candidate?.relation)
      ? candidate.relation
      : [];
    const target = candidate?.target ?? {};
    const advertisedFingerprints = Array.isArray(
      target.sha256_cert_fingerprints,
    )
      ? target.sha256_cert_fingerprints.map(normalizeFingerprint)
      : [];

    return (
      relation.includes(ANDROID_RELATION) &&
      target.namespace === "android_app" &&
      target.package_name === packageName &&
      expectedFingerprints.every((fingerprint) =>
        advertisedFingerprints.includes(fingerprint),
      )
    );
  });

  if (!entry) {
    errors.push(
      `assetlinks response does not authorize ${packageName} with the expected signing fingerprint(s).`,
    );
  }
}

const origin = normalizeOrigin(read("POSTWAVE_APP_LINK_ORIGIN"));
const platform = selectedPlatform();
const shouldCheckApple = platform === "all" || platform === "ios";
const shouldCheckAndroid = platform === "all" || platform === "android";
const appleTeamId =
  read("POSTWAVE_APPLE_TEAM_ID") ||
  read("EXPO_APPLE_TEAM_ID") ||
  read("APPLE_TEAM_ID");
const appleBundleId = read("POSTWAVE_IOS_BUNDLE_ID") || IOS_BUNDLE_ID;
const androidPackageName =
  read("POSTWAVE_ANDROID_PACKAGE_NAME") || ANDROID_PACKAGE_NAME;
const androidFingerprints = csv("POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS");

if (shouldCheckApple) {
  validateAppleConfig(appleTeamId);
}

if (shouldCheckAndroid) {
  validateFingerprintConfig(androidFingerprints);
}

if (errors.length > 0) {
  console.error("[postwave-mobile] live app link validation failed.");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (shouldCheckApple) {
  const body = await fetchJson(
    origin,
    "/.well-known/apple-app-site-association",
  );
  if (body && appleTeamId) {
    validateApple(body, `${appleTeamId}.${appleBundleId}`);
  }
}

if (shouldCheckAndroid) {
  const body = await fetchJson(origin, "/.well-known/assetlinks.json");
  if (body && androidFingerprints.length > 0) {
    validateAndroid(body, androidPackageName, androidFingerprints);
  }
}

for (const warning of warnings) {
  console.warn(`[postwave-mobile] warning: ${warning}`);
}

if (errors.length > 0) {
  console.error("[postwave-mobile] live app link validation failed.");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `[postwave-mobile] live app link validation passed for ${origin} (${platform}).`,
);
