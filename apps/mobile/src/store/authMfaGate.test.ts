/**
 * The MFA gate is the decision that keeps an unproven session out of the tabs,
 * and it is now import-free (store/authMfaGate.ts), so it can be tested in the
 * node environment with NO module mocks at all. That is the point of the seam:
 * these assertions hold even if expo-secure-store, the query client and the SDK
 * are all unavailable.
 *
 * src/store/auth.test.ts still covers the same functions through the store's
 * re-exports; this file covers them directly, which is what proves the
 * extraction did not quietly acquire a dependency.
 */
import { describe, expect, it } from "vitest";

import {
  destinationForSession,
  mfaGateForSession,
  needsMfaSecurityStepUp,
  sessionMfaAllowsEntry,
} from "./authMfaGate";
import type { SessionProfile } from "./authSessionProfile";

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    email: "owner@example.com",
    userId: "user_1",
    tenantId: "tenant_1",
    role: "owner",
    effectiveRole: "owner",
    viewerMode: false,
    authProvider: "password",
    emailVerified: true,
    canUseViewerMode: true,
    totpEnabled: false,
    mfaRequired: false,
    mfaSatisfied: false,
    hasTotp: false,
    mfaStatus: "not_required",
    ...overrides,
  };
}

describe("MFA gate derivation", () => {
  it.each([
    {
      name: "policy off",
      required: false,
      enrolled: false,
      satisfied: false,
      gate: "none" as const,
      route: "/(tabs)/dashboard" as const,
      entry: true,
    },
    {
      name: "policy off even with a factor enrolled",
      required: false,
      enrolled: true,
      satisfied: false,
      gate: "none" as const,
      route: "/(tabs)/dashboard" as const,
      entry: true,
    },
    {
      name: "required with no factor must enroll",
      required: true,
      enrolled: false,
      satisfied: false,
      gate: "enrollment" as const,
      route: "/(auth)/mfa-enroll" as const,
      entry: false,
    },
    {
      name: "required with a factor must challenge",
      required: true,
      enrolled: true,
      satisfied: false,
      gate: "challenge" as const,
      route: "/(auth)/totp" as const,
      entry: false,
    },
    {
      name: "required and satisfied passes",
      required: true,
      enrolled: true,
      satisfied: true,
      gate: "none" as const,
      route: "/(tabs)/dashboard" as const,
      entry: true,
    },
  ])(
    "$name",
    ({ required, enrolled, satisfied, gate, route, entry }) => {
      const session = profile({
        mfaRequired: required,
        totpEnabled: enrolled,
        hasTotp: enrolled,
        mfaSatisfied: satisfied,
      });
      expect(mfaGateForSession(session)).toBe(gate);
      expect(destinationForSession(session)).toBe(route);
      expect(sessionMfaAllowsEntry(session)).toBe(entry);
    },
  );

  it("a null session gates to none and never claims entry", () => {
    expect(mfaGateForSession(null)).toBe("none");
    expect(destinationForSession(null)).toBe("/(tabs)/dashboard");
    // The absence of a session is NOT permission: sessionMfaAllowsEntry stays
    // false so a caller that forgets its own authentication check still fails
    // closed rather than opening the tabs to nobody.
    expect(sessionMfaAllowsEntry(null)).toBe(false);
  });

  it("step-up is required whenever an enrolled factor is unproven", () => {
    // Independent of tenant policy: managing an existing factor always needs
    // fresh proof, even when mfaRequired is false and the gate is already open.
    expect(
      needsMfaSecurityStepUp(
        profile({ totpEnabled: true, hasTotp: true, mfaSatisfied: false }),
      ),
    ).toBe(true);
    expect(
      mfaGateForSession(
        profile({ totpEnabled: true, hasTotp: true, mfaSatisfied: false }),
      ),
    ).toBe("none");
    expect(
      needsMfaSecurityStepUp(
        profile({ totpEnabled: true, hasTotp: true, mfaSatisfied: true }),
      ),
    ).toBe(false);
    expect(needsMfaSecurityStepUp(profile({ totpEnabled: false }))).toBe(false);
    expect(needsMfaSecurityStepUp(null)).toBe(false);
  });
});
