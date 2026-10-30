/**
 * OTA configuration is only ever meaningful as a SET (NATIVE#3).
 *
 * `channel` in eas.json binds a build to an EAS Update branch, `updates.url` +
 * `runtimeVersion` in app.json tell the installed binary where to poll and what
 * it is compatible with, and none of it does anything without the `expo-updates`
 * package. The repo previously held one third of that set — two `channel` keys
 * and nothing else — which reads as "we ship hotfixes" while every JS fix in
 * fact waits on store review.
 *
 * This test does not decide whether the app should have OTA. It asserts the
 * three legs move together, in either direction, so the half-configured state
 * cannot come back silently.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function mobileJson(path: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), "utf8"),
  ) as Record<string, unknown>;
}

const pkg = mobileJson("package.json");
const eas = mobileJson("eas.json");
const app = mobileJson("app.json");

const deps = {
  ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
  ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
};
const otaInstalled = Object.hasOwn(deps, "expo-updates");

const buildProfiles = Object.entries(
  (eas.build as Record<string, Record<string, unknown>> | undefined) ?? {},
);
const profilesWithChannel = buildProfiles
  .filter(([, profile]) => typeof profile.channel === "string")
  .map(([name]) => name);

const expo = (app.expo as Record<string, unknown> | undefined) ?? {};

describe("EAS update configuration is all-or-nothing", () => {
  it("declares an update channel only when expo-updates can consume it", () => {
    expect(
      profilesWithChannel.length > 0,
      otaInstalled
        ? "expo-updates is installed but no eas.json build profile sets a channel — published updates would reach nothing"
        : `eas.json build profiles ${profilesWithChannel.join(", ")} declare an update channel, but expo-updates is not a dependency, so the channel is inert`,
    ).toBe(otaInstalled);
  });

  it("declares an updates url and runtimeVersion only when expo-updates is installed", () => {
    // `updates.url` legitimately lives in app.config.js rather than app.json:
    // it embeds the EAS project id, which is env-supplied and differs between
    // this checkout and the release pipeline. A url baked in for the WRONG
    // project is worse than none — the binary polls a manifest that never
    // matches its runtime version and silently never updates, which is
    // indistinguishable from "OTA works, there is nothing new". So accept
    // either home, and require only that one of them declares it.
    const dynamicConfig = readFileSync(
      resolve(process.cwd(), "app.config.js"),
      "utf8",
    );
    const declaresUpdates =
      Object.hasOwn(expo, "updates") || /\bupdates:\s*\{/.test(dynamicConfig);
    expect(
      declaresUpdates,
      otaInstalled
        ? "expo-updates is installed but neither app.json nor app.config.js declares an `updates` block — the binary would have nowhere to poll"
        : "an `updates` block is declared while expo-updates is not installed, so it is inert",
    ).toBe(otaInstalled);

    // runtimeVersion is STATIC — it must not depend on the environment, or two
    // builds of the same binary could disagree about which updates apply.
    expect(Object.hasOwn(expo, "runtimeVersion")).toBe(otaInstalled);
  });

  it("explains in eas.json why there is no channel while OTA is off", () => {
    if (otaInstalled) return;
    const comment = String(eas._updates_comment ?? "");
    expect(comment).toContain("expo-updates");
    // The server-side version floor is the only remaining enforcement, so the
    // file must point at it rather than leaving "no updates" unexplained.
    expect(comment).toContain("426");
  });
});

describe("the 426 version floor is handled regardless of OTA", () => {
  const sdkClient = readFileSync(
    resolve(process.cwd(), "src/api/sdkClient.ts"),
    "utf8",
  );
  const layout = readFileSync(
    resolve(process.cwd(), "app/_layout.tsx"),
    "utf8",
  );

  it("intercepts 426 on every transport the app uses", () => {
    // Two fetch wrappers exist (session + api-key); a 426 on either must reach
    // the store, or one auth mode silently shows raw SDK error strings.
    const intercepts = sdkClient.match(/interceptUpgradeRequired\(response\)/g);
    expect(intercepts?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(sdkClient).toContain("reportUpgradeRequired");
  });

  it("mounts the blocking screen above the navigation stack", () => {
    expect(layout).toContain("<UpgradeRequiredGate />");
  });
});
