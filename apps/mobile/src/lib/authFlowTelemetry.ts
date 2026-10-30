import { EVENTS } from "@postwave/telemetry";

import type { AuthApiError } from "@/api/auth";

import { track } from "./telemetry";

export type MfaTelemetryOutcome = "success" | "failure" | "cancelled";

export type MfaTelemetryErrorCode =
  | "none"
  | "user_cancelled"
  | "invalid_code"
  | "rate_limited"
  | "session_expired"
  | "network"
  | "timeout"
  | "invalid_response"
  | "factor_not_enrolled"
  | "policy_changed"
  | "state_not_satisfied"
  | "local_persistence_pending"
  | "server";

export type MagicLinkTelemetryOutcome =
  | "success"
  | "failure"
  | "cancelled";

export type MagicLinkTelemetryErrorCode =
  | "none"
  | "user_cancelled"
  | "missing_token"
  | "missing_state"
  | "invalid_base_url"
  | "state_expired"
  | "state_mismatch"
  | "network"
  | "timeout"
  | "consume_rejected"
  | "profile_load_failed"
  | "account_mismatch"
  | "session_cleanup_pending"
  | "local_persistence_failed";

export type SignInTelemetryOutcome = "success" | "failure" | "cancelled";

export type SignInTelemetryMethod =
  | "password"
  | "magic_link"
  | "signup"
  | "oauth_google";

export type SignInTelemetryErrorCode =
  | "none"
  | "invalid_credentials"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "weak_password"
  | "email_taken"
  | "offline"
  | "invalid_input"
  | "profile_load_failed"
  // OAuth-only outcomes. `provider_disabled` is a deployment fact, not a user
  // error, and `user_cancelled` covers every browser round-trip that closed
  // without a callback — including the 409 identity_link_required the app
  // cannot observe. Keeping them separate stops both from inflating the
  // "unknown" bucket that the funnel metric is supposed to explain.
  | "provider_disabled"
  | "user_cancelled"
  | "unknown";

/**
 * Bounded classifier for sign-in / sign-up failures.
 *
 * MOBILE_AUTH_COMPLETED was emitted from exactly two places, both hardcoding
 * `outcome: "success"`, so its outcome dimension had cardinality one and
 * nobody could answer "what fraction of mobile sign-ins fail, and why?" — the
 * single most important funnel metric the app has. Like the MFA mappers, this
 * never forwards server text.
 */
export function signInAuthErrorCode(
  error: AuthApiError,
): SignInTelemetryErrorCode {
  if (error.status === 429 || error.code === "too_many_auth_attempts") {
    return "rate_limited";
  }
  if (error.kind === "network") return "network";
  if (error.kind === "timeout") return "timeout";
  if (error.code === "weak_password") return "weak_password";
  if (error.code === "email_taken" || error.code === "user_exists") {
    return "email_taken";
  }
  /**
   * A BARE 401 IS NOT PROOF THE PASSWORD WAS WRONG, and treating it as such
   * currently misreports a real bug as user error.
   *
   * Reproduced end to end against a live API on 2026-08-18. Server log, one
   * sign-in attempt from the app:
   *
   *   POST /api/v1/auth/login   -> 200   (credentials ACCEPTED)
   *   GET  /api/v1/auth/me      -> 401   (session did not establish)
   *   POST /api/v1/auth/logout  -> 204   (the app gives up)
   *
   * The user is then shown "Email or password is incorrect." about a password
   * the server had just accepted — which sends them to reset a credential that
   * was never wrong.
   *
   * ROOT CAUSE, established 2026-08-18 by running both configurations against
   * a live API. The 401 body is `missing_tenant` / "no session cookie or API
   * key provided". The server had issued a session cookie carrying `Secure`,
   * and the app reaches a dev API over PLAINTEXT http on a ROUTABLE host
   * (EXPO_PUBLIC_API_URL=http://172.20.10.2:8080), so the client is required to
   * discard it. Loopback is a "potentially trustworthy" origin and keeps such a
   * cookie, which is why browser-only development never saw this.
   *
   *   Secure on,  no slug header -> login 200, /auth/me 401 missing_tenant
   *   Secure off, no slug header -> login 200, /auth/me 200 full identity
   *
   * A tenant slug is NOT required: the second row authenticated with no slug
   * header at all. The tenant is resolved FROM the session cookie; the dev slug
   * header is the fallback for when there is no cookie. Setting
   * POSTWAVE_DEV_TENANT_SLUG_HEADER=1 does fix login, but only because it ALSO
   * dropped Secure as a side effect — the two are now decoupled via
   * POSTWAVE_SESSION_COOKIE_INSECURE.
   *
   * This is the SECOND cause of this symptom. The first (a missing
   * app.tenant_resolver RLS GUC) was found and fixed in June 2026 by bf60c8ac;
   * that fix is intact and this investigation confirms it.
   *
   * The `code` checks below are the trustworthy signal: the server SAYS
   * `invalid_credentials` when it means it. The status check is kept because
   * removing it would silently reclassify genuine bad-password 401s that carry
   * no code, and that is a behavioural change to an auth path — but it is
   * ordered last and documented so the next person reading a
   * "wrong password" report knows to check whether login itself returned 200.
   */
  if (
    error.code === "invalid_credentials" ||
    error.code === "invalid_login"
  ) {
    return "invalid_credentials";
  }
  // The session never established. Named codes, so no guessing: this is the
  // one 401 we KNOW is not about the password.
  if (error.code === "missing_tenant" || error.code === "no_session") {
    return "profile_load_failed";
  }
  if (error.status === 401) {
    return "invalid_credentials";
  }
  if (error.kind === "parse" || (error.status ?? 0) >= 500) return "server";
  if ((error.status ?? 0) >= 400) return "invalid_input";
  return "unknown";
}

