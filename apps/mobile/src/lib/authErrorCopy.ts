/**
 * authErrorCopy — every user-facing auth failure string, in one place that a
 * node test can import.
 *
 * Why this module exists:
 *
 *  1. `POST /api/v1/auth/login` answers a wrong password with
 *     `{error:{code:"invalid_credentials", message:""}}` (apps/api/internal/
 *     auth/handlers.go writeErr). `authRequest` keeps its `HTTP ${status}`
 *     placeholder when the envelope carries an empty message, and
 *     `redactAuthError` only rewrites Postgres prose — so the most common
 *     error in the whole product rendered as the literal string "HTTP 401".
 *     Offline rendered React Native's raw "Network request failed".
 *
 *  2. The copy helpers that DID exist lived inside Expo Router route modules
 *     (`app/(auth)/totp.tsx`, `mfa-enroll.tsx`, `magic-return.tsx`), so
 *     importing one dragged expo-router + the theme into the test. Every
 *     branch below is now reachable from `authErrorCopy.test.ts`.
 *
 * Rules the copy follows: name what happened, name the fix, never echo server
 * internals, and never show a status code to a human.
 */
import { redactAuthError, type AuthApiError } from "@/api/auth";

/** Copy shown when the server (or a local guard) says the device is offline. */
export const CONNECTION_COPY =
  "Couldn't reach the server. Check your connection and try again.";

export const OFFLINE_COPY =
  "You appear to be offline. Check your connection and try again.";

const SERVER_COPY = "Moosewave is temporarily unavailable. Please try again.";

/**
 * Human "3m 20s" / "45s" rendering for a lockout countdown. Values are
 * clamped: a hostile or broken `Retry-After` must never render a
 * multi-year countdown, and a sub-second remainder reads as "1s".
 */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.min(Math.ceil(seconds), 24 * 60 * 60);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins <= 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

function rateLimitCopy(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return `Too many attempts. Try again in ${formatCountdown(
      retryAfterSeconds,
    )}.`;
  }
  return "Too many attempts. Wait a few minutes, then try again.";
}

function isRateLimited(error: AuthApiError): boolean {
  return error.status === 429 || error.code === "too_many_auth_attempts";
}

function isConnectionFailure(error: AuthApiError): boolean {
  return error.kind === "network" || error.kind === "timeout";
}

/**
 * True when the server sent an envelope whose `message` is genuinely
 * user-facing. An empty backend message leaves `authRequest`'s
 * `HTTP <status>` placeholder in place, and that must never reach a human.
 */
function usableServerMessage(error: AuthApiError): string | null {
  const message = (error.message ?? "").trim();
  if (!message) return null;
  if (/^HTTP\s+\d{3}$/i.test(message)) return null;
  return redactAuthError(message);
}

/** Sign-in (email + password) failures. Mirrors desktop's signInFailureCopy. */
export function signInErrorMessage(error: AuthApiError): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (
    error.status === 401 ||
    error.code === "invalid_credentials" ||
    error.code === "invalid_login"
  ) {
    return "Email or password is incorrect.";
  }
  if (error.code === "no_session") {
    return "Your sign-in session expired. Please sign in again.";
  }
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  if (error.kind === "parse" || (error.status ?? 0) >= 500) return SERVER_COPY;
  return (
    usableServerMessage(error) ?? "Couldn't sign you in. Please try again."
  );
}

/** Account creation failures. The server's own copy wins where it is specific. */
export function signUpErrorMessage(error: AuthApiError): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (error.code === "weak_password") {
    return (
      usableServerMessage(error) ?? "Use a password of at least 12 characters."
    );
  }
  if (error.code === "email_taken" || error.code === "user_exists") {
    return "An account already exists for that email. Try signing in instead.";
  }
  if (error.code === "slug_taken" || error.code === "tenant_exists") {
    return "That workspace URL is taken. Pick another one.";
  }
  if (error.code === "invalid_email") {
    return "Enter a valid email address.";
  }
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  if (error.kind === "parse" || (error.status ?? 0) >= 500) return SERVER_COPY;
  return (
    usableServerMessage(error) ??
    "Couldn't create your workspace. Please try again."
  );
}

/** Magic-link / password-reset request failures (both are 202-always routes). */
export function linkRequestErrorMessage(error: AuthApiError): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  if (error.kind === "parse" || (error.status ?? 0) >= 500) return SERVER_COPY;
  return (
    usableServerMessage(error) ?? "Couldn't send that link. Please try again."
  );
}

/**
 * Password-reset CONFIRM failures (the screen the emailed link opens).
 *
 * `PasswordResetConfirm` (apps/api/internal/auth/password_reset.go:131) answers
 * with `missing_token` / `weak_password` / `invalid_link_contract` /
 * `invalid_token` and a set of 500-class codes whose messages are empty — which
 * left `authRequest`'s `HTTP 400` placeholder as the entire user-facing string.
 */
export function resetConfirmErrorMessage(error: AuthApiError): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (error.code === "weak_password") {
    return (
      usableServerMessage(error) ?? "Use a password of at least 12 characters."
    );
  }
  if (
    error.code === "invalid_token" ||
    error.code === "missing_token" ||
    error.code === "invalid_link_contract"
  ) {
    return "This reset link has expired or was already used. Request a new one.";
  }
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  if (error.kind === "parse" || (error.status ?? 0) >= 500) return SERVER_COPY;
  return (
    usableServerMessage(error) ??
    "Couldn't reset your password. Please try again."
  );
}

