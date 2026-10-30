import { describe, expect, it } from "vitest";

import { mobileSecondaryRouteForPath } from "./mobileRouteManifest";

describe("mobileSecondaryRouteForPath prefers the most specific row", () => {
  it("resolves a nested route to its OWN row, not its parent's", () => {
    // Both /sms and /sms/suppressions declare rows. Returning the first prefix
    // match gave the opt-outs screen the inbox's policy. Both are exact-admin now,
    // but they own independent server route families and must stay independently
    // reviewable when either policy changes.
    const row = mobileSecondaryRouteForPath("/(tabs)/sms/suppressions");
    expect(row?.key).toBe("sms-suppressions");
    expect(row?.minimumRole).toBe("admin");
  });

  it("still resolves the parent path to the parent row", () => {
    expect(mobileSecondaryRouteForPath("/(tabs)/sms")?.key).toBe("sms");
  });

  it("resolves an unclaimed child to its nearest declared ancestor", () => {
    // A detail path with no row of its own must still inherit a policy rather
    // than resolving to nothing and being treated as ungated.
    expect(mobileSecondaryRouteForPath("/(tabs)/sms/+15552341111")?.key).toBe(
      "sms",
    );
  });
});