/** Auth-funnel events carry exactly three bounded structural properties. */
export function trackSignInCompleted(
  outcome: SignInTelemetryOutcome,
  method: SignInTelemetryMethod,
  errorCode: SignInTelemetryErrorCode,
): void {
  track(EVENTS.MOBILE_AUTH_COMPLETED, {
    outcome,
    method,
    error_code: errorCode,
  });
}

/** Map a structured MFA API failure to a bounded, content-free enum. */
export function mfaAuthErrorCode(
  error: AuthApiError,
): MfaTelemetryErrorCode {
  if (error.status === 429 || error.code === "rate_limited") {
    return "rate_limited";
  }
  if (error.status === 401 || error.code === "no_session") {
    return "session_expired";
  }
  if (error.code === "invalid_code") return "invalid_code";
  if (error.code === "not_enrolled") return "factor_not_enrolled";
  if (error.code === "mfa_required") return "policy_changed";
  if (error.kind === "network") return "network";
  if (error.kind === "timeout") return "timeout";
  if (error.kind === "parse") return "invalid_response";
  return "server";
}

/** Classify local/session-state failures by known code only. */
export function mfaSessionErrorCode(
  error: unknown,
): MfaTelemetryErrorCode {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  switch (code) {
    case "local_session_persistence_pending":
    case "local_cleanup_pending":
      return "local_persistence_pending";
    case "no_session":
    case "session_expired":
    case "session_identity_changed":
      return "session_expired";
    case "session_network_error":
      return "network";
    case "invalid_session_profile":
      return "invalid_response";
    case "mfa_required":
      return "policy_changed";
    default:
      return "server";
  }
}

/** Map a magic-link API failure without forwarding backend-provided text. */
export function magicLinkAuthErrorCode(
  error: AuthApiError,
  fallback: "consume_rejected" | "profile_load_failed",
): MagicLinkTelemetryErrorCode {
  if (error.kind === "network") return "network";
  if (error.kind === "timeout") return "timeout";
  return fallback;
}

export function magicLinkSessionErrorCode(
  error: unknown,
): MagicLinkTelemetryErrorCode {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  if (code === "invalid_session_profile") return "profile_load_failed";
  if (
    code === "server_revocation_pending" ||
    code === "prior_session_revoked" ||
    code === "local_cleanup_pending"
  ) {
    return "session_cleanup_pending";
  }
  return "local_persistence_failed";
}

/** MFA events intentionally have exactly two structural properties. */
export function trackMfaCompleted(
  outcome: MfaTelemetryOutcome,
  errorCode: MfaTelemetryErrorCode,
): void {
  track(EVENTS.MOBILE_MFA_COMPLETED, {
    outcome,
    error_code: errorCode,
  });
}

/** Magic-link telemetry never includes a token, email, URL, or server text. */
export function trackMagicLinkHandled(
  outcome: MagicLinkTelemetryOutcome,
  errorCode: MagicLinkTelemetryErrorCode,
): void {
  track(EVENTS.MOBILE_LINK_HANDLED, {
    outcome,
    source: "magic_link",
    error_code: errorCode,
  });
}
