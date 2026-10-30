#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profile =
  process.env.EAS_BUILD_PROFILE ||
  process.env.EXPO_PUBLIC_BUILD_PROFILE ||
  process.env.POSTWAVE_MOBILE_BUILD_PROFILE ||
  "";

const platform = (
  process.env.EAS_BUILD_PLATFORM ||
  process.env.MATRIX_PLATFORM ||
  process.env.POSTWAVE_MOBILE_PLATFORM ||
  ""
)
  .trim()
  .toLowerCase();
const shouldValidateIOS =
  platform === "" || platform === "all" || platform === "ios";

const __dirname = dirname(fileURLToPath(import.meta.url));
const easBuildCommit = (process.env.EAS_BUILD_GIT_COMMIT_HASH ?? "").trim();
const configuredRelease = (
  process.env.EXPO_PUBLIC_POSTWAVE_RELEASE ?? ""
).trim();
const effectiveRelease = easBuildCommit || configuredRelease;

// Reached for production, and for the Firebase check on a preview build, so the
// header names the profile that failed.
function failPreflight(errors) {
  console.error(`[postwave-mobile] ${profile} release env preflight failed.`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function validateExactHttpsOrigin(name, rawValue, expectedOrigin) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return `${name} must be a valid URL.`;
  }
  if (parsed.protocol !== "https:") {
    return `${name} must use HTTPS.`;
  }
  if (parsed.username || parsed.password) {
    return `${name} must not contain credentials.`;
  }
  if (
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return `${name} must be an origin without a path, query, or fragment.`;
  }
  if (parsed.origin !== expectedOrigin) {
    return `${name} must use the approved origin ${expectedOrigin}.`;
  }
  return null;
}

function validateHttpsOrigin(name, rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return `${name} must be a valid URL.`;
  }
  if (parsed.protocol !== "https:") {
    return `${name} must use HTTPS.`;
  }
  if (parsed.username || parsed.password) {
    return `${name} must not contain credentials.`;
  }
  if (
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return `${name} must be an origin without a path, query, or fragment.`;
  }
  return null;
}

function validateSentryDsn(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return "EXPO_PUBLIC_SENTRY_DSN_MOBILE must be a valid Sentry DSN.";
  }
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const projectId = pathSegments.at(-1) ?? "";
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    !parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\d+$/.test(projectId)
  ) {
    return "EXPO_PUBLIC_SENTRY_DSN_MOBILE must be a public HTTPS Sentry DSN with a numeric project ID and no secret, query, or fragment.";
  }
  return null;
}

// UpgradeRequiredScreen sends a below-floor iOS build to the App Store listing
// for EXPO_PUBLIC_IOS_APP_STORE_ID. storeUrlsForPlatform (src/lib/upgradeRequired.ts)
// opens that listing only for a value matching this bound, after trimming it,
// and opens an App Store search page for anything else. The two bounds are
// held equal by validate-production-env.test.mjs.
const IOS_APP_STORE_ID_PATTERN = /^[0-9]{6,12}$/;
const IOS_APP_STORE_ID_HINT =
  "EXPO_PUBLIC_IOS_APP_STORE_ID is the Apple ID of the App Store Connect app record (App Information), the same number as the ASC_APP_ID submit secret. Set it in the EAS production environment and as a variable in the mobile-production GitHub environment.";

const FIREBASE_SETUP_HINT =
  'Upload the Firebase google-services.json for the Android app as the EAS file variable GOOGLE_SERVICES_JSON, in both the production and preview environments. See apps/mobile/README.md, "Android push: Firebase Cloud Messaging".';

/**
 * The google-services.json the Gradle plugin will read, checked the way the
 * plugin will check it. Returns an error string, or null when it is usable.
 */
function validateGoogleServicesFile(rawPath, expectedPackage) {
  if (!rawPath) {
    return "GOOGLE_SERVICES_JSON is not set, so this Android build would ship without Firebase and every push registration on it would fail.";
  }
  // @expo/config-plugins path.resolve()s the value against the project root;
  // resolve it the same way so both read the same file.
  const path = resolve(__dirname, "..", rawPath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return `GOOGLE_SERVICES_JSON points at ${path}, which does not exist or is not a file.`;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return `GOOGLE_SERVICES_JSON (${path}) is not valid JSON.`;
  }
  const packages = (Array.isArray(config?.client) ? config.client : [])
    .map((client) => client?.client_info?.android_client_info?.package_name)
    .filter((name) => typeof name === "string");
  if (!packages.includes(expectedPackage)) {
    return `GOOGLE_SERVICES_JSON has no Android client for ${expectedPackage} (found: ${packages.join(", ") || "none"}). The google-services Gradle plugin fails the build on that mismatch.`;
  }
  return null;
}

