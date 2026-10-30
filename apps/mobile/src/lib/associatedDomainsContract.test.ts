/**
 * iOS associated-domains contract (NATIVE#30).
 *
 * `applinks:` was declared and `webcredentials:` was not, so iOS's credential
 * manager had no association with app.moosewave.com: the OS never offered to
 * SAVE the password after a successful sign-in, never offered to autofill it
 * on return, and a passkey could not be created at all — even though the
 * sign-in screen does its half correctly (autoComplete/textContentType on both
 * fields). The two entitlements are independent; adding one does not imply the
 * other.
 *
 * Locked here because the failure mode is invisible: nothing crashes, no test
 * goes red, the password prompt simply never appears, and the regression would
 * survive until someone reinstalled and noticed they had to type it again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const app = JSON.parse(
  readFileSync(join(process.cwd(), "app.json"), "utf8"),
) as {
  expo: {
    ios?: { associatedDomains?: string[]; bundleIdentifier?: string };
  };
};

const APP_HOST = "app.moosewave.com";

describe("iOS associated domains", () => {
  const domains = app.expo.ios?.associatedDomains ?? [];

  it("claims universal links for the app host", () => {
    expect(domains).toContain(`applinks:${APP_HOST}`);
  });

  it("claims web credentials so passwords and passkeys can be saved", () => {
    expect(domains).toContain(`webcredentials:${APP_HOST}`);
  });

  it("declares every entry with a recognised service prefix", () => {
    for (const entry of domains) {
      expect(entry, entry).toMatch(
        /^(applinks|webcredentials|activitycontinuation|appclips):[a-z0-9.-]+$/,
      );
    }
  });

  it("has no duplicate declarations", () => {
    expect(new Set(domains).size).toBe(domains.length);
  });
});