/** Per-session TOTP challenge failures (moved out of app/(auth)/totp.tsx). */
export function challengeErrorMessage(
  error: AuthApiError,
  useRecovery: boolean,
): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (error.code === "invalid_code") {
    return useRecovery
      ? "That recovery code didn't work. Each recovery code works only once."
      : "That code didn't work. Codes rotate every 30 seconds — enter the current one.";
  }
  if (error.code === "no_session") {
    return "Your sign-in session expired. Please sign in again.";
  }
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  return (
    usableServerMessage(error) ?? "Couldn't verify that code. Please try again."
  );
}

/** TOTP enrollment failures (moved out of app/(auth)/mfa-enroll.tsx). */
export function enrollmentErrorMessage(error: AuthApiError): string {
  if (isRateLimited(error)) return rateLimitCopy(error.retryAfterSeconds);
  if (error.status === 401 || error.code === "no_session") {
    return "Your sign-in session expired. Switch accounts and sign in again.";
  }
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  return (
    usableServerMessage(error) ??
    "Couldn't start two-factor setup. Please try again."
  );
}

/** Magic-link consume / profile-load failures (moved out of magic-return.tsx). */
export function consumeErrorMessage(error: AuthApiError): string {
  if (isConnectionFailure(error)) return CONNECTION_COPY;
  return usableServerMessage(error) ?? "That sign-in link could not be used.";
}

/**
 * CLI device-grant approval failures. The server's failure space is wider
 * than the one string the screen used to show: `cliScopesForPrincipal`
 * (apps/api/internal/auth/cli_auth.go) rejects an un-stepped-up
 * editor/admin with `mfa_required` and any other role with
 * `insufficient_role`, both of which have a real recovery action on device.
 */
export type DeviceApproveFailure =
  | "session_expired"
  | "mfa_required"
  | "insufficient_role"
  | "bad_code"
  | "expired_code"
  | "review_required"
  | "offline"
  | "unknown";

export function deviceApproveFailureKind(error: {
  status?: number | undefined;
  code?: string | undefined;
  kind?: string | undefined;
}): DeviceApproveFailure {
  if (error.kind === "network" || error.kind === "timeout") return "offline";
  if (error.code === "mfa_required") return "mfa_required";
  if (error.code === "insufficient_role") return "insufficient_role";
  if (error.code === "no_session" || error.status === 401) {
    return "session_expired";
  }
  if (error.code === "bad_user_code") return "bad_code";
  if (error.code === "invalid_or_expired") return "expired_code";
  if (error.code === "consent_required") return "review_required";
  if (error.status === 403) return "insufficient_role";
  return "unknown";
}

export function deviceApproveErrorMessage(kind: DeviceApproveFailure): string {
  switch (kind) {
    case "session_expired":
      return "Your session ended. Sign in on this phone, then scan the code again.";
    case "mfa_required":
      return "Two-factor verification is required before you can authorize a device.";
    case "insufficient_role":
      return "Your workspace role cannot authorize CLI devices.";
    case "bad_code":
      return "That code is not in the right format. Check the code the CLI printed.";
    case "expired_code":
      return "That code expired or was already used. Run the command again to get a new one.";
    case "review_required":
      return "The request or your account session changed. Review the refreshed details before deciding.";
    case "offline":
      return CONNECTION_COPY;
    default:
      return "Couldn't authorize that device. Run the command again and retry.";
  }
}

/** Local magic-link pending-state failures (moved out of magic-return.tsx). */
export function magicLinkStateErrorMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "This sign-in link request expired. Request a new link on this device.";
    case "state_mismatch":
    case "base_url_mismatch":
      return "This sign-in link doesn't match the request from this device. Request a new link.";
    case "storage_unavailable":
      return "Secure device storage is unavailable. Unlock the device and open the link again.";
    case "cleanup_failed":
      return "The prior sign-in request could not be securely cleared. Unlock the device and try again.";
    default:
      return "Request a new sign-in link on this device before opening it.";
  }
}

/**
 * Google sign-in outcomes.
 *
 * `unlinked` is the one that needed the most care. `Callback`
 * (apps/api/internal/auth/oauth_handlers.go:369-374) refuses to turn a merely
 * MATCHING verified email into a login method — it answers 409
 * `identity_link_required` and expects the user to connect the provider from
 * Security settings while signed in. The app cannot see that response (it is
 * rendered inside the OS browser, which then just closes), so the honest thing
 * to say after a round-trip that produced no callback is what has to be true
 * for it to succeed, not a guess about what went wrong.
 */
export function oauthFailureMessage(
  reason:
    | "provider_disabled"
    | "network"
    | "timeout"
    | "server"
    | "unlinked"
    | "invalid_return",
): string {
  switch (reason) {
    case "provider_disabled":
      return "Google sign-in isn't enabled on this Moosewave server. Use your email and password.";
    case "network":
      return CONNECTION_COPY;
    case "timeout":
      return "Google sign-in timed out. Check your connection and try again.";
    case "server":
      return SERVER_COPY;
    case "invalid_return":
      return "Google returned an unusable sign-in link. Try again, or use your email and password.";
    default:
      return "Google didn't finish signing you in. Your Google account has to be connected to a Moosewave account first — sign in with your password, then connect Google from Security settings.";
  }
}

/** Local password-reset pending-state failures (moved out of reset-confirm.tsx). */
export function passwordResetStateErrorMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "This password-reset request expired. Request a new link on this device.";
    case "state_mismatch":
    case "base_url_mismatch":
      return "This reset link does not match the request from this device.";
    case "storage_unavailable":
      return "Secure device storage is unavailable. Unlock the device and open the link again.";
    case "cleanup_failed":
      return "The expired reset request could not be securely cleared. Unlock the device and try again.";
    default:
      return "Request a new password-reset link on this device before opening it.";
  }
}