function readAppJson() {
  return JSON.parse(readFileSync(join(__dirname, "..", "app.json"), "utf8"));
}

// On Android, expo-notifications gets its push token from Firebase Cloud
// Messaging, and FirebaseMessaging.getInstance() needs a default FirebaseApp.
// That exists only when the google-services Gradle plugin runs, which
// @expo/config-plugins applies only when expo.android.googleServicesFile is
// set. app.config.js sets it from GOOGLE_SERVICES_JSON, an EAS file variable.
// A build without it still succeeds, and ships an app whose push registration
// fails on every device: the Settings switch reverts, launch registration does
// nothing, and approval pushes never arrive.
//
// Required for production and for preview, the internal APK the Android push
// device pass runs on, which is why this runs ahead of the non-production exit
// below. Development builds (emulator dev clients) skip it. Checked only on
// the EAS worker (EAS_BUILD=true, the eas-build-pre-install run): the GitHub
// runner never sees the worker's file variable, and iOS gets its token from
// APNs.
const FIREBASE_REQUIRED_PROFILES = new Set(["production", "preview"]);
const shouldValidateAndroid =
  platform === "" || platform === "all" || platform === "android";
if (
  process.env.EAS_BUILD === "true" &&
  shouldValidateAndroid &&
  FIREBASE_REQUIRED_PROFILES.has(profile)
) {
  const androidPackage =
    readAppJson().expo?.android?.package || "com.moosewave.app";
  const firebaseError = validateGoogleServicesFile(
    (process.env.GOOGLE_SERVICES_JSON ?? "").trim(),
    androidPackage,
  );
  if (firebaseError) failPreflight([firebaseError, FIREBASE_SETUP_HINT]);
  console.log(
    `[postwave-mobile] Android Firebase config preflight passed: GOOGLE_SERVICES_JSON has a client for ${androidPackage}.`,
  );
}

if (profile !== "production") {
  console.log(
    `[postwave-mobile] release env preflight skipped for profile "${profile || "local"}".`,
  );
  process.exit(0);
}

const required = [
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_APP_URL",
  "EXPO_PUBLIC_BUILD_PROFILE",
  "EXPO_PUBLIC_SENTRY_DSN_MOBILE",
  "EXPO_PUBLIC_POSTWAVE_ENV",
  "EXPO_PUBLIC_POSTHOG_KEY",
  "EXPO_PUBLIC_POSTHOG_HOST",
  "EXPO_PUBLIC_EAS_PROJECT_ID",
  // app.config.js REFUSES to configure an update channel without this, because
  // an unsigned OTA channel turns a leaked EXPO_TOKEN into arbitrary code
  // execution on every install. That refusal is a throw during config
  // resolution, which surfaces mid-`eas build` as a stack trace. Listing it
  // here means the release pipeline's own preflight names it first, in the
  // same "Missing required production env: ..." line as everything else.
  "EXPO_UPDATES_CODE_SIGNING_CERTIFICATE",
  "EXPO_OWNER",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
];

if (!effectiveRelease) required.push("EXPO_PUBLIC_POSTWAVE_RELEASE");

const missing = required.filter((name) => !process.env[name]?.trim());
const appleTeamId = (
  process.env.EXPO_APPLE_TEAM_ID ||
  process.env.APPLE_TEAM_ID ||
  ""
).trim();

const iosAppStoreId = (process.env.EXPO_PUBLIC_IOS_APP_STORE_ID ?? "").trim();

if (shouldValidateIOS && !appleTeamId) {
  missing.push("EXPO_APPLE_TEAM_ID (or APPLE_TEAM_ID)");
}
if (shouldValidateIOS && !iosAppStoreId) {
  missing.push("EXPO_PUBLIC_IOS_APP_STORE_ID");
}

if (missing.length > 0) {
  failPreflight([
    `Missing required production env: ${missing.sort().join(", ")}`,
    "Set these in the EAS production environment or pass them explicitly before building.",
    ...(missing.includes("EXPO_PUBLIC_IOS_APP_STORE_ID")
      ? [IOS_APP_STORE_ID_HINT]
      : []),
  ]);
}

if (shouldValidateIOS && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
  failPreflight([
    "EXPO_APPLE_TEAM_ID/APPLE_TEAM_ID must be a 10-character Apple Team ID.",
  ]);
}

