/**
 * store/authMfaGate.ts
 *
 * The MFA gate derivation, extracted from store/auth.ts (AUTH#60).
 *
 * This module has NO runtime imports at all — only a type — so it is directly
 * importable by a node-environment vitest file (house rule 6) and by any screen
 * that needs to answer "where does this session belong?" without paying for the
 * keychain, the query client or the SDK.
 *
 * The gate is derived from three canonical /me fields and nothing else:
 *
 *   mfaRequired=false                       → none        (policy is off)
 *   mfaRequired=true,  totpEnabled=false    → enrollment  (no factor yet)
 *   mfaRequired=true,  mfaSatisfied=false   → challenge   (factor, unproven)
 *   mfaRequired=true,  mfaSatisfied=true    → none        (proven this session)
 *
 * A null session gates to "none" because there is no session to gate; the
 * caller's authentication check is what keeps that from being an open door.
 */
import type { SessionProfile } from "./authSessionProfile";

export type SessionMfaGate = "none" | "enrollment" | "challenge";
export type SessionDestination =
  | "/(auth)/mfa-enroll"
  | "/(auth)/totp"
  | "/(tabs)/dashboard";

export function mfaGateForSession(
  session: SessionProfile | null,
): SessionMfaGate {
  if (!session || !session.mfaRequired) return "none";
  if (!session.totpEnabled) return "enrollment";
  return session.mfaSatisfied ? "none" : "challenge";
}

/** Operation-specific proof needed to manage an existing factor. */
export function needsMfaSecurityStepUp(
  session: SessionProfile | null,
): boolean {
  return Boolean(session?.totpEnabled && !session.mfaSatisfied);
}

export function sessionMfaAllowsEntry(
  session: SessionProfile | null,
): boolean {
  return Boolean(session && mfaGateForSession(session) === "none");
}

export function destinationForSession(
  session: SessionProfile | null,
): SessionDestination {
  const gate = mfaGateForSession(session);
  if (gate === "enrollment") return "/(auth)/mfa-enroll";
  if (gate === "challenge") return "/(auth)/totp";
  return "/(tabs)/dashboard";
}
