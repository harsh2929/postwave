/* global __dirname -- CommonJS module scope; eslint-config-expo grants Node globals to metro.config.js only */
const { existsSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");

function appleTeamIdFromEnv() {
  const value = process.env.EXPO_APPLE_TEAM_ID || process.env.APPLE_TEAM_ID || "";
  return value.trim();
}

function easProjectIdFromEnv() {
  return (process.env.EXPO_PUBLIC_EAS_PROJECT_ID || "").trim();
}

function expoOwnerFromEnv() {
  return (process.env.EXPO_OWNER || "").trim();
}

/**
 * The Firebase config for Android push, from the EAS file variable
 * GOOGLE_SERVICES_JSON (on the worker its value is the file's absolute path).
 *
 * On Android, expo-notifications gets its token from Firebase Cloud Messaging,
 * which needs the google-services Gradle plugin, and @expo/config-plugins
 * applies that plugin only when `android.googleServicesFile` is set. The value
 * is passed through verbatim because Expo path.resolve()s it against this
 * directory, which keeps an absolute worker path absolute.
 *
 * Deliberately NOT a static path in app.json, and deliberately no throw when
 * it is missing. A path to a file that is not there makes prebuild fail with
 * "Cannot copy google-services.json", and that would break the secret-free
 * native-smoke prebuild in mobile-release.yml. The runner's local config
 * evaluation also never sees the worker's file. The fail-closed check lives in
 * scripts/validate-production-env.mjs, which runs on the EAS worker.
 */
function googleServicesFileFromEnv() {
  return (process.env.GOOGLE_SERVICES_JSON || "").trim() || null;
}

/**
 * The build profile, resolved the same way scripts/validate-production-env.mjs
 * resolves it. EAS sets EAS_BUILD_PROFILE itself; the EXPO_PUBLIC_ variant is
 * what eas.json puts in each profile's env and what a local export sets.
 */
function buildProfileFromEnv() {
  return (
    process.env.EAS_BUILD_PROFILE ||
    process.env.EXPO_PUBLIC_BUILD_PROFILE ||
    process.env.POSTWAVE_MOBILE_BUILD_PROFILE ||
    ""
  )
    .trim()
    .toLowerCase();
}

// The only algorithm expo-updates 55 will verify with. Hardcoded rather than
// env-supplied because a value it does not recognise is a build-time crash in
// the native reader, not a fallback:
// node_modules/expo-updates/ios/EXUpdates/CodeSigning/CodeSigningAlgorithm.swift
// declares exactly one case, `rsa-v1_5-sha256`.
const CODE_SIGNING_ALG = "rsa-v1_5-sha256";

/**
 * expo-updates code signing.
 *
 * WHAT IT DEFENDS AGAINST. `updates.url` alone means the installed binary
 * executes whatever JS the update server hands it. The server trusts an
 * EXPO_TOKEN, so a leaked token is not "someone can publish to our project" —
 * it is arbitrary code execution inside every install, with the user's session
 * cookie, keychain and App Group in reach, and no store review in the path.
 * Code signing moves the trust anchor off the token: the binary ships a public
 * certificate and refuses any manifest not signed by the matching PRIVATE key,
 * which never leaves the release pipeline's secret store.
 *
 * The key names below are read off the installed expo-updates (55.0.26), not
 * from memory — `cli/src/configureCodeSigningAsync.ts` is what `expo-updates:
 * configure-code-signing` writes, and @expo/config-plugins reads the same two
 * fields into EXUpdatesCodeSigningCertificate / EXUpdatesCodeSigningMetadata
 * (and the Android manifest equivalents) at prebuild.
 *
 * WHERE THE CERTIFICATE AND THE KEY LIVE. The certificate is public and is
 * committed at certs/postwave-updates.pem, the one .pem the ROOT .gitignore
 * lets through: eas-cli copies the working tree to the EAS worker through each
 * .gitignore separately, so an exception in apps/mobile/.gitignore would not
 * rescue it. mobile-release.yml's build job and eas.json's production and
 * preview profiles set EXPO_UPDATES_CODE_SIGNING_CERTIFICATE to that path. The
 * PRIVATE key that signs each publish is never in this repo, eas.json or an
 * EAS build environment: the custodian README.md names ("OTA update code
 * signing") holds it apart from EXPO_TOKEN, and a publish signs with
 * `eas update --private-key-path`. This file refuses to produce an UNSIGNED
 * update channel for anything that will be installed on a device — a silent
 * fallback to unsigned is the exact state this defends against, and it would
 * look identical to a working configuration.
 */
function codeSigningFromEnv() {
  const certificatePath = (
    process.env.EXPO_UPDATES_CODE_SIGNING_CERTIFICATE || ""
  ).trim();
  if (!certificatePath) return null;

  // @expo/config-plugins does `path.join(projectRoot, certificatePath)`, and
  // path.join does NOT discard a leading "/" on the second argument — an
  // absolute path silently becomes <projectRoot>/<abs> and reads as a missing
  // file much later, during prebuild.
  if (isAbsolute(certificatePath)) {
    throw new Error(
      "EXPO_UPDATES_CODE_SIGNING_CERTIFICATE must be relative to apps/mobile " +
        `(Expo joins it onto the project root); got "${certificatePath}".`,
    );
  }
  if (!existsSync(join(__dirname, certificatePath))) {
    throw new Error(
      `EXPO_UPDATES_CODE_SIGNING_CERTIFICATE points at ${certificatePath}, ` +
        "which does not exist under apps/mobile. Commit the public " +
        "certificate (README: OTA update code signing); the private key " +
        "never goes in the repo.",
    );
  }

  return {
    codeSigningCertificate: certificatePath,
    codeSigningMetadata: {
      // Names which key in the certificate chain signed the manifest, so a key
      // can be rotated without invalidating binaries already in the field.
      keyid: (process.env.EXPO_UPDATES_CODE_SIGNING_KEY_ID || "").trim() || "main",
      alg: CODE_SIGNING_ALG,
    },
  };
}

/**
 * Development is the one profile that may poll unsigned: those builds load
 * their JS from Metro, the channel is a convenience, and requiring a
 * certificate would put a pipeline secret in the path of `expo start`.
 *
 * Everything else — including an unrecognised or unset profile — must sign.
 * Defaulting the unknown case to "signing required" is deliberate: the failure
 * we are protecting against is a release build that quietly resolved to the
 * permissive branch.
 */
function requiresSignedUpdates(profile) {
  return profile !== "development";
}

/**
 * The EAS Update endpoint for this project.
 *
 * Deliberately DERIVED from the project id rather than written into app.json:
 * the id itself is env-supplied (it differs between the OSS checkout and the
 * release pipeline), and an `updates.url` pointing at the wrong project is
 * worse than none at all — the client would poll a manifest that never matches
 * its runtime version and silently never update, which looks identical to
 * "updates are working, there is nothing new".
 *
 * With no project id configured the whole `updates` block is omitted, so a
 * local build simply has no update channel instead of a broken one.
 */
function updatesConfig(easProjectId) {
  if (!easProjectId) return {};

  const codeSigning = codeSigningFromEnv();
  const profile = buildProfileFromEnv();
  if (!codeSigning && requiresSignedUpdates(profile)) {
    throw new Error(
      [
        "Refusing to configure an UNSIGNED EAS Update channel for build " +
          `profile "${profile || "<unset>"}".`,
        "",
        "An update channel with no expo-updates code signing makes a leaked " +
          "EXPO_TOKEN equivalent to arbitrary code execution on every " +
          "install: anyone holding it can publish JS that the app fetches and " +
          "runs, with no store review in the way.",
        "",
        "Set EXPO_UPDATES_CODE_SIGNING_CERTIFICATE to the committed public " +
          "certificate's path relative to apps/mobile, certs/postwave-updates.pem " +
          "(and EXPO_UPDATES_CODE_SIGNING_KEY_ID if the key is not 'main'); " +
          "mobile-release.yml and eas.json's preview and production profiles " +
          "already do. If the pair does not exist yet, generate it OUTSIDE " +
          "the repo and commit only the certificate " +
          "(README: OTA update code signing):",
        "",
        "  npx expo-updates codesigning:generate \\",
        "    --key-output-directory <outside-the-repo>/keys \\",
        "    --certificate-output-directory <outside-the-repo>/certs \\",
        "    --certificate-validity-duration-years 10 \\",
        "    --certificate-common-name Moosewave",
        "  cp <outside-the-repo>/certs/certificate.pem certs/postwave-updates.pem",
        "",
        "The certificate is public and ships inside the binary. The PRIVATE " +
          "key never enters this repo, eas.json or an EAS build environment: " +
          "its custodian keeps it apart from EXPO_TOKEN and uses it only for " +
          "`eas update --private-key-path`, and binaries already in the field " +
          "will reject anything it did not sign.",
        "",
        "There is no unsigned escape hatch on purpose: a channel that falls " +
          "back to unsigned looks exactly like one that works.",
      ].join("\n"),
    );
  }

  return {
    updates: {
      url: `https://u.expo.dev/${easProjectId}`,
      // A JS hotfix must never land on a binary whose native modules differ.
      // `runtimeVersion.policy: "appVersion"` (app.json) ties each update to
      // expo.version, and NOTHING bumps that version when a native dependency
      // is added: the bump is a manual obligation. It is enforced only for
      // store submissions, which scripts/validate-release-version.mjs refuses
      // unless they are built from a mobile-v<expo.version> tag. Publish an
      // OTA update from that release tag's hotfix line, never from main, whose
      // native surface may already have moved past the binaries in the field.
      fallbackToCacheTimeout: 0,
      ...(codeSigning ?? {}),
    },
  };
}

module.exports = ({ config }) => {
  const appleTeamId = appleTeamIdFromEnv();
  const easProjectId = easProjectIdFromEnv();
  const expoOwner = expoOwnerFromEnv();
  const googleServicesFile = googleServicesFileFromEnv();
  const configuredEas = config.extra?.eas ?? {};

  return {
    ...config,
    ...(expoOwner ? { owner: expoOwner } : {}),
    ...updatesConfig(easProjectId),
    extra: {
      ...config.extra,
      ...(easProjectId
        ? { eas: { ...configuredEas, projectId: easProjectId } }
        : {}),
    },
    ios: {
      ...config.ios,
      ...(appleTeamId ? { appleTeamId } : {}),
    },
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
