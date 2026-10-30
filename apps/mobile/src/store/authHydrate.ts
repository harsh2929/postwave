/**
 * store/authHydrate.ts
 *
 * Launch-time restore, and the crash-recovery boundary that guards it.
 * Extracted from store/auth.ts (AUTH#60).
 *
 * Precedence, strongest first — this order is the whole security argument:
 *
 *   1. A pending VAULT purge belongs to the PREVIOUS identity and must finish
 *      before any cached identity is restored and allowed to address vault
 *      keys. Failure here is a full wipe, not a warning.
 *   2. A cleanup / revocation JOURNAL beats every credential blob. A failed
 *      SecureStore deletion must not silently sign the previous account back
 *      in. The one exception is a deliberate API-key connection with an orphan
 *      cookie revocation still queued (apiKeyIntact) — that revocation is
 *      retried without logging the new connection out.
 *   3. The write-ahead STAGE beats the main profile blob (see
 *      authPersistence.ts), because the stage is by construction the newer of
 *      the two.
 *   4. Session mode beats api_key when both somehow exist.
 *
 * A restored session is never `validated_online`: it is `checking` when the
 * device looks online (a /me revalidation is kicked off) and `offline_cached`
 * otherwise. Only /me can promote it.
 */
import { isProbablyOnline } from "@/lib/connectivity";
import { createAuthClient } from "@/api/auth";
import { vaultRecoverPendingCleanup } from "@/lib/secureVault";

import {
  cleanupWarning,
  clearInMemoryClientState,
  clearLocalAuthArtifacts,
  revokeServerSession,
} from "./authCleanup";
import {
  parseStoredSession,
  parseStoredSessionStage,
} from "./authPersistence";
import {
  SECURE_KEY_API,
  SECURE_KEY_BASE,
  SECURE_KEY_CLEANUP_PENDING,
  SECURE_KEY_SESSION,
  SECURE_KEY_SESSION_REVOKE_PENDING,
  SECURE_KEY_SESSION_STAGE,
  SECURE_KEY_TENANT,
  retryStorageOperation,
  retryStorageRead,
  secureDelete,
  secureGet,
} from "./authSecureStorage";
import type { SessionProfile } from "./authSessionProfile";
import { revalidateCachedSession } from "./authSessionLifecycle";
import {
  loggedOutState,
  type AuthGet,
  type AuthMode,
  type AuthSet,
  type SessionValidation,
} from "./authState";

// De-dupes overlapping hydrate() calls: two mounts must share one run rather
// than both executing the full restore/revalidate sequence (duplicate keychain
// reads, cleanup passes and /me revalidations). Module-level because the store
// is a module-level singleton; cleared in a finally so a rejected run cannot
// wedge every later attempt.
let hydratePromise: Promise<void> | null = null;

