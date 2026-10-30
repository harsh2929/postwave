/**
 * Config plugin: compile Moosewave App Intents (Siri Shortcuts) into the
 * main app target.
 *
 * App Intents + the AppShortcutsProvider must live in the main app binary
 * for the system to auto-register the shortcut phrases, so this can't be an
 * @bacons/apple-targets extension. Instead we:
 *   1. copy plugins/PostwaveAppIntents.swift into ios/<Project>/,
 *   2. add it to the main target's source build phase in the Xcode project, and
 *   3. raise that target's iOS deployment floor to the one the Swift needs.
 *
 * Idempotent: re-running prebuild won't add a duplicate file reference, and the
 * deployment floor is only ever raised, never lowered.
 */
const { withXcodeProject, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SWIFT_FILE = "PostwaveAppIntents.swift";

/**
 * The iOS floor PostwaveAppIntents.swift needs, enforced HERE because this is
 * the plugin that puts the file in the target (F02).
 *
 * `expo prebuild --clean` — which is what EAS runs — regenerates the app target
 * at Expo's template default, currently IPHONEOS_DEPLOYMENT_TARGET = 15.1.
 * App Intents (`LocalizedStringResource`, `IntentResult`, `AppShortcutsProvider`)
 * are iOS 16, so the target this plugin injects Swift into could not compile it:
 *
 *     error: 'LocalizedStringResource' is only available in iOS 16 or newer
 *
 * A clean prebuild therefore produced an Xcode project that failed to build, and
 * nothing in app.json said otherwise — there is no expo-build-properties plugin
 * and no ios.deploymentTarget key, so the checked-in configuration described a
 * project that could not exist. The requirement is kept next to the code that
 * creates it rather than in app.json for that reason: deleting this plugin
 * deletes the need, and adding another iOS-16 API to the Swift can never drift
 * away from the floor that allows it.
 *
 * The MAIN APP TARGET ONLY. targets/widget/expo-target.config.js declares its
 * own 17.0 (its `AppIntentConfiguration` widget needs it) and the share
 * extension its own 16.0; both are deliberate and neither is touched here.
 * CocoaPods keeps building the pods at the Podfile's platform — a dependency
 * built below its consumer's floor is fine, the reverse is not.
 */
const MIN_APP_DEPLOYMENT_TARGET = "16.0";

const COMMENT_KEY = /_comment$/u;

/** pbxproj values are sometimes quoted (`"15.1"`), sometimes bare (`15.1`). */
function unquote(value) {
  if (typeof value !== "string") return value;
  const match = /^"(.*)"$/su.exec(value);
  return match ? match[1] : value;
}

function targetBuildConfigurationList(project, targetName) {
  const targets = project.pbxNativeTargetSection?.() ?? {};
  for (const [key, target] of Object.entries(targets)) {
    if (COMMENT_KEY.test(key)) continue;
    if (!target || typeof target !== "object") continue;
    if (unquote(target.name) === targetName) return target.buildConfigurationList;
  }
  return undefined;
}

/**
 * Raise one target's IPHONEOS_DEPLOYMENT_TARGET to `minimum` across every build
 * configuration, and NEVER lower it — a target already at 17.0 keeps 17.0.
 *
 * Returns the names of the build configurations it changed, or `null` when the
 * target does not exist (which the caller reports, because a silently unraised
 * floor is a build failure minutes later in a log nobody reads).
 */
function raiseDeploymentTarget(project, targetName, minimum) {
  // parseFloat, not a semver compare: iOS deployment targets in a pbxproj are
  // "15.1"/"16.0"/"17.0" and a float orders those correctly. It would misread a
  // hypothetical "16.10" as below "16.2" — no such iOS floor exists, and this
  // reads a value Expo's own template writes.
  const floor = Number.parseFloat(minimum ?? MIN_APP_DEPLOYMENT_TARGET);
  const listKey = targetBuildConfigurationList(project, targetName);
  if (!listKey) return null;

  const list = (project.pbxXCConfigurationList?.() ?? {})[listKey];
  const configs = project.pbxXCBuildConfigurationSection?.() ?? {};
  const changed = [];
  for (const entry of list?.buildConfigurations ?? []) {
    const config = configs[entry?.value];
    if (!config || typeof config !== "object") continue;
    if (!config.buildSettings) config.buildSettings = {};
    const current = Number.parseFloat(
      unquote(config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET) ?? "",
    );
    // Idempotent by construction: the second prebuild sees 16.0 and stops.
    if (Number.isFinite(current) && current >= floor) continue;
    config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET =
      minimum ?? MIN_APP_DEPLOYMENT_TARGET;
    changed.push(unquote(config.name) ?? entry.value);
  }
  return changed;
}

function strictAppIntentsBuild() {
  return (
    process.env.POSTWAVE_STRICT_APP_INTENTS === "1" ||
    process.env.EAS_BUILD_PROFILE === "production"
  );
}

function reportAppIntentsIssue(message) {
  const full = `[withAppIntents] ${message}`;
  if (strictAppIntentsBuild()) {
    throw new Error(full);
  }
  // eslint-disable-next-line no-console
  console.warn(full);
}

function withAppIntentsSource(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const platformRoot = cfg.modRequest.platformProjectRoot; // ios/
      const projectName = cfg.modRequest.projectName; // e.g. Moosewave
      const src = path.join(projectRoot, "plugins", SWIFT_FILE);
      const destDir = path.join(platformRoot, projectName);
      const dest = path.join(destDir, SWIFT_FILE);
      if (!fs.existsSync(src)) {
        reportAppIntentsIssue(`${SWIFT_FILE} source is missing at ${src}`);
        return cfg;
      }
      if (!fs.existsSync(destDir)) {
        reportAppIntentsIssue(`iOS app group directory is missing at ${destDir}`);
        return cfg;
      }
      fs.copyFileSync(src, dest);
      return cfg;
    },
  ]);
}

