/**
 * store/authErrors.ts
 *
 * The typed failures the auth store raises. Extracted from store/auth.ts
 * (AUTH#60) so every seam of the split — persistence, cleanup, sign-in and
 * revalidation — can throw the same coded error without importing each other.
 *
 * `code` is the stable contract: screens branch on it (magic-return.tsx,
 * sign-in.tsx) and telemetry buckets on it. Message text is user-facing copy.
 */

export class AuthSessionStateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthSessionStateError";
    this.code = code;
  }
}

export class LocalAuthPersistenceError extends AuthSessionStateError {
  constructor() {
    super(
      "local_session_persistence_pending",
      "Your session was verified, but this device could not securely save the update. Keep the app open and try again.",
    );
    this.name = "LocalAuthPersistenceError";
  }
}

/**
 * The CLASS of local step that failed while committing a session the server had
 * already accepted.
 *
 * Bounded on purpose. The raw message can carry a keychain path, a SecureStore
 * key name or a profile field, and this value goes to telemetry — so the
 * classification is structural and the message is never forwarded.
 *
 * WHY IT EXISTS. `signInSession` cancels the server session when its local
 * transaction fails, which is right: a cookie with no local record is a
 * half-signed-in state the auth layout would bounce through forever. But it
 * recorded nothing about WHICH step failed, so the wire read login 200,
 * /auth/me 200, logout 204 with no explanation, and the caller's generic
 * `profile_load_failed` actively misdirected — the server HAD returned a
 * profile.
 */
export function localCommitFailureReason(err: unknown): string {
  if (err instanceof AuthSessionStateError) {
    // Already classified by the thrower (e.g. invalid_session_profile).
    return err.code || "auth_state_error";
  }
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Matched against the storage layer's own vocabulary rather than a guess:
  // secureGet/secureSet wrap expo-secure-store, whose failures surface as
  // keychain errors, and retryStorageRead re-throws them unchanged.
  if (/secure ?store|keychain|SecItem/i.test(text)) return "secure_store_write";
  if (/quota|disk|no space/i.test(text)) return "storage_full";
  if (/timeout|timed out/i.test(text)) return "storage_timeout";
  return "unknown_local_commit";
}
