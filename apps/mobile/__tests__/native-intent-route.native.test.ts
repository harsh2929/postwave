import { describe, expect, it } from "@jest/globals";

import { redirectSystemPath } from "../app/+native-intent";

describe("Expo Router native-intent module", () => {
  it("loads the convention module and delegates system URL rewriting", () => {
    expect(
      redirectSystemPath({
        path: "moosewave://sms-suppressions",
        initial: true,
      }),
    ).toBe("/(tabs)/sms/suppressions");
    expect(
      redirectSystemPath({
        path: "/(tabs)/dashboard",
        initial: false,
      }),
    ).toBe("/(tabs)/dashboard");
  });
});
