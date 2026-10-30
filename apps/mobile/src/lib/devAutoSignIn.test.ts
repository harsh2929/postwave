import { describe, expect, it } from "vitest";

import { devAutoSignInCredentials } from "./devAutoSignIn";

/**
 * Every key set and valid — each test below removes exactly one thing.
 *
 * These values are FICTIONAL and must stay that way. Copying the real `.env`
 * in here would move the credentials from an ignored, untracked file into a
 * tracked one and undo the whole reason `.env` is ignored. Nothing in this
 * suite depends on the values matching any real environment.
 */
const FULL = {
  EXPO_PUBLIC_DEV_AUTOLOGIN: "1",
  EXPO_PUBLIC_API_URL: "http://10.0.0.1:8080",
  EXPO_PUBLIC_DEV_EMAIL: "example@example.invalid",
  EXPO_PUBLIC_DEV_PASSWORD: "not-a-real-password",
};

describe("devAutoSignInCredentials — the happy path", () => {
  it("returns all three values for an opted-in development build", () => {
    expect(devAutoSignInCredentials(FULL, "development")).toEqual({
      baseUrl: "http://10.0.0.1:8080",
      email: "example@example.invalid",
      password: "not-a-real-password",
    });
  });

  it("applies ONLY to 'development' — an allowlist, not a denylist", () => {
    // Refusing merely "production" failed open twice: BUILD_PROFILE falls back
    // to "development" when the variable is unset, and `preview` builds are
    // DISTRIBUTED to testers. Both must be refused.
    for (const profile of ["preview", "staging", "test", "", "  ", "dev"]) {
      expect(
        devAutoSignInCredentials(FULL, profile),
        `profile ${JSON.stringify(profile)} must not carry credentials`,
      ).toBeNull();
    }
  });

  it("tolerates casing and padding on the development profile itself", () => {
    expect(devAutoSignInCredentials(FULL, "DEVELOPMENT")).not.toBeNull();
    expect(devAutoSignInCredentials(FULL, "  development  ")).not.toBeNull();
  });

  it("trims the address and email but never the password", () => {
    const padded = devAutoSignInCredentials(
      {
        ...FULL,
        EXPO_PUBLIC_API_URL: "  http://10.0.0.1:8080  ",
        EXPO_PUBLIC_DEV_EMAIL: " example@example.invalid ",
        EXPO_PUBLIC_DEV_PASSWORD: " pad ded ",
      },
      "development",
    );
    expect(padded?.baseUrl).toBe("http://10.0.0.1:8080");
    expect(padded?.email).toBe("example@example.invalid");
    // Trimming a password turns a correct credential into a "wrong password"
    // that is this function's fault.
    expect(padded?.password).toBe(" pad ded ");
  });
});

describe("PRODUCTION refuses — a shipped app carries no credentials", () => {
  it("returns null even when every value is present and the flag is on", () => {
    expect(devAutoSignInCredentials(FULL, "production")).toBeNull();
  });

  it("is not fooled by casing or padding on the profile", () => {
    expect(devAutoSignInCredentials(FULL, "PRODUCTION")).toBeNull();
    expect(devAutoSignInCredentials(FULL, "  Production  ")).toBeNull();
  });
});

describe("deny by default — every missing piece disables it", () => {
  it("is off when the flag is absent, blank or anything but '1'", () => {
    for (const flag of [undefined, "", "  ", "0", "true", "yes", "on", "2"]) {
      expect(
        devAutoSignInCredentials(
          { ...FULL, EXPO_PUBLIC_DEV_AUTOLOGIN: flag },
          "development",
        ),
        `flag ${JSON.stringify(flag)} must not enable auto sign-in`,
      ).toBeNull();
    }
  });

  it("is off when any one of the three values is missing", () => {
    for (const key of [
      "EXPO_PUBLIC_API_URL",
      "EXPO_PUBLIC_DEV_EMAIL",
      "EXPO_PUBLIC_DEV_PASSWORD",
    ] as const) {
      expect(
        devAutoSignInCredentials({ ...FULL, [key]: undefined }, "development"),
        `${key} missing must disable auto sign-in`,
      ).toBeNull();
      expect(
        devAutoSignInCredentials({ ...FULL, [key]: "   " }, "development"),
        `${key} blank must disable auto sign-in`,
      ).toBeNull();
    }
  });

  it("is off for an entirely empty environment", () => {
    expect(devAutoSignInCredentials({}, "development")).toBeNull();
  });
});
