import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { storeUrlsForPlatform } from "../src/lib/upgradeRequired.ts";

const require = createRequire(import.meta.url);
const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(mobileRoot, "scripts", "validate-production-env.mjs");
const commit = "a".repeat(40);

const scratchDirs = [];
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function readAppJson() {
  return JSON.parse(readFileSync(join(mobileRoot, "app.json"), "utf8"));
}

function productionEnv(overrides = {}) {
  return {
    ...process.env,
    // The EAS worker's own markers must not leak in from the caller's shell.
    // Cases that simulate the worker set them explicitly.
    EAS_BUILD: "",
    EAS_BUILD_GIT_COMMIT_HASH: "",
    EAS_BUILD_PROFILE: "production",
    EAS_BUILD_PLATFORM: "android",
    MATRIX_PLATFORM: "android",
    EXPO_PUBLIC_API_URL: "https://api.moosewave.com",
    EXPO_PUBLIC_APP_URL: "https://app.moosewave.com",
    EXPO_PUBLIC_BUILD_PROFILE: "production",
    EXPO_PUBLIC_SENTRY_DSN_MOBILE:
      "https://0123456789abcdef@sentry.example.com/42",
    EXPO_PUBLIC_POSTWAVE_RELEASE: commit,
    EXPO_PUBLIC_POSTWAVE_ENV: "production",
    EXPO_PUBLIC_POSTHOG_KEY: "phc_fixture_key_for_validation",
    EXPO_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    EXPO_PUBLIC_EAS_PROJECT_ID: "123e4567-e89b-12d3-a456-426614174000",
    // Added when unsigned OTA channels became a refusal rather than a warning:
    // app.config.js throws without it, so a "structurally valid production
    // environment" has to carry it or it is not one.
    EXPO_UPDATES_CODE_SIGNING_CERTIFICATE: "certs/updates-signing.pem",
    EXPO_OWNER: "postwave",
    SENTRY_AUTH_TOKEN: "fixture-token",
    SENTRY_ORG: "postwave",
    SENTRY_PROJECT: "postwave-mobile",
    ...overrides,
  };
}

function run(overrides = {}) {
  return spawnSync(process.execPath, [validator], {
    cwd: mobileRoot,
    env: productionEnv(overrides),
    encoding: "utf8",
  });
}

