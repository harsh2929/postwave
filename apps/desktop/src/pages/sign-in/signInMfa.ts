import type { AuthMeResponse } from "../../lib/api-client";

export type SignInMfaStep = "none" | "challenge" | "enroll";

/**
 * Prefer the current server's policy/session verdict. The TOTP-only fallback
 * preserves the pre-contract behavior for older self-hosted deployments.
 */
export function signInMfaStep(result: {
  data?: AuthMeResponse;
  error?: { status?: number; code?: string };
}): SignInMfaStep {
  const me = result.data;
  if (
    me &&
    typeof me.mfa_required === "boolean" &&
    typeof me.mfa_satisfied === "boolean"
  ) {
    if (!me.mfa_required || me.mfa_satisfied) return "none";
    return me.totp_enabled === false ? "enroll" : "challenge";
  }
  if (me?.totp_enabled === true) return "challenge";
  if (result.error?.status === 403 && result.error.code === "mfa_required") {
    return "challenge";
  }
  return "none";
}
