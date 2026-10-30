/**
 * store/authSignIn.ts
 *
 * The three transitions that change WHICH identity this device holds:
 * API-key connect, cookie-session sign-in, and cancellation/sign-out.
 * Extracted from store/auth.ts (AUTH#60).
 *
 * The shared shape of all three, and the reason they live together:
 *
 *   - Memory is revoked FIRST. Even a keychain or network failure afterwards
 *     cannot leave the auth layout still seeing the outgoing session.
 *   - The two modes are mutually exclusive; each entry point wipes the other.
 *   - A cookie session that could not be revoked server-side is JOURNALED, not
 *     dropped. hydrate(), signIn() and prepareForSessionAuthentication() all
 *     retry it, so an offline sign-out still terminates server-side eventually.
 */
import { EVENTS } from "@postwave/telemetry";

import { track as trackTelemetry, reset as resetTelemetry } from "@/lib/telemetry";

import {
  cleanupWarning,
  clearInMemoryClientState,
  clearLocalAuthArtifacts,
  revokeServerSession,
  type LocalAuthCleanupResult,
} from "./authCleanup";
import {
  AuthSessionStateError,
  LocalAuthPersistenceError,
  localCommitFailureReason,
} from "./authErrors";
import { persistSessionTransaction } from "./authPersistence";
import {
  SECURE_KEY_API,
  SECURE_KEY_BASE,
  SECURE_KEY_SESSION_REVOKE_PENDING,
  SECURE_KEY_TENANT,
  retryStorageOperation,
  retryStorageRead,
  secureDelete,
  secureGet,
  secureSet,
} from "./authSecureStorage";
import {
  sanitizeSessionProfile,
  type SessionProfile,
} from "./authSessionProfile";
import {
  loggedOutState,
  type AuthGet,
  type AuthSet,
  type AuthSnapshot,
  type SessionCancellationResult,
} from "./authState";

export async function signInWithApiKey(
  input: { apiKey: string; baseUrl: string; tenantId: string },
  set: AuthSet,
  get: AuthGet,
): Promise<AuthSnapshot> {
  const { apiKey, baseUrl, tenantId } = input;
  const previous = get();
  try {
    // Wipe any prior session first — modes are mutually exclusive.
    clearInMemoryClientState();
    resetTelemetry();
    set(loggedOutState(null, false));
    // Raise the busy flag AFTER the logged-out reset above (which itself
    // clears signingIn); otherwise it is overwritten back to false before
    // any of the awaited revoke/cleanup/persist work runs.
    set({ signingIn: true });
    const queuedRevocationBaseUrl = await retryStorageRead(() =>
      secureGet(SECURE_KEY_SESSION_REVOKE_PENDING),
    );
    if (queuedRevocationBaseUrl) {
      const revoked = await revokeServerSession(queuedRevocationBaseUrl);
      if (!revoked) {
        throw new AuthSessionStateError(
          "server_revocation_pending",
          "Finish the prior server sign-out while online before connecting a new account.",
        );
      }
      await retryStorageOperation(() =>
        secureDelete(SECURE_KEY_SESSION_REVOKE_PENDING),
      );
    }
    if (previous.mode === "session" && previous.baseUrl) {
      const previousBaseUrl = previous.baseUrl;
      const revoked = await revokeServerSession(previousBaseUrl);
      if (!revoked) {
        try {
          // Durably journal the un-revoked cookie session so hydrate and the
          // next sign-in retry server-side revocation on a later online
          // launch, mirroring cancelSession. The API-key credentials written
          // below stay authoritative — hydrate keeps them (apiKeyIntact) and
          // clearLocalAuthArtifacts does not touch this marker.
          await retryStorageOperation(() =>
            secureSet(SECURE_KEY_SESSION_REVOKE_PENDING, previousBaseUrl),
          );
          set({
            authWarning:
              "The prior cookie session could not be revoked yet; it will retry on the next online launch. The API-key connection remains isolated from it.",
          });
        } catch {
          set({
            authWarning:
              "The prior cookie session could not be revoked. It will expire server-side; the API-key connection remains isolated from it.",
          });
        }
      }
    }
    // `identityPresent` is the PRIOR identity, captured before the reset
    // above: that is what this wipe exists to remove. On a device that held
    // none, a failing App Group clear is not an incomplete sign-out and must
    // not block the connection being made.
    const cleanup = await clearLocalAuthArtifacts({
      identityPresent: previous.mode !== null,
    });
    if (!cleanup.complete) {
      const warning = cleanupWarning(cleanup);
      set({ authWarning: warning, localCleanupPending: true });
      throw new AuthSessionStateError(
        "local_cleanup_pending",
        warning ?? "Secure local cleanup is incomplete.",
      );
    }
    await retryStorageOperation(() => secureSet(SECURE_KEY_BASE, baseUrl));
    await retryStorageOperation(() => secureSet(SECURE_KEY_TENANT, tenantId));
    await retryStorageOperation(() => secureSet(SECURE_KEY_API, apiKey));
    const snapshot: AuthSnapshot = {
      apiKey,
      baseUrl,
      tenantId,
      session: null,
      mode: "api_key",
    };
    set({
      ...snapshot,
      sessionValidation: "none",
      signingIn: false,
      localCleanupPending: false,
    });
    trackTelemetry(EVENTS.MOBILE_AUTH_COMPLETED, {
      outcome: "success",
      method: "api_key",
    });
    return snapshot;
  } catch (err) {
    // No claim either way: the failure may have landed after some of the new
    // credentials were written, and the probe finds those. What it must not do
    // is invent an incomplete sign-out on a device that holds neither the old
    // identity nor any part of the new one.
    const cleanup = await clearLocalAuthArtifacts();
    set(
      loggedOutState(
        cleanupWarning(cleanup) ?? get().authWarning,
        !cleanup.complete,
      ),
    );
    throw err;
  }
}