type StoredAuthArtifacts = [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

function readStoredArtifacts(): Promise<StoredAuthArtifacts> {
  return Promise.all([
    retryStorageRead(() => secureGet(SECURE_KEY_API)),
    retryStorageRead(() => secureGet(SECURE_KEY_BASE)),
    retryStorageRead(() => secureGet(SECURE_KEY_TENANT)),
    retryStorageRead(() => secureGet(SECURE_KEY_SESSION)),
    retryStorageRead(() => secureGet(SECURE_KEY_SESSION_STAGE)),
    retryStorageRead(() => secureGet(SECURE_KEY_CLEANUP_PENDING)),
    retryStorageRead(() => secureGet(SECURE_KEY_SESSION_REVOKE_PENDING)),
  ]);
}

/**
 * Journal branch. Returns true when hydrate has committed a terminal
 * logged-out state and the caller must stop; false when API-key credentials
 * remain authoritative and the normal restore should continue.
 */
async function resolvePendingJournals(
  input: {
    cleanupPending: string | null;
    revocationPendingBaseUrl: string | null;
    apiKey: string | null;
    storedBaseUrl: string | null;
    tenantId: string | null;
    sessionRaw: string | null;
    stageRaw: string | null;
  },
  set: AuthSet,
): Promise<boolean> {
  // A pending orphan cookie-session revocation alone (no failed local
  // cleanup) must not discard a deliberately-established API-key session:
  // signIn (api_key) journals the prior cookie for retry without logging
  // the new connection out. Only cleanupPending forces the fail-closed
  // wipe below.
  const apiKeyIntact =
    !input.cleanupPending &&
    Boolean(input.apiKey && input.storedBaseUrl && input.tenantId) &&
    !input.sessionRaw &&
    !input.stageRaw;
  let serverRevocationPending = Boolean(input.revocationPendingBaseUrl);
  if (input.revocationPendingBaseUrl && isProbablyOnline()) {
    const revoked = await revokeServerSession(input.revocationPendingBaseUrl);
    if (revoked) {
      serverRevocationPending = false;
      await retryStorageOperation(() =>
        secureDelete(SECURE_KEY_SESSION_REVOKE_PENDING),
      ).catch(() => {
        serverRevocationPending = true;
      });
    }
  }
  if (apiKeyIntact) {
    // API-key credentials stay authoritative; the caller falls through to
    // restore them. Any still-pending orphan revocation remains journaled for
    // a later online launch or the next sign-in attempt.
    return false;
  }
  // The seven artifacts are already in hand, so say outright whether this
  // device holds an identity rather than making the wipe re-read them. When
  // ONLY an orphan server revocation is journaled and every local artifact is
  // already gone, this is false and the wipe stays silent — that combination
  // is a completed local sign-out waiting on the network, not a leak.
  const cleanup = await clearLocalAuthArtifacts({
    identityPresent: Boolean(
      input.cleanupPending ||
        input.apiKey ||
        input.storedBaseUrl ||
        input.tenantId ||
        input.sessionRaw ||
        input.stageRaw,
    ),
  });
  const warning =
    cleanupWarning(cleanup) ??
    (serverRevocationPending
      ? "You are signed out on this device. Server sign-out is still pending and will retry on the next online launch."
      : null);
  set({
    ...loggedOutState(warning, !cleanup.complete),
    hydrated: true,
  });
  return true;
}

type RestoredArtifacts = {
  session: SessionProfile | null;
  baseUrl: string | null;
  /** The main blob exists but yielded nothing usable, so it must be deleted. */
  sessionBlobUnusable: boolean;
  /** Same for the write-ahead stage. */
  stageBlobUnusable: boolean;
};

/**
 * The stage wins over the main blob because it is by construction the newer of
 * the two (authPersistence.ts writes it first and deletes it last). Note the
 * asymmetry that this preserves: when the stage parses but the main blob does
 * not, `session` is non-null and the main blob is left alone — the next
 * successful transaction rewrites it anyway.
 */
function parseRestoredArtifacts(
  sessionRaw: string | null,
  stageRaw: string | null,
  storedBaseUrl: string | null,
): RestoredArtifacts {
  const stage = parseStoredSessionStage(stageRaw);
  const mainSession = parseStoredSession(sessionRaw);
  const session = stage?.session ?? mainSession;
  let baseUrl = stage?.baseUrl ?? storedBaseUrl;
  if (baseUrl) {
    try {
      baseUrl = createAuthClient(baseUrl).baseUrl;
    } catch {
      baseUrl = null;
    }
  }
  return {
    session,
    baseUrl,
    sessionBlobUnusable: Boolean(sessionRaw) && !session,
    stageBlobUnusable: Boolean(stageRaw) && !stage,
  };
}

/**
 * Deletes blobs that survived storage but not parsing. Returns false when the
 * device could not complete the repair — the caller then treats the whole
 * restore as unsafe rather than running on partially-repaired state.
 */
async function repairUnusableBlobs(
  restored: RestoredArtifacts,
): Promise<boolean> {
  try {
    if (restored.sessionBlobUnusable) {
      await retryStorageOperation(() => secureDelete(SECURE_KEY_SESSION));
    }
    if (restored.stageBlobUnusable) {
      await retryStorageOperation(() => secureDelete(SECURE_KEY_SESSION_STAGE));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Mode preference: session beats api_key when both are present. (Shouldn't
 * happen — signIn paths wipe each other — but cheap to be defensive in the
 * hydrate path.)
 */
function restoredMode(
  session: SessionProfile | null,
  baseUrl: string | null,
  apiKey: string | null,
  tenantId: string | null,
): AuthMode | null {
  if (session && baseUrl) return "session";
  if (apiKey && baseUrl && tenantId) return "api_key";
  return null;
}

async function runHydrate(set: AuthSet, get: AuthGet): Promise<void> {
  // A vault purge journal belongs to the previous identity. It must finish
  // before any cached identity is restored and allowed to address vault
  // keys, otherwise a shared-device account switch can reuse stale data.
  try {
    await vaultRecoverPendingCleanup();
  } catch {
    clearInMemoryClientState();
    // No `identityPresent` claim: nothing has been read yet, so the wipe
    // probes for itself. A first launch on an empty device fails this vault
    // probe transiently (the keychain's first call after a device unlock is
    // the flakiest one there is) and must not be told its sign-out is
    // incomplete when it was never signed in.
    const cleanup = await clearLocalAuthArtifacts();
    set({
      ...loggedOutState(cleanupWarning(cleanup), !cleanup.complete),
      hydrated: true,
    });
    return;
  }
  let stored: StoredAuthArtifacts;
  try {
    stored = await readStoredArtifacts();
  } catch {
    set({
      ...loggedOutState(
        "Secure device storage is unavailable. Unlock the device and restart the app before signing in.",
        true,
      ),
      hydrated: true,
    });
    return;
  }
  const [
    apiKey,
    storedBaseUrl,
    tenantId,
    sessionRaw,
    stageRaw,
    cleanupPending,
    revocationPendingBaseUrl,
  ] = stored;

  // A logout/cleanup journal always wins over credential blobs. This is the
  // crash-recovery boundary that prevents a failed SecureStore deletion from
  // silently signing the previous account back in on the next launch.
  if (cleanupPending || revocationPendingBaseUrl) {
    const terminal = await resolvePendingJournals(
      {
        cleanupPending,
        revocationPendingBaseUrl,
        apiKey,
        storedBaseUrl,
        tenantId,
        sessionRaw,
        stageRaw,
      },
      set,
    );
    if (terminal) return;
  }

  const restored = parseRestoredArtifacts(sessionRaw, stageRaw, storedBaseUrl);
  const { session, baseUrl } = restored;
  if (!(await repairUnusableBlobs(restored))) {
    clearInMemoryClientState();
    // `identityPresent`: repairUnusableBlobs only returns false after a delete
    // THREW, so the unparseable credential blob is provably still on disk.
    const cleanup = await clearLocalAuthArtifacts({ identityPresent: true });
    set({
      ...loggedOutState(
        cleanupWarning(cleanup) ??
          "Stored sign-in data could not be safely repaired and was removed. Please sign in again.",
        !cleanup.complete,
      ),
      hydrated: true,
    });
    return;
  }
  const mode = restoredMode(session, baseUrl, apiKey, tenantId);
  const sessionValidation: SessionValidation =
    mode === "session"
      ? isProbablyOnline()
        ? "checking"
        : "offline_cached"
      : "none";
  set({
    apiKey,
    baseUrl,
    // Session mode never writes SECURE_KEY_TENANT, so the stored value is
    // null for session users; take the canonical tenant from the profile
    // to keep top-level tenantId meaningful across relaunches.
    tenantId: mode === "session" && session ? session.tenantId : tenantId,
    session,
    mode,
    sessionValidation,
    hydrated: true,
    authWarning: null,
    localCleanupPending: false,
  });
  if (session && baseUrl && sessionValidation === "checking") {
    void revalidateCachedSession(baseUrl, session, set, get);
  }
}

export function hydrateAuthState(set: AuthSet, get: AuthGet): Promise<void> {
  if (get().hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  const run = runHydrate(set, get).finally(() => {
    hydratePromise = null;
  });
  hydratePromise = run;
  return run;
}