function withAppIntentsXcode(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const relPath = `${projectName}/${SWIFT_FILE}`;

    // Runs BEFORE the already-referenced early return below: a non-clean
    // prebuild finds the file reference intact but can still be handed a
    // regenerated target whose floor is back at the template default.
    if (raiseDeploymentTarget(project, projectName) === null) {
      reportAppIntentsIssue(
        `main target "${projectName}" not found, so its iOS deployment target ` +
          `could not be raised to ${MIN_APP_DEPLOYMENT_TARGET}; ${SWIFT_FILE} ` +
          `will not compile`,
      );
    }

    // Skip if already referenced (idempotent across prebuilds).
    if (project.hasFile && project.hasFile(relPath)) {
      return cfg;
    }

    // CRITICAL: pin the source to the MAIN app target. @bacons/apple-targets
    // adds PostwaveWidget/PostwaveShare targets, so the "first" target is no
    // longer guaranteed to be the app — addSourceFile would otherwise attach
    // App Intents to an extension's Sources phase. App Intents +
    // AppShortcutsProvider must compile into the app binary to register.
    const mainTargetKey = project.findTargetKey(projectName);
    if (!mainTargetKey) {
      reportAppIntentsIssue(`main target "${projectName}" not found`);
      return cfg;
    }

    // Resolve the main app PBXGroup so the file lands in the right group.
    let groupKey;
    try {
      groupKey = project.findPBXGroupKey({ name: projectName });
    } catch {
      groupKey = undefined;
    }

    try {
      project.addSourceFile(relPath, { target: mainTargetKey }, groupKey);
    } catch (e) {
      reportAppIntentsIssue(`could not add ${relPath}: ${e}`);
    }
    return cfg;
  });
}

module.exports = function withAppIntents(config) {
  config = withAppIntentsSource(config);
  config = withAppIntentsXcode(config);
  return config;
};

// Exported for src/lib/appIntentsContract.test.ts, which drives the mutation
// against a pbxproj-shaped object rather than asserting on this file's text.
module.exports.raiseDeploymentTarget = raiseDeploymentTarget;
module.exports.MIN_APP_DEPLOYMENT_TARGET = MIN_APP_DEPLOYMENT_TARGET;
module.exports.SWIFT_FILE = SWIFT_FILE;