describe("validate-production-env.mjs", () => {
  it("accepts a structurally valid production Android environment", () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("production release env preflight passed");
  });

  it.each([
    [
      "EXPO_PUBLIC_API_URL",
      "https://api.moosewave.com.evil.example",
      "approved origin https://api.moosewave.com",
    ],
    [
      "EXPO_PUBLIC_APP_URL",
      "http://app.moosewave.com",
      "EXPO_PUBLIC_APP_URL must use HTTPS",
    ],
    [
      "EXPO_PUBLIC_POSTHOG_HOST",
      "https://us.i.posthog.com/capture",
      "must be an origin without a path",
    ],
    [
      "EXPO_PUBLIC_SENTRY_DSN_MOBILE",
      "not-a-dsn",
      "must be a valid Sentry DSN",
    ],
    [
      "EXPO_PUBLIC_SENTRY_DSN_MOBILE",
      "https://public:secret@sentry.example.com/42",
      "must be a public HTTPS Sentry DSN",
    ],
    ["EXPO_PUBLIC_EAS_PROJECT_ID", "not-a-uuid", "must be a canonical UUID"],
    ["EXPO_OWNER", "not an owner", "must be the Expo account"],
    [
      "EXPO_PUBLIC_POSTWAVE_RELEASE",
      "not-a-commit",
      "must be the lowercase 40- or 64-character Git commit hash",
    ],
  ])("rejects malformed %s", (name, value, expectedError) => {
    const result = run({ [name]: value });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expect(result.stdout).not.toContain("preflight passed");
  });

  it("requires a valid Apple Team ID for an iOS production build", () => {
    const result = run({
      EAS_BUILD_PLATFORM: "ios",
      MATRIX_PLATFORM: "ios",
      EXPO_APPLE_TEAM_ID: "invalid",
      APPLE_TEAM_ID: "",
      // Present and valid, so the Team ID is the only thing wrong.
      EXPO_PUBLIC_IOS_APP_STORE_ID: "1234567890",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a 10-character Apple Team ID");
  });
});

/**
 * The release-env preflight is the chokepoint that names a missing production
 * variable in one clean line, before `eas build` starts.
 *
 * `app.config.js` refuses to configure an EAS Update channel without a code
 * signing certificate, because an unsigned OTA channel makes a leaked
 * EXPO_TOKEN arbitrary code execution on every install. That refusal is a
 * throw during config resolution — so without this entry the preflight passed
 * green and the pipeline died one step later inside `eas build`, as a stack
 * trace rather than as "Missing required production env: ...".
 */
describe("the OTA code-signing certificate is a production requirement", () => {
  const source = readFileSync(
    new URL("./validate-production-env.mjs", import.meta.url),
    "utf8",
  );

  it("names the certificate variable in the required list", () => {
    // Read the array itself, not the whole file, so a mention inside a comment
    // cannot satisfy this.
    const list = source.slice(
      source.indexOf("const required = ["),
      source.indexOf("];", source.indexOf("const required = [")),
    );
    expect(list).toContain("EXPO_UPDATES_CODE_SIGNING_CERTIFICATE");
  });

  it("is the same variable app.config.js actually reads", () => {
    // Vacuity floor: if app.config.js renames it, requiring the old name would
    // block releases for a variable nothing consumes.
    const config = readFileSync(
      new URL("../app.config.js", import.meta.url),
      "utf8",
    );
    expect(config).toContain("EXPO_UPDATES_CODE_SIGNING_CERTIFICATE");
  });
});

/**
 * PO-3. `orientation: "portrait"` locks iPhone only. With supportsTablet on and
 * no requireFullScreen, prebuild writes all four
 * UISupportedInterfaceOrientations~ipad and UIRequiresFullScreen=false, so the
 * iPad build rotates and multitasks while the preflight reported the portrait
 * lock as enforced.
 */
describe("the iPad portrait lock is real, not just asserted", () => {
  /**
   * The Info.plist a clean prebuild starts from. ios/ is gitignored, so EAS
   * and the native-smoke job both prebuild from expo/template.tgz, the default
   * @expo/cli resolves. Starting there matters: requireFullScreen leaves an
   * existing ~ipad key alone, so a template that shipped one with landscape
   * would defeat the lock.
   */
  function templateInfoPlist() {
    const template = require.resolve("expo/template.tgz");
    const entry = spawnSync("tar", ["-tzf", template], { encoding: "utf8" })
      .stdout.split("\n")
      .find((name) => /\/ios\/[^/]+\/Info\.plist$/.test(name));
    expect(entry, "no ios Info.plist in expo/template.tgz").toBeTruthy();
    const xml = spawnSync("tar", ["-xzOf", template, entry], {
      encoding: "utf8",
    }).stdout;
    const plist = createRequire(
      createRequire(require.resolve("expo/config-plugins")).resolve(
        "@expo/config-plugins",
      ),
    )("@expo/plist").default;
    return plist.parse(xml);
  }

  it("the iPad build honours the portrait lock the preflight asserts", () => {
    const { IOSConfig } = require("expo/config-plugins");
    const { expo } = readAppJson();
    // The two Info.plist mods prebuild runs for this, fed the real app.json.
    const plist = IOSConfig.RequiresFullScreen.setRequiresFullScreen(
      expo,
      IOSConfig.Orientation.setOrientation(expo, templateInfoPlist()),
    );
    const ipadOrientations =
      plist["UISupportedInterfaceOrientations~ipad"] ??
      plist.UISupportedInterfaceOrientations;

    // Vacuity floor: the question only exists while iPad is supported.
    expect(expo.ios.supportsTablet).toBe(true);
    expect(plist.UIRequiresFullScreen).toBe(true);
    expect(ipadOrientations.length).toBeGreaterThan(0);
    expect(ipadOrientations.filter((o) => /Landscape/.test(o))).toEqual([]);
  });

  it("refuses a tablet build with no iPad portrait lock", () => {
    // The validator reads ../app.json relative to itself, so a copy beside a
    // modified app.json tests the real script against a config it has not seen.
    const dir = scratchDir("pw-preflight-ipad-");
    mkdirSync(join(dir, "scripts"));
    const copied = join(dir, "scripts", "validate-production-env.mjs");
    copyFileSync(validator, copied);
    const runCopy = () =>
      spawnSync(process.execPath, [copied], {
        cwd: dir,
        env: productionEnv(),
        encoding: "utf8",
      });

    // Control: the relocated copy passes with the real app.json.
    writeFileSync(join(dir, "app.json"), JSON.stringify(readAppJson()));
    const control = runCopy();
    expect(control.status, control.stderr).toBe(0);

    const unlocked = readAppJson();
    delete unlocked.expo.ios.requireFullScreen;
    writeFileSync(join(dir, "app.json"), JSON.stringify(unlocked));
    const result = runCopy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requireFullScreen");
    expect(result.stdout).not.toContain("preflight passed");
  });
});

/**
 * PO-4. On Android, expo-notifications gets its device token from Firebase
 * Cloud Messaging, which needs a default FirebaseApp. That exists only when the
 * google-services Gradle plugin runs, and @expo/config-plugins applies it only
 * when expo.android.googleServicesFile is set. Without it every Play build
 * ships with push registration that rejects on every device.
 */
describe("Android push is wired to Firebase on the EAS worker", () => {
  function googleServicesFixture(packageNames) {
    const file = join(scratchDir("pw-google-services-"), "google-services.json");
    writeFileSync(
      file,
      JSON.stringify({
        project_info: {
          project_number: "000000000000",
          project_id: "postwave-fixture",
        },
        client: packageNames.map((packageName, index) => ({
          client_info: {
            mobilesdk_app_id: `1:000000000000:android:${String(index).padStart(16, "0")}`,
            android_client_info: { package_name: packageName },
          },
        })),
        configuration_version: "1",
      }),
    );
    return file;
  }

  // The eas-build-pre-install run: EAS sets EAS_BUILD, and leaving
  // EAS_BUILD_GIT_COMMIT_HASH empty keeps the set-env calls out of the way.
  const runOnEasWorker = (overrides) =>
    run({ EAS_BUILD: "true", EAS_BUILD_GIT_COMMIT_HASH: "", ...overrides });

  it("refuses an Android production EAS build without Firebase config", () => {
    const result = runOnEasWorker({ GOOGLE_SERVICES_JSON: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GOOGLE_SERVICES_JSON");
    expect(result.stdout).not.toContain("preflight passed");
  });

  it("refuses a google-services.json registered to a different Android package", () => {
    const result = runOnEasWorker({
      GOOGLE_SERVICES_JSON: googleServicesFixture(["com.example.other"]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("com.moosewave.app");
    expect(result.stdout).not.toContain("preflight passed");
  });

  it.each([
    [
      "a path that does not exist",
      () => join(scratchDir("pw-google-services-"), "google-services.json"),
      "does not exist",
    ],
    [
      "a file that is not JSON",
      () => {
        const file = join(scratchDir("pw-google-services-"), "google-services.json");
        writeFileSync(file, "not json");
        return file;
      },
      "is not valid JSON",
    ],
  ])("refuses GOOGLE_SERVICES_JSON pointing at %s", (_label, makePath, message) => {
    const result = runOnEasWorker({ GOOGLE_SERVICES_JSON: makePath() });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GOOGLE_SERVICES_JSON");
    expect(result.stderr).toContain(message);
  });

  it("accepts a google-services.json with a client for com.moosewave.app", () => {
    const result = runOnEasWorker({
      GOOGLE_SERVICES_JSON: googleServicesFixture([
        "com.example.other",
        "com.moosewave.app",
      ]),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("production release env preflight passed");
  });

  it("asks neither the GitHub runner nor an iOS build for Android Firebase config", () => {
    // The runner's preflight never sees the worker's file variable, and iOS
    // gets its push token from APNs.
    const runner = run({ GOOGLE_SERVICES_JSON: "" });
    expect(runner.status, runner.stderr).toBe(0);

    const ios = runOnEasWorker({
      EAS_BUILD_PLATFORM: "ios",
      MATRIX_PLATFORM: "ios",
      EXPO_APPLE_TEAM_ID: "ABCDE12345",
      EXPO_PUBLIC_IOS_APP_STORE_ID: "1234567890",
      GOOGLE_SERVICES_JSON: "",
    });
    expect(ios.status, ios.stderr).toBe(0);
  });

  /**
   * A preview build is the internal APK the Android push device pass runs on,
   * so it needs Firebase as much as a Play build does. The worker hands it only
   * the preview profile's env, none of the production variables the rest of
   * the preflight requires, so the child sees that and nothing else from this
   * process but PATH and HOME.
   */
  const easProfiles = JSON.parse(
    readFileSync(join(mobileRoot, "eas.json"), "utf8"),
  ).build;
  const runOnWorkerAs = (buildProfile, overrides = {}) =>
    spawnSync(process.execPath, [validator], {
      cwd: mobileRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EAS_BUILD: "true",
        EAS_BUILD_PROFILE: buildProfile,
        EAS_BUILD_PLATFORM: "android",
        ...easProfiles[buildProfile].env,
        ...overrides,
      },
      encoding: "utf8",
    });

  it("refuses an Android preview EAS build without Firebase config", () => {
    const result = runOnWorkerAs("preview");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[postwave-mobile] preview release env preflight failed.",
    );
    expect(result.stderr).toContain("GOOGLE_SERVICES_JSON is not set");
    expect(result.stderr).toContain("production and preview environments");
    expect(result.stdout).not.toContain("preflight skipped");
  });

  it("refuses a preview google-services.json registered to a different Android package", () => {
    const result = runOnWorkerAs("preview", {
      GOOGLE_SERVICES_JSON: googleServicesFixture(["com.example.other"]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GOOGLE_SERVICES_JSON has no Android client for com.moosewave.app (found: com.example.other)",
    );
    expect(result.stdout).not.toContain("preflight skipped");
  });

  it("accepts an Android preview EAS build with a client for com.moosewave.app, and still skips the production env", () => {
    const result = runOnWorkerAs("preview", {
      GOOGLE_SERVICES_JSON: googleServicesFixture(["com.moosewave.app"]),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "[postwave-mobile] Android Firebase config preflight passed: GOOGLE_SERVICES_JSON has a client for com.moosewave.app.",
    );
    // The production-only requirements stay production-only.
    expect(result.stdout).toContain(
      'release env preflight skipped for profile "preview".',
    );
    expect(result.stderr).toBe("");
  });

  it("asks a development build, an iOS preview build, and a preview run off the worker for no Firebase config", () => {
    const outcomes = Object.fromEntries(
      [
        ["development on the worker", runOnWorkerAs("development")],
        [
          "iOS preview on the worker",
          runOnWorkerAs("preview", { EAS_BUILD_PLATFORM: "ios" }),
        ],
        ["preview off the worker", runOnWorkerAs("preview", { EAS_BUILD: "" })],
      ].map(([label, result]) => [
        label,
        { status: result.status, stderr: result.stderr, stdout: result.stdout },
      ]),
    );

    expect(outcomes).toEqual({
      "development on the worker": {
        status: 0,
        stderr: "",
        stdout:
          '[postwave-mobile] release env preflight skipped for profile "development".\n',
      },
      "iOS preview on the worker": {
        status: 0,
        stderr: "",
        stdout:
          '[postwave-mobile] release env preflight skipped for profile "preview".\n',
      },
      "preview off the worker": {
        status: 0,
        stderr: "",
        stdout:
          '[postwave-mobile] release env preflight skipped for profile "preview".\n',
      },
    });
  });

  /** Resolves app.config.js the way Expo does, in a clean process. */
  function resolveAppConfig(env) {
    const script = `
      const appJson = require(${JSON.stringify(join(mobileRoot, "app.json"))});
      const configure = require(${JSON.stringify(join(mobileRoot, "app.config.js"))});
      const { AndroidConfig } = require("expo/config-plugins");
      const resolved = configure({ config: appJson.expo });
      const appBuildGradle = AndroidConfig.GoogleServices.applyPlugin(
        resolved,
        "apply plugin: 'com.android.application'",
      );
      process.stdout.write(JSON.stringify({ android: resolved.android, appBuildGradle }));
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: mobileRoot,
      // No project id, so the signed-updates block stays out of the way.
      env: { ...process.env, EXPO_PUBLIC_EAS_PROJECT_ID: "", ...env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it("app.config.js hands GOOGLE_SERVICES_JSON to the google-services Gradle plugin", () => {
    const file = googleServicesFixture(["com.moosewave.app"]);
    const { android, appBuildGradle } = resolveAppConfig({
      GOOGLE_SERVICES_JSON: file,
    });

    expect(android.googleServicesFile).toBe(file);
    // The rest of the android block survives the merge.
    expect(android.package).toBe("com.moosewave.app");
    expect(android.intentFilters).toEqual(readAppJson().expo.android.intentFilters);
    expect(appBuildGradle).toContain("com.google.gms.google-services");
  });

  it.each([["unset", ""], ["blank", "   "]])(
    "app.config.js leaves Firebase out when GOOGLE_SERVICES_JSON is %s, so a secret-free prebuild still works",
    (_label, value) => {
      const { android, appBuildGradle } = resolveAppConfig({
        GOOGLE_SERVICES_JSON: value,
      });

      expect(android.googleServicesFile).toBeUndefined();
      expect(android.package).toBe("com.moosewave.app");
      expect(appBuildGradle).not.toContain("com.google.gms.google-services");
    },
  );
});

/**
 * PO-7. expo-camera and expo-image-picker both write NSCameraUsageDescription,
 * and expo-image-picker also writes NSMicrophoneUsageDescription with a generic
 * default unless its options say `microphonePermission: false`. Mods for the
 * same Info.plist run in REVERSE registration order, so the plugin listed
 * earlier in app.json writes last and wins. The shipped plist had no microphone
 * prompt, and had the QR-only camera prompt, only because of where the two
 * plugins happened to sit. Swap them and the build asks for a microphone the
 * app never uses and describes the camera by its other use.
 */
describe("the camera and microphone prompts do not depend on plugin order", () => {
  const { withPlugins, compileModsAsync } = require("expo/config-plugins");
  const pluginModule = (name) => {
    const loaded = require(`${name}/app.plugin.js`);
    return loaded.default ?? loaded;
  };
  const pluginOptions = (expo, name) =>
    expo.plugins.find((p) => Array.isArray(p) && p[0] === name)?.[1] ?? {};

  /**
   * The iOS Info.plist the real plugins write, fed their real app.json
   * options, registered in `order`. The project root is a scratch directory so
   * a local, gitignored ios/ from an earlier prebuild can never be read instead.
   */
  async function compileInfoPlist(order, seed) {
    const { expo } = readAppJson();
    const projectRoot = scratchDir("pw-plist-order-");
    let config = {
      name: expo.name,
      slug: expo.slug,
      ios: { infoPlist: { ...seed } },
      android: {},
      _internal: { projectRoot },
    };
    config = withPlugins(
      config,
      order.map((name) => [pluginModule(name), pluginOptions(expo, name)]),
    );
    config = await compileModsAsync(config, {
      projectRoot,
      platforms: ["ios"],
      introspect: true,
      assertMissingModProviders: false,
    });
    return config.ios.infoPlist;
  }

  const appJsonCameraPurpose = () =>
    readAppJson().expo.ios.infoPlist.NSCameraUsageDescription;

  it.each([
    ["expo-camera before expo-image-picker", ["expo-camera", "expo-image-picker"]],
    ["expo-image-picker before expo-camera", ["expo-image-picker", "expo-camera"]],
  ])(
    "listing %s ships no microphone prompt and the app.json camera prompt",
    async (_label, order) => {
      // Seeded the way prebuild seeds it: app.json's ios.infoPlist first.
      const plist = await compileInfoPlist(order, readAppJson().expo.ios.infoPlist);

      expect(plist.NSMicrophoneUsageDescription).toBeUndefined();
      expect(plist.NSCameraUsageDescription).toBe(appJsonCameraPurpose());
    },
  );

  it.each(["expo-camera", "expo-image-picker"])(
    "%s on its own writes that same camera prompt and no microphone prompt",
    async (name) => {
      // Empty seed: whatever is in the plist, the plugin under test wrote it.
      // This is also the floor that keeps the order test honest — a plugin
      // loader that silently did nothing would leave the camera key unset here.
      const plist = await compileInfoPlist([name], {});

      expect(plist.NSCameraUsageDescription).toBe(appJsonCameraPurpose());
      expect(plist.NSMicrophoneUsageDescription).toBeUndefined();
    },
  );

  // The preflight reads the same app.json, so the same two rules are enforced
  // on the release pipeline, not only in this suite.
  function runPreflightAgainst(appJson) {
    const dir = scratchDir("pw-preflight-camera-");
    mkdirSync(join(dir, "scripts"));
    const copied = join(dir, "scripts", "validate-production-env.mjs");
    copyFileSync(validator, copied);
    writeFileSync(join(dir, "app.json"), JSON.stringify(appJson));
    return spawnSync(process.execPath, [copied], {
      cwd: dir,
      env: productionEnv(),
      encoding: "utf8",
    });
  }
  const withPluginOptions = (name, patch) => {
    const appJson = readAppJson();
    const tuple = appJson.expo.plugins.find(
      (p) => Array.isArray(p) && p[0] === name,
    );
    tuple[1] = patch(tuple[1] ?? {});
    return appJson;
  };

  it("the preflight passes the real app.json (control)", () => {
    const result = runPreflightAgainst(readAppJson());
    expect(result.status, result.stderr).toBe(0);
  });

  it("the preflight refuses an image picker that would write a microphone prompt", () => {
    const result = runPreflightAgainst(
      withPluginOptions("expo-image-picker", (options) => {
        const rest = { ...options };
        delete rest.microphonePermission;
        return rest;
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expo-image-picker");
    expect(result.stderr).toContain("microphonePermission");
    expect(result.stdout).not.toContain("preflight passed");
  });

  it.each(["expo-camera", "expo-image-picker"])(
    "the preflight refuses an %s camera prompt that differs from ios.infoPlist",
    (name) => {
      const result = runPreflightAgainst(
        withPluginOptions(name, (options) => ({
          ...options,
          cameraPermission: "Moosewave uses the camera.",
        })),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name} cameraPermission`);
      expect(result.stderr).toContain("NSCameraUsageDescription");
      expect(result.stdout).not.toContain("preflight passed");
    },
  );
});

/**
 * PO-9. UpgradeRequiredScreen sends a below-floor iOS build to the App Store
 * listing for EXPO_PUBLIC_IOS_APP_STORE_ID, and to an App Store search page
 * when the value is missing or is not an id storeUrlsForPlatform accepts.
 * Nothing supplied the variable and the preflight never asked for it, so every
 * forced upgrade on iOS opened a search page instead of the app.
 */
describe("an iOS production build carries the App Store ID the upgrade screen opens", () => {
  const appStoreId = "1234567890";
  const runIos = (overrides = {}) =>
    run({
      EAS_BUILD_PLATFORM: "ios",
      MATRIX_PLATFORM: "ios",
      EXPO_APPLE_TEAM_ID: "ABCDE12345",
      APPLE_TEAM_ID: "",
      EXPO_PUBLIC_IOS_APP_STORE_ID: appStoreId,
      ...overrides,
    });

  it.each([["unset", ""], ["blank", "   "]])(
    "refuses an iOS production build with EXPO_PUBLIC_IOS_APP_STORE_ID %s",
    (_label, value) => {
      const result = runIos({ EXPO_PUBLIC_IOS_APP_STORE_ID: value });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Missing required production env: EXPO_PUBLIC_IOS_APP_STORE_ID",
      );
      expect(result.stderr).toContain("ASC_APP_ID");
      expect(result.stdout).not.toContain("preflight passed");
    },
  );

  it("refuses an App Store URL pasted where the numeric id belongs", () => {
    const result = runIos({
      EXPO_PUBLIC_IOS_APP_STORE_ID: `https://apps.apple.com/app/id${appStoreId}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "EXPO_PUBLIC_IOS_APP_STORE_ID must be the app's numeric Apple ID",
    );
    expect(result.stdout).not.toContain("preflight passed");
  });

  it("accepts an iOS production build with a numeric App Store ID", () => {
    const result = runIos();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("production release env preflight passed");
  });

  it("asks an Android production build for no App Store ID", () => {
    const result = run({ EXPO_PUBLIC_IOS_APP_STORE_ID: "" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("production release env preflight passed");
  });

  it("accepts exactly the values the upgrade screen turns into the app's listing", () => {
    const candidates = [
      "",
      "12345",
      "123456",
      appStoreId,
      ` ${appStoreId} `,
      "123456789012",
      "1234567890123",
      `id${appStoreId}`,
      "12345 67890",
      // An Apple Team ID pasted into the wrong variable.
      "ABCDE12345",
    ];
    const opensListing = (value) =>
      storeUrlsForPlatform("ios", { iosAppStoreId: value })[0] ===
      `itms-apps://apps.apple.com/app/id${value.trim()}`;
    const screen = Object.fromEntries(
      candidates.map((value) => [value, opensListing(value)]),
    );
    const preflight = Object.fromEntries(
      candidates.map((value) => [
        value,
        runIos({ EXPO_PUBLIC_IOS_APP_STORE_ID: value }).status === 0,
      ]),
    );

    // Vacuity floor: the table has to contain both outcomes, or agreement
    // would prove nothing about where the line is drawn.
    expect(Object.values(screen)).toContain(true);
    expect(Object.values(screen)).toContain(false);
    expect(preflight).toEqual(screen);
  });

  /** GitHub environment variables reach a step only through its env block. */
  function stepBlock(workflow, name) {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    expect(start, `no "${name}" step in mobile-release.yml`).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start);
    const next = rest.indexOf("\n      - name: ", 1);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it.each([
    ["Validate production runtime env", "pnpm run release:preflight"],
    ["EAS Build (production)", "eas build"],
    ["Expo export (diagnostic, non-store artifact)", "expo export"],
  ])(
    "mobile-release.yml hands the GitHub variable to the %s step",
    (step, command) => {
      const workflow = readFileSync(
        join(mobileRoot, "..", "..", ".github", "workflows", "mobile-release.yml"),
        "utf8",
      );
      const block = stepBlock(workflow, step);
      const values = [
        ...block.matchAll(/^ {10}EXPO_PUBLIC_IOS_APP_STORE_ID: (.*)$/gm),
      ].map((match) => match[1].trim());

      // Vacuity floor: this is the step that runs the command in question.
      expect(block).toContain(command);
      expect(values).toEqual(["${{ vars.EXPO_PUBLIC_IOS_APP_STORE_ID }}"]);
    },
  );
});

/**
 * PO-1. The preflight requires EXPO_UPDATES_CODE_SIGNING_CERTIFICATE for every
 * production build, and app.config.js refuses to resolve an update channel
 * without it once EXPO_PUBLIC_EAS_PROJECT_ID is set. Nothing in the release
 * path set it: GitHub hands a step only the variables its job or step env
 * names, and eas.json's profiles did not name it either. Every release run
 * stopped at the preflight, and past that inside `eas build`.
 *
 * These cases read the workflow the way the runner does. A step sees the job
 * env plus its own env, and the child processes below see nothing else.
 */
describe("the release workflow supplies what the release gates require", () => {
  const repoRoot = join(mobileRoot, "..", "..");
  const workflow = require("yaml").parse(
    readFileSync(
      join(repoRoot, ".github", "workflows", "mobile-release.yml"),
      "utf8",
    ),
  );
  const eas = JSON.parse(readFileSync(join(mobileRoot, "eas.json"), "utf8"));
  const CERTIFICATE = "EXPO_UPDATES_CODE_SIGNING_CERTIFICATE";
  // The PUBLIC certificate the operator commits, and the only .pem the root
  // .gitignore lets through. Never certs/certificate.pem:
  // src/lib/easUpdateCodeSigning.test.ts relies on that path NOT existing.
  const COMMITTED_CERTIFICATE = "certs/postwave-updates.pem";
  const PREFLIGHT = "Validate production runtime env";
  const EAS_BUILD = "EAS Build (production)";
  const EXPORT = "Expo export (diagnostic, non-store artifact)";

  // One valid value per variable or secret the mobile-production environment
  // is expected to hold. A name missing here fails loudly rather than
  // resolving to "".
  const environmentFixture = {
    EXPO_TOKEN: "fixture-expo-token",
    APPLE_TEAM_ID: "ABCDE12345",
    EXPO_PUBLIC_SENTRY_DSN_MOBILE:
      "https://0123456789abcdef@sentry.example.com/42",
    EXPO_PUBLIC_POSTHOG_KEY: "phc_fixture_key_for_validation",
    EXPO_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    EXPO_PUBLIC_EAS_PROJECT_ID: "123e4567-e89b-12d3-a456-426614174000",
    EXPO_OWNER: "postwave",
    SENTRY_AUTH_TOKEN: "fixture-token",
    SENTRY_ORG: "postwave",
    SENTRY_PROJECT: "postwave-mobile",
    EXPO_PUBLIC_IOS_APP_STORE_ID: "1234567890",
  };

  function operandValue(operand, platform) {
    if (operand === "matrix.platform") return platform;
    if (operand === "github.sha") return commit;
    const literal = /^'([^']*)'$/.exec(operand);
    if (literal) return literal[1];
    const context = /^(?:vars|secrets)\.([A-Z0-9_]+)$/.exec(operand);
    if (context) {
      if (!Object.hasOwn(environmentFixture, context[1])) {
        throw new Error(`no environment fixture for ${operand}`);
      }
      return environmentFixture[context[1]];
    }
    throw new Error(
      `mobile-release.yml uses an expression this test cannot resolve: ${operand}`,
    );
  }

  /** The `${{ }}` shapes the build job uses: a || b || 'x', and x != ''. */
  function evaluate(expression, platform) {
    const comparison = /^(.+?)\s*!=\s*''$/.exec(expression);
    if (comparison) {
      return String(evaluate(comparison[1].trim(), platform) !== "");
    }
    for (const operand of expression.split("||").map((part) => part.trim())) {
      const value = operandValue(operand, platform);
      if (value) return value;
    }
    return "";
  }

  /** What GitHub hands the named build-job step: job env, then step env. */
  function stepEnv(stepName, platform) {
    const job = workflow.jobs.build;
    const step = job.steps.find((candidate) => candidate.name === stepName);
    expect(step, `no "${stepName}" step in the build job`).toBeDefined();
    return Object.fromEntries(
      Object.entries({ ...job.env, ...step.env }).map(([name, value]) => [
        name,
        String(value).replace(/\$\{\{([^}]*)\}\}/g, (_match, expression) =>
          evaluate(expression.trim(), platform),
        ),
      ]),
    );
  }

  /** A child env holding `env` and nothing from this process but PATH/HOME. */
  function isolatedEnv(env) {
    const base = { PATH: process.env.PATH, HOME: process.env.HOME };
    return Object.fromEntries(
      Object.entries({ ...base, ...env }).filter(([, value]) => value !== undefined),
    );
  }

  it.each(["ios", "android"])(
    "the %s preflight passes on exactly the env the workflow hands it",
    (platform) => {
      const result = spawnSync(process.execPath, [validator], {
        cwd: mobileRoot,
        env: isolatedEnv(stepEnv(PREFLIGHT, platform)),
        encoding: "utf8",
      });

      expect(result.stderr).not.toContain("Missing required production env");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("production release env preflight passed");
    },
  );

  it("hands one relative certificate path to every step and profile that resolves the config", () => {
    const sources = {
      "eas.json build.production.env": eas.build.production.env?.[CERTIFICATE],
      "eas.json build.preview.env": eas.build.preview.env?.[CERTIFICATE],
    };
    for (const platform of ["ios", "android"]) {
      for (const step of [PREFLIGHT, EAS_BUILD, EXPORT]) {
        sources[`${step} (${platform})`] = stepEnv(step, platform)[CERTIFICATE];
      }
    }

    // app.config.js rejects an absolute path: Expo joins it onto apps/mobile.
    expect(isAbsolute(COMMITTED_CERTIFICATE)).toBe(false);
    expect(sources).toEqual(
      Object.fromEntries(
        Object.keys(sources).map((source) => [source, COMMITTED_CERTIFICATE]),
      ),
    );
  });

  it("no ignore file on the way to the EAS worker drops the certificate", () => {
    // eas-cli 20.5.1 without cli.requireCommit copies the working tree through
    // the `ignore` library, and reads each .gitignore on its own: a child's
    // `!` exception cannot rescue a file a parent ignores. So every file on the
    // ancestor chain has to let it through independently. An .easignore
    // replaces the .gitignore files for eas-cli; checking it as well is a
    // superset, so it can only make this stricter.
    const createIgnore = require("ignore");
    const file = join(mobileRoot, COMMITTED_CERTIFICATE);
    const segments = relative(repoRoot, file).split(sep).slice(0, -1);
    const verdicts = {};
    for (let depth = 0; depth <= segments.length; depth += 1) {
      const dir = join(repoRoot, ...segments.slice(0, depth));
      for (const name of [".gitignore", ".easignore"]) {
        const rulesFile = join(dir, name);
        if (!existsSync(rulesFile)) continue;
        const rules = createIgnore().add(readFileSync(rulesFile, "utf8"));
        verdicts[relative(repoRoot, rulesFile).split(sep).join("/")] =
          rules.ignores(relative(dir, file).split(sep).join("/"));
      }
    }

    // Vacuity floor: both files that exist today were actually read.
    expect(Object.keys(verdicts)).toEqual(
      expect.arrayContaining([".gitignore", "apps/mobile/.gitignore"]),
    );
    expect(verdicts).toEqual(
      Object.fromEntries(Object.keys(verdicts).map((name) => [name, false])),
    );

    // The exception names that one PUBLIC file. Private keys wherever the
    // generator put them, and its default certificate.pem, stay ignored.
    const root = createIgnore().add(
      readFileSync(join(repoRoot, ".gitignore"), "utf8"),
    );
    for (const stillIgnored of [
      "apps/mobile/keys/private-key.pem",
      "apps/mobile/certs/private-key.pem",
      "apps/mobile/certs/certificate.pem",
    ]) {
      expect(root.ignores(stillIgnored), stillIgnored).toBe(true);
    }
  });

  /**
   * Resolves a COPY of app.config.js in a scratch directory, beside a
   * placeholder at the configured certificate path, in a process that sees
   * only `env`. app.config.js checks only that the file exists and records
   * its path, so the real certificate is not needed here.
   */
  function resolveUpdates(env) {
    const dir = scratchDir("pw-signed-updates-");
    copyFileSync(join(mobileRoot, "app.config.js"), join(dir, "app.config.js"));
    const certificate = env[CERTIFICATE];
    if (certificate && !isAbsolute(certificate)) {
      mkdirSync(dirname(join(dir, certificate)), { recursive: true });
      writeFileSync(
        join(dir, certificate),
        "-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n",
      );
    }
    const script = `
      const configure = require(${JSON.stringify(join(dir, "app.config.js"))});
      const { expo } = require(${JSON.stringify(join(mobileRoot, "app.json"))});
      process.stdout.write(JSON.stringify(configure({ config: expo }).updates ?? null));
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: dir,
      env: isolatedEnv(env),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  // eas-cli resolves the config on the runner with the profile env laid over
  // the step env; the worker sees only its EAS environment plus the profile.
  const onWorker = (profile) => ({
    EAS_BUILD: "true",
    EAS_BUILD_PROFILE: profile,
    EXPO_PUBLIC_EAS_PROJECT_ID: environmentFixture.EXPO_PUBLIC_EAS_PROJECT_ID,
    ...eas.build[profile].env,
  });
  it.each([
    [
      `the runner's ${EAS_BUILD} step`,
      (platform) => ({ ...stepEnv(EAS_BUILD, platform), ...eas.build.production.env }),
    ],
    [`the runner's ${EXPORT} step`, (platform) => stepEnv(EXPORT, platform)],
    ["the EAS worker's production build", () => onWorker("production")],
    ["the EAS worker's preview build", () => onWorker("preview")],
  ])("%s resolves a signed update channel", (_label, envFor) => {
    for (const platform of ["ios", "android"]) {
      const updates = resolveUpdates(envFor(platform));

      expect(updates?.url).toBe(
        `https://u.expo.dev/${environmentFixture.EXPO_PUBLIC_EAS_PROJECT_ID}`,
      );
      expect(updates?.codeSigningCertificate).toBe(COMMITTED_CERTIFICATE);
    }
  });
});
