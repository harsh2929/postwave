/**
 * store/authSessionLifecycle.ts
 *
 * Everything that keeps an ALREADY-established cookie session honest:
 * revalidation against /me, the orphan-revocation gate a new sign-in must pass,
 * and the 403 `mfa_required` interception. Extracted from store/auth.ts
 * (AUTH#60).
 *
 * The rule that governs this whole module: /me is authoritative. A cached
 * profile may fill the screen while offline, but it can never out-vote the
 * server on identity or on MFA. Any answer from /me that contradicts the cached
 * identity is a sign-out, not a merge.
 */
import { createAuthClient } from "@/api/auth";
import { isProbablyOnline } from "@/lib/connectivity";
import { reset as resetTelemetry } from "@/lib/telemetry";

import {
  cleanupWarning,
  clearInMemoryClientState,
  clearLocalAuthArtifacts,
  revokeServerSession,
} from "./authCleanup";
import { AuthSessionStateError } from "./authErrors";
import { persistSessionTransaction } from "./authPersistence";
import {
  SECURE_KEY_SESSION_REVOKE_PENDING,
  retryStorageOperation,
  retryStorageRead,
  secureDelete,
  secureGet,
} from "./authSecureStorage";
import {
  sanitizeSessionProfile,
  sessionProfileFromMe,
  type SessionProfile,
} from "./authSessionProfile";
import { loggedOutState, type AuthGet, type AuthSet } from "./authState";

// Coalesces the many concurrent 403 mfa_required interceptions a single tab can
// produce into one /me refresh + keychain transaction. Module-level because the
// store is a module-level singleton; see handleMfaRequired for why the
// synchronous gate-close happens BEFORE this guard is consulted.
let mfaRequiredHandling = false;

async function forceSignedOut(set: AuthSet): Promise<void> {
  clearInMemoryClientState();
  resetTelemetry();
  set(loggedOutState(null, false));
  // `identityPresent`: this runs only after /me answered about a session this
  // device was holding, so the wipe is never a no-op and must report failure
  // even if the keychain has already lost the blobs it is clearing.
  const cleanup = await clearLocalAuthArtifacts({ identityPresent: true });
  const warning = cleanupWarning(cleanup);
  if (warning) set({ authWarning: warning, localCleanupPending: true });
}

export async function applyAuthoritativeSession(
  baseUrl: string,
  original: SessionProfile,
  set: AuthSet,
  get: AuthGet,
): Promise<SessionProfile> {
  let me: Awaited<ReturnType<ReturnType<typeof createAuthClient>["getMe"]>>;
  try {
    me = await createAuthClient(baseUrl).getMe();
  } catch {
    throw new AuthSessionStateError(
      "session_network_error",
      "Couldn't reach the server. Check your connection and try again.",
    );
  }

  const current = get();
  if (
    current.mode !== "session" ||
    current.baseUrl !== baseUrl ||
    current.session?.userId !== original.userId
  ) {
    throw new AuthSessionStateError(
      "session_changed",
      "The active account changed while the session was being checked.",
    );
  }

  if (me.error) {
    if (me.error.status === 401 || me.error.code === "no_session") {
      await forceSignedOut(set);
      throw new AuthSessionStateError(
        "session_expired",
        "Your sign-in session expired. Please sign in again.",
      );
    }
    throw new AuthSessionStateError(
      me.error.code ?? "session_revalidation_failed",
      me.error.kind === "network" || me.error.kind === "timeout"
        ? "Couldn't reach the server. Check your connection and try again."
        : me.error.message,
    );
  }

  const session = sanitizeSessionProfile(sessionProfileFromMe(me.data));
  if (!session) {
    throw new AuthSessionStateError(
      "invalid_session_profile",
      "The server returned an invalid session profile.",
    );
  }
  if (
    session.userId !== original.userId ||
    session.tenantId !== original.tenantId
  ) {
    await forceSignedOut(set);
    throw new AuthSessionStateError(
      "session_identity_changed",
      "The server session belongs to a different account. Please sign in again.",
    );
  }

  // One Zustand commit makes the canonical identity + all three MFA fields
  // live together. Never preserve a local `satisfied` projection over /me.
  set({
    session,
    tenantId: session.tenantId,
    mode: "session",
    sessionValidation: "validated_online",
  });
  try {
    await persistSessionTransaction(baseUrl, session);
    set({ localCleanupPending: false });
  } catch (error) {
    set({
      authWarning:
        "Your verified session is active, but its secure device cache needs another save attempt before restart.",
      localCleanupPending: true,
    });
    throw error;
  }
  return session;
}

