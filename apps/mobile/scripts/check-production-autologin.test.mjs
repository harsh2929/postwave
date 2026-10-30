import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  autologinBuildVerdict,
  DEV_ONLY_ENV_KEYS,
} from "./check-production-autologin.mjs";

const LOADED = {
  EXPO_PUBLIC_DEV_AUTOLOGIN: "1",
  EXPO_PUBLIC_DEV_EMAIL: "example@example.invalid",
  EXPO_PUBLIC_DEV_PASSWORD: "not-a-real-password",
};

describe("autologinBuildVerdict", () => {
  it("blocks a production build that carries any dev credential", () => {
    const verdict = autologinBuildVerdict({
      ...LOADED,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders).toEqual(DEV_ONLY_ENV_KEYS);
  });

  it("names exactly the offending variables, one at a time", () => {
    for (const key of DEV_ONLY_ENV_KEYS) {
      const verdict = autologinBuildVerdict({
        EXPO_PUBLIC_BUILD_PROFILE: "production",
        [key]: "something",
      });
      expect(verdict.ok, `${key} must block the build`).toBe(false);
      expect(verdict.offenders).toEqual([key]);
    }
  });

  it("allows a clean production build", () => {
    expect(
      autologinBuildVerdict({ EXPO_PUBLIC_BUILD_PROFILE: "production" }).ok,
    ).toBe(true);
  });

  it("treats a present-but-blank variable as absent — nothing to leak", () => {
    expect(
      autologinBuildVerdict({
        EXPO_PUBLIC_BUILD_PROFILE: "production",
        EXPO_PUBLIC_DEV_PASSWORD: "   ",
      }).ok,
    ).toBe(true);
  });

  it("is not fooled by casing or padding on the profile", () => {
    for (const profile of ["PRODUCTION", "  Production  "]) {
      expect(
        autologinBuildVerdict({
          ...LOADED,
          EXPO_PUBLIC_BUILD_PROFILE: profile,
        }).ok,
        `profile ${JSON.stringify(profile)} must be treated as production`,
      ).toBe(false);
    }
  });

  it("leaves non-production builds alone — that is the whole point", () => {
    for (const profile of ["development", "preview", "staging", ""]) {
      expect(
        autologinBuildVerdict({
          ...LOADED,
          EXPO_PUBLIC_BUILD_PROFILE: profile,
        }).ok,
      ).toBe(true);
    }
  });
});

/**
 * The rule above is only worth having if something RUNS it.
 *
 * `devAutoSignIn.ts` calls this script "the belt to this fold's braces" —
 * the fold being the statically-foldable BUILD_PROFILE comparison that lets
 * the minifier delete the credential literals. But the script was wired into
 * nothing: it existed as an npm script that no pipeline invoked, so the code
 * documented two defences and shipped one.
 *
 * `validate-production-env.mjs`, the script that IS wired into
 * eas-build-pre-install, does not mention EXPO_PUBLIC_DEV_* at all, so it was
 * not covering this either.
 *
 * These assertions read package.json rather than trusting the comment.
 */
describe("the production-autologin guard is actually wired into a build", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  it("runs on the EAS release pipeline hook", () => {
    // eas-build-pre-install is the hook EAS runs before installing deps on a
    // release build — the script's own header says "run this in the release
    // pipeline ahead of any production export".
    expect(pkg.scripts["eas-build-pre-install"]).toContain(
      "check-production-autologin",
    );
  });

  it("still runs the production env validator on that hook too", () => {
    // Chaining must ADD a defence, not replace the existing one.
    expect(pkg.scripts["eas-build-pre-install"]).toContain(
      "validate-production-env",
    );
  });
});
