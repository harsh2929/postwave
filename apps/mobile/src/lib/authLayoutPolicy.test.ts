import { describe, expect, it } from "vitest";

import { authLayoutRedirect } from "@/lib/authLayoutPolicy";
import type { SessionMfaGate } from "@/store/authMfaGate";

const VERIFY_PATHS = ["/verify-email", "/(auth)/verify-email"] as const;
const MFA_GATES: SessionMfaGate[] = ["none", "enrollment", "challenge"];

describe("authLayoutRedirect", () => {
  describe("email verification", () => {
    for (const path of VERIFY_PATHS) {
      for (const isAuthed of [false, true]) {
        it.each(MFA_GATES)(
          `keeps ${path} reachable when isAuthed=${String(isAuthed)} and MFA is %s`,
          (mfaGate) => {
            expect(authLayoutRedirect({ path, isAuthed, mfaGate })).toBeNull();
          },
        );
      }
    }
  });

  it.each([
    ["/magic-return", "enrollment"],
    ["/(auth)/magic-return", "challenge"],
    ["/reset-confirm", "challenge"],
    ["/(auth)/reset-confirm", "enrollment"],
  ] as const)("keeps recovery route %s ahead of the %s gate", (path, mfaGate) => {
    expect(
      authLayoutRedirect({ path, isAuthed: true, mfaGate }),
    ).toBeNull();
  });

  it("sends an enrollment-gated session only to enrollment", () => {
    expect(
      authLayoutRedirect({
        path: "/(auth)/sign-in",
        isAuthed: false,
        mfaGate: "enrollment",
      }),
    ).toBe("/(auth)/mfa-enroll");
    expect(
      authLayoutRedirect({
        path: "/(auth)/totp",
        isAuthed: false,
        mfaGate: "enrollment",
      }),
    ).toBe("/(auth)/mfa-enroll");
    expect(
      authLayoutRedirect({
        path: "/(auth)/mfa-enroll",
        isAuthed: false,
        mfaGate: "enrollment",
      }),
    ).toBeNull();
  });

  it("sends a challenge-gated session only to TOTP", () => {
    expect(
      authLayoutRedirect({
        path: "/(auth)/sign-in",
        isAuthed: false,
        mfaGate: "challenge",
      }),
    ).toBe("/(auth)/totp");
    expect(
      authLayoutRedirect({
        path: "/(auth)/mfa-enroll",
        isAuthed: false,
        mfaGate: "challenge",
      }),
    ).toBe("/(auth)/totp");
    expect(
      authLayoutRedirect({
        path: "/(auth)/totp",
        isAuthed: false,
        mfaGate: "challenge",
      }),
    ).toBeNull();
  });

  it("still bounces an authenticated user away from ordinary auth screens", () => {
    expect(
      authLayoutRedirect({
        path: "/(auth)/sign-in",
        isAuthed: true,
        mfaGate: "none",
      }),
    ).toBe("/(tabs)/dashboard");
  });

  it("leaves an unauthenticated ordinary auth screen reachable", () => {
    expect(
      authLayoutRedirect({
        path: "/(auth)/sign-in",
        isAuthed: false,
        mfaGate: "none",
      }),
    ).toBeNull();
  });
});