export async function signInWithSession(
  input: { baseUrl: string; profile: Partial<SessionProfile> },
  set: AuthSet,
  get: AuthGet,
): Promise<AuthSnapshot> {
  const { baseUrl, profile } = input;
  // Captured before the logged-out reset below wipes it: the wipe inside the
  // try clears the PRIOR identity, and whether there was one decides whether a
  // failing task is an incomplete sign-out or a no-op on a first-run device.
  const previousIdentity = get().mode !== null;
  const session = sanitizeSessionProfile(profile);
  if (!session) {
    set({ signingIn: false });
    throw new AuthSessionStateError(
      "invalid_session_profile",
      "The server returned an invalid session profile.",
    );
  }
  try {
    // Wipe any prior API-key triple — modes are mutually exclusive.
    clearInMemoryClientState();
    resetTelemetry();
    set(loggedOutState(null, false));
    // Raise the busy flag AFTER the logged-out reset above (which itself
    // clears signingIn); otherwise it is overwritten back to false before
    // the awaited cleanup/persist work runs.
    set({ signingIn: true });
    // Every session-auth entry point must clear this journal before it sends
    // a request that can replace the platform cookie. Keep a defensive
    // check here so a future caller cannot silently discard an older
    // offline sign-out after the new cookie already exists.
    const queuedRevocationBaseUrl = await retryStorageRead(() =>
      secureGet(SECURE_KEY_SESSION_REVOKE_PENDING),
    );
    if (queuedRevocationBaseUrl) {
      throw new AuthSessionStateError(
        "server_revocation_pending",
        "Finish the prior server sign-out before signing in again.",
      );
    }
    const cleanup = await clearLocalAuthArtifacts({
      identityPresent: previousIdentity,
    });
    if (!cleanup.complete) {
      const warning = cleanupWarning(cleanup);
      set({ authWarning: warning, localCleanupPending: true });
      throw new AuthSessionStateError(
        "local_cleanup_pending",
        warning ?? "Secure local cleanup is incomplete.",
      );
    }
    await persistSessionTransaction(baseUrl, session);
    const snapshot: AuthSnapshot = {
      apiKey: null,
      baseUrl,
      tenantId: session.tenantId,
      session,
      mode: "session",
    };
    set({
      ...snapshot,
      sessionValidation: "validated_online",
      signingIn: false,
      authWarning: null,
      localCleanupPending: false,
    });
    trackTelemetry(EVENTS.MOBILE_AUTH_COMPLETED, {
      outcome: "success",
      method: "session",
    });
    return snapshot;
  } catch (err) {
    // The backend cookie already exists. If the local transaction cannot
    // commit, revoke (or durably journal) that server session and leave no
    // half-signed-in mobile state for the auth layout to bounce back into.
    //
    // RECORD WHY FIRST. This path tears down a session the SERVER ALREADY
    // ACCEPTED: the wire shows login 200, /auth/me 200, then logout 204, and
    // until now nothing said which local step failed. That was observed
    // intermittently on a simulator and could not be diagnosed from the logs,
    // because the only trace was a generic `profile_load_failed` in the caller
    // -- which reads as "the server would not give us a profile" when the
    // server had just given us one.
    //
    // The reason goes out BEFORE cancelSession, since cancelSession calls
    // resetTelemetry() and would otherwise discard it.
    trackTelemetry(EVENTS.MOBILE_AUTH_COMPLETED, {
      outcome: "failure",
      method: "session",
      // Bounded and structural: the class of local step that failed, never the
      // message, which can carry a keychain path or a profile field.
      reason: localCommitFailureReason(err),
    });
    await get().cancelSession(baseUrl);
    // RE-ASSERT THE LATCH cancelSession just cleared.
    //
    // persistSessionTransaction writes the durable SECURE_KEY_CLEANUP_PENDING
    // marker before throwing, but cancelAuthSession resets the IN-MEMORY flag
    // with `loggedOutState(null, false)` -- correct for an ordinary sign-out and
    // wrong here. Dev auto-sign-in guards on that in-memory flag
    // (useSignInController: `if (!DEV_AUTO_SIGN_IN || busy ||
    // localCleanupPending) return`), so clearing it let auto-sign-in retry
    // immediately against a local failure that cannot resolve on its own.
    //
    // The observed result was an unbounded cycle -- login 200, /auth/me 200,
    // logout 204, repeat -- three server round trips per iteration, with the
    // app never staying signed in. The durable marker was right the whole time;
    // only the in-memory copy lied.
    if (err instanceof LocalAuthPersistenceError) {
      set({ localCleanupPending: true });
    }
    throw err;
  }
}