if (shouldValidateIOS && !IOS_APP_STORE_ID_PATTERN.test(iosAppStoreId)) {
  failPreflight([
    "EXPO_PUBLIC_IOS_APP_STORE_ID must be the app's numeric Apple ID (6 to 12 digits). For any other value the upgrade screen opens an App Store search page instead of the app.",
    IOS_APP_STORE_ID_HINT,
  ]);
}

if (process.env.EXPO_PUBLIC_BUILD_PROFILE !== "production") {
  console.error(
    "[postwave-mobile] EXPO_PUBLIC_BUILD_PROFILE must be production for production builds.",
  );
  process.exit(1);
}

if (process.env.EXPO_PUBLIC_POSTWAVE_ENV !== "production") {
  console.error(
    "[postwave-mobile] EXPO_PUBLIC_POSTWAVE_ENV must be production for production builds.",
  );
  process.exit(1);
}

const valueErrors = [
  validateExactHttpsOrigin(
    "EXPO_PUBLIC_API_URL",
    process.env.EXPO_PUBLIC_API_URL,
    "https://api.moosewave.com",
  ),
  validateExactHttpsOrigin(
    "EXPO_PUBLIC_APP_URL",
    process.env.EXPO_PUBLIC_APP_URL,
    "https://app.moosewave.com",
  ),
  validateHttpsOrigin(
    "EXPO_PUBLIC_POSTHOG_HOST",
    process.env.EXPO_PUBLIC_POSTHOG_HOST,
  ),
  validateSentryDsn(process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE),
];

if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
  )
) {
  valueErrors.push("EXPO_PUBLIC_EAS_PROJECT_ID must be a canonical UUID.");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(process.env.EXPO_OWNER)) {
  valueErrors.push(
    "EXPO_OWNER must be the Expo account or organization slug that owns the release project.",
  );
}
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(effectiveRelease)) {
  valueErrors.push(
    "EXPO_PUBLIC_POSTWAVE_RELEASE must be the lowercase 40- or 64-character Git commit hash being built.",
  );
}

const invalidValues = valueErrors.filter(Boolean);
if (invalidValues.length > 0) failPreflight(invalidValues);

const appJson = readAppJson();
const ios = appJson.expo?.ios ?? {};
const android = appJson.expo?.android ?? {};
const plugins = appJson.expo?.plugins ?? [];
const nativeConfigErrors = [];

// iPad support was DELIBERATELY ENABLED by the product owner (2026-07-27),
// superseding the phone-only v1 stance this check used to enforce. The guard is
// kept, inverted: `supportsTablet` must now be explicitly TRUE rather than
// merely truthy, so the field cannot silently disappear in a config merge and
// leave iPad users on a stretched phone build. The portrait lock did not change;
// it takes the two keys asserted below, one per device family.
if (ios.supportsTablet !== true) {
  nativeConfigErrors.push(
    "iOS tablet support must be enabled (expo.ios.supportsTablet: true) — iPad support was approved 2026-07-27.",
  );
}

// The other half of the same decision: iPad support was approved, portrait lock
// was NOT lifted. Nothing in this app has been designed or tested in landscape.
//
// `orientation` locks iPHONE only. It becomes UISupportedInterfaceOrientations,
// which iPad ignores whenever the app multitasks.
if (appJson.expo?.orientation !== "portrait") {
  nativeConfigErrors.push(
    'App orientation must stay "portrait" — iPad support was approved without lifting the portrait lock.',
  );
}
// `requireFullScreen` (UIRequiresFullScreen) locks iPAD. Without it, prebuild
// treats a tablet build as multitasking and writes all four
// UISupportedInterfaceOrientations~ipad, so the iPad build rotates to landscape
// and runs in Split View and Slide Over whatever `orientation` says. With it,
// iPad stays portrait and gives up Split View and Slide Over.
//
// EXPIRY: Apple deprecates UIRequiresFullScreen from iPadOS 26 (TN3192), and
// builds made with the iOS 27 SDK do not honour it. The iPad posture has to be
// re-decided, and landscape and multitasking designed and tested, before the
// EAS build image moves to that SDK.
if (ios.requireFullScreen !== true) {
  nativeConfigErrors.push(
    'expo.ios.requireFullScreen must be true — orientation "portrait" only locks iPhone; without it prebuild writes all four UISupportedInterfaceOrientations~ipad and iPad rotates and multitasks.',
  );
}
if (android.allowBackup !== false) {
  nativeConfigErrors.push(
    "android.allowBackup must be false for customer data protection.",
  );
}
const blockedPermissions = new Set(android.blockedPermissions ?? []);
for (const permission of [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.RECORD_AUDIO",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_EXTERNAL_STORAGE",
]) {
  if (!blockedPermissions.has(permission)) {
    nativeConfigErrors.push(
      `android.blockedPermissions must include ${permission}.`,
    );
  }
}
const cameraPlugin = plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-camera",
);
const cameraOptions = Array.isArray(cameraPlugin)
  ? (cameraPlugin[1] ?? {})
  : {};
