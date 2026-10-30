/**
 * Pure redirect policy for the `(auth)` navigator.
 *
 * MFA gates normally outrank every auth screen, but three link-driven recovery
 * flows must be allowed to finish first: magic sign-in, password reset, and
 * email verification. In particular, verify-email is valid before OR after a
 * session is established; sending it through enrollment/TOTP first can consume
 * the one-time link without ever verifying the address.
 */
import type { SessionMfaGate } from "@/store/authMfaGate";

export type AuthLayoutRedirect =
  | "/(auth)/mfa-enroll"
  | "/(auth)/totp"
  | "/(tabs)/dashboard";

interface AuthLayoutPolicyInput {
  path: string;
  isAuthed: boolean;
  mfaGate: SessionMfaGate;
}

const MFA_GATE_BYPASSES = new Set([
  "/magic-return",
  "/reset-confirm",
  "/verify-email",
]);

const POST_LOGIN_INTERSTITIALS = new Set([
  "/totp",
  "/mfa-enroll",
  "/magic-return",
  "/reset-confirm",
  "/verify-email",
]);

function authPath(path: string): string {
  return path.startsWith("/(auth)/") ? path.slice("/(auth)".length) : path;
}

export function authLayoutRedirect({
  path,
  isAuthed,
  mfaGate,
}: AuthLayoutPolicyInput): AuthLayoutRedirect | null {
  const current = authPath(path);
  const bypassesMfa = MFA_GATE_BYPASSES.has(current);

  if (
    mfaGate === "enrollment" &&
    current !== "/mfa-enroll" &&
    !bypassesMfa
  ) {
    return "/(auth)/mfa-enroll";
  }

  if (
    mfaGate === "challenge" &&
    current !== "/totp" &&
    !bypassesMfa
  ) {
    return "/(auth)/totp";
  }

  if (isAuthed && !POST_LOGIN_INTERSTITIALS.has(current)) {
    return "/(tabs)/dashboard";
  }

  return null;
}