export async function revalidateCachedSession(
  baseUrl: string,
  original: SessionProfile,
  set: AuthSet,
  get: AuthGet,
): Promise<void> {
  try {
    await applyAuthoritativeSession(baseUrl, original, set, get);
  } catch (error) {
    const cur = get();
    if (
      cur.mode === "session" &&
      cur.baseUrl === baseUrl &&
      cur.session?.userId === original.userId &&
      cur.sessionValidation === "checking"
    ) {
      set({ sessionValidation: "offline_cached" });
    }
    if (
      !(
        error instanceof AuthSessionStateError &&
        error.code === "session_expired"
      )
    ) {
      console.warn(
        "[postwave-mobile] session revalidation did not complete:",
        error instanceof AuthSessionStateError ? error.code : "unknown_error",
      );
    }
  }
}

export async function revalidateSessionAction(
  set: AuthSet,
  get: AuthGet,
): Promise<void> {
  const s = get();
  if (s.mode !== "session" || !s.baseUrl || !s.session) return;
  set({ sessionValidation: "checking" });
  await revalidateCachedSession(s.baseUrl, s.session, set, get);
}

export async function refreshSessionFromServerAction(
  set: AuthSet,
  get: AuthGet,
): Promise<SessionProfile> {
  const s = get();
  if (s.mode !== "session" || !s.baseUrl || !s.session) {
    throw new AuthSessionStateError(
      "no_session",
      "Your sign-in session is no longer available. Please sign in again.",
    );
  }
  set({ sessionValidation: "checking" });
  try {
    return await applyAuthoritativeSession(s.baseUrl, s.session, set, get);
  } catch (error) {
    const current = get();
    if (
      current.mode === "session" &&
      current.baseUrl === s.baseUrl &&
      current.session?.userId === s.session.userId &&
      current.sessionValidation === "checking"
    ) {
      set({ sessionValidation: "offline_cached" });
    }
    throw error;
  }
}

/**
 * Every session-auth entry point must pass this gate: an un-revoked cookie
 * session from a previous account is journaled, and letting a new sign-in
 * proceed past it would leave that orphan alive on the server forever.
 */
export async function prepareForSessionAuthenticationAction(
  set: AuthSet,
): Promise<void> {
  let queuedRevocationBaseUrl: string | null;
  try {
    queuedRevocationBaseUrl = await retryStorageRead(() =>
      secureGet(SECURE_KEY_SESSION_REVOKE_PENDING),
    );
  } catch {
    throw new AuthSessionStateError(
      "secure_storage_unavailable",
      "Secure device storage is unavailable. Unlock the device and try again.",
    );
  }
  if (!queuedRevocationBaseUrl) return;
  if (!isProbablyOnline()) {
    throw new AuthSessionStateError(
      "server_revocation_pending",
      "Reconnect to finish the prior server sign-out before signing in again.",
    );
  }
  if (!(await revokeServerSession(queuedRevocationBaseUrl))) {
    throw new AuthSessionStateError(
      "server_revocation_pending",
      "The prior server sign-out could not finish. Try again before signing in.",
    );
  }
  try {
    await retryStorageOperation(() =>
      secureDelete(SECURE_KEY_SESSION_REVOKE_PENDING),
    );
  } catch {
    throw new AuthSessionStateError(
      "local_cleanup_pending",
      "The prior server session is revoked, but this device could not clear its secure retry record. Unlock the device and try again.",
    );
  }
  set({ authWarning: null });
}

export async function handleMfaRequiredAction(
  baseUrl: string,
  set: AuthSet,
  get: AuthGet,
): Promise<void> {
  const current = get();
  if (current.mode !== "session" || !current.baseUrl || !current.session) {
    return;
  }
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = createAuthClient(baseUrl).baseUrl;
  } catch {
    return;
  }
  if (normalizedBaseUrl !== current.baseUrl) return;
  const updated = sanitizeSessionProfile({
    ...current.session,
    mfaRequired: true,
    mfaSatisfied: false,
  });
  if (!updated) return;
  // The 403 is itself authoritative for required+unsatisfied. Close the
  // gate synchronously before any screen can issue another protected call.
  set({
    session: updated,
    sessionValidation: "validated_online",
  });
  // One module-level observer routes every intercepted 403 into this handler;
  // a tab issuing several protected queries can fire N of them at once. The
  // synchronous gate-close above already applied to each caller; coalesce the
  // remaining async work so only one /me refresh + keychain transaction runs.
  if (mfaRequiredHandling) return;
  mfaRequiredHandling = true;
  try {
    try {
      await persistSessionTransaction(normalizedBaseUrl, updated);
    } catch {
      set({
        authWarning:
          "Two-factor verification is required. The secure device cache also needs another save attempt before restart.",
        localCleanupPending: true,
      });
    }
    // Resolve enrollment-vs-challenge from canonical /me. The provisional
    // state already fails closed if this refresh is temporarily unavailable.
    try {
      await get().refreshSessionFromServer();
    } catch {
      /* state remains required + unsatisfied; foreground/reconnect retries */
    }
  } finally {
    mfaRequiredHandling = false;
  }
}