if (
  cameraOptions.microphonePermission !== false ||
  cameraOptions.recordAudioAndroid !== false ||
  cameraOptions.barcodeScannerEnabled !== true
) {
  nativeConfigErrors.push(
    "expo-camera must remain QR-only with microphonePermission=false, recordAudioAndroid=false, and barcodeScannerEnabled=true.",
  );
}
// Config plugins that write the same Info.plist key run in REVERSE order of
// app.json's plugin list, so the one listed earlier writes last and wins.
// expo-image-picker writes a generic NSMicrophoneUsageDescription unless told
// not to. The iOS build had no microphone prompt only because expo-camera,
// listed first, deleted it afterwards; swapping the two plugins would ship a
// prompt for a microphone the app never uses.
const pickerPlugin = plugins.find(
  (plugin) =>
    (Array.isArray(plugin) ? plugin[0] : plugin) === "expo-image-picker",
);
const pickerOptions = Array.isArray(pickerPlugin)
  ? (pickerPlugin[1] ?? {})
  : {};
if (pickerPlugin && pickerOptions.microphonePermission !== false) {
  nativeConfigErrors.push(
    "expo-image-picker must set microphonePermission=false, or the iOS build's microphone prompt depends on plugin order.",
  );
}
// Both camera plugins and ios.infoPlist write NSCameraUsageDescription, and
// plugin order picks which one ships. One sentence everywhere makes the order
// irrelevant, and it has to name every use: QR scanning and Assets photos.
const cameraPurpose = ios.infoPlist?.NSCameraUsageDescription;
for (const plugin of plugins) {
  if (!Array.isArray(plugin) || !plugin[1]) continue;
  if (
    Object.hasOwn(plugin[1], "cameraPermission") &&
    plugin[1].cameraPermission !== cameraPurpose
  ) {
    nativeConfigErrors.push(
      `${plugin[0]} cameraPermission must be the same sentence as ios.infoPlist.NSCameraUsageDescription, or the camera prompt depends on plugin order.`,
    );
  }
}
if (nativeConfigErrors.length > 0) failPreflight(nativeConfigErrors);

if (
  easBuildCommit &&
  configuredRelease &&
  configuredRelease !== easBuildCommit
) {
  failPreflight([
    "EXPO_PUBLIC_POSTWAVE_RELEASE does not match EAS_BUILD_GIT_COMMIT_HASH.",
  ]);
}

if (shouldValidateIOS) {
  const appGroups =
    ios.entitlements?.["com.apple.security.application-groups"] ?? [];
  const associatedDomains = ios.associatedDomains ?? [];
  const provisioningErrors = [];

  if (ios.bundleIdentifier !== "com.moosewave.app") {
    provisioningErrors.push('ios.bundleIdentifier must be "com.moosewave.app".');
  }
  if (
    !Array.isArray(appGroups) ||
    !appGroups.includes("group.com.moosewave.app")
  ) {
    provisioningErrors.push(
      'iOS App Group entitlement must include "group.com.moosewave.app".',
    );
  }
  if (
    !Array.isArray(associatedDomains) ||
    !associatedDomains.includes("applinks:app.moosewave.com")
  ) {
    provisioningErrors.push(
      'iOS associatedDomains must include "applinks:app.moosewave.com".',
    );
  }

  if (provisioningErrors.length > 0) {
    console.error(
      "[postwave-mobile] production iOS provisioning preflight failed.",
    );
    for (const err of provisioningErrors) {
      console.error(`- ${err}`);
    }
    process.exit(1);
  }
}

if (process.env.EAS_BUILD === "true" && easBuildCommit) {
  for (const name of [
    "EXPO_PUBLIC_POSTWAVE_RELEASE",
    "POSTWAVE_RELEASE",
    "SENTRY_RELEASE",
  ]) {
    const result = spawnSync("set-env", [name, easBuildCommit], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failPreflight([
        `EAS set-env failed for ${name}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
      ]);
    }
  }
}

console.log("[postwave-mobile] production release env preflight passed.");