export async function cancelAuthSession(
  sessionBaseUrl: string | undefined,
  set: AuthSet,
  get: AuthGet,
): Promise<SessionCancellationResult> {
  const { mode, baseUrl } = get();
  clearInMemoryClientState();
  resetTelemetry();
  // Memory is revoked first. Even a keychain/network failure cannot leave
  // the auth layout seeing the pending session and redirecting back to MFA.
  set(loggedOutState(null, false));
  let serverRevocationPending = false;
  let serverRevocationWarning: string | null = null;
  const revocationBaseUrl =
    sessionBaseUrl ?? (mode === "session" ? baseUrl : null);
  if (revocationBaseUrl) {
    const revoked = await revokeServerSession(revocationBaseUrl);
    if (revoked) {
      try {
        await retryStorageOperation(() =>
          secureDelete(SECURE_KEY_SESSION_REVOKE_PENDING),
        );
      } catch {
        serverRevocationWarning =
          "The server session is revoked, but this device could not clear its retry marker. Unlock the device and retry secure cleanup.";
      }
    } else {
      serverRevocationPending = true;
      try {
        await retryStorageOperation(() =>
          secureSet(SECURE_KEY_SESSION_REVOKE_PENDING, revocationBaseUrl),
        );
        serverRevocationWarning =
          "You are signed out on this device. Server sign-out could not finish and will retry on the next online launch.";
      } catch {
        serverRevocationWarning =
          "You are signed out on this device, but server sign-out and its secure retry record could not be completed. Reconnect and sign out again before sharing this device.";
      }
    }
  }
  // `identityPresent`: `mode` was read from the store before the reset above,
  // so a sign-out of a real session still reports its failures even when the
  // keychain has already lost the blobs (which is how the crash-recovery paths
  // reach this function).
  const cleanup = await clearLocalAuthArtifacts({
    identityPresent: mode !== null,
  });
  const warning = [cleanupWarning(cleanup), serverRevocationWarning]
    .filter((message): message is string => Boolean(message))
    .join(" ") || null;
  set({
    authWarning: warning,
    localCleanupPending: !cleanup.complete,
  });
  return { cleanup, serverRevocationPending };
}

export async function retryLocalCleanupAction(
  set: AuthSet,
): Promise<LocalAuthCleanupResult> {
  // No `identityPresent` claim, deliberately. The state this button exists to
  // clear is recorded on the DEVICE (the cleanup marker), so the probe reads
  // the same evidence the next launch will, and a retry on a device that turns
  // out to hold nothing releases the latch instead of re-asserting it.
  const result = await clearLocalAuthArtifacts();
  set({
    localCleanupPending: !result.complete,
    authWarning: cleanupWarning(result),
  });
  return result;
}
