/**
 * The context epoch this tab last saw from the server.
 *
 * The server stamps `X-Postwave-Context-Epoch` on every authenticated response
 * (apps/api/internal/middleware/context_epoch.go). One value that moves
 * whenever what this person may see or do changes: a demotion, a plan change,
 * a View-as-Viewer toggle, an MFA step-up, a different colleague signing in on
 * the same machine.
 *
 * WHY THIS EXISTS WHEN QUERY KEYS ARE ALREADY TENANT-SCOPED. Keys are
 * `[resource, tenantId, role, …]`, which stops one workspace's cache being
 * served to another. What they cannot see is a change WITHIN one tenant id —
 * and that is precisely the case where the person is still sitting in front of
 * the same screen, with the buttons their old role had.
 *
 * DELIBERATELY IN MEMORY, NOT PERSISTED. The value is re-learned from the very
 * next response, and a persisted copy would be a second source of truth that
 * can be stale at exactly the wrong moment — a cold start would compare a
 * queued write against an epoch from the previous session and refuse work that
 * is perfectly valid. "Not yet known" is the honest state at boot, and
 * `isStaleContext` is built to treat it as "cannot tell" rather than "changed".
 */

import { decideCacheForEpoch } from "@postwave/offline-outbox";

/** Set by the last authenticated response; undefined until one arrives. */
let currentEpoch: string | undefined;

/**
 * Where the epoch the PERSISTED cache was written under is recorded.
 *
 * Not the same value as `currentEpoch`, and not for the same purpose: this one
 * survives a reload precisely so the first response after one can be compared
 * against it. Without it the two rules that are individually correct — "the
 * first sighting is not a change" and "keep the live epoch in memory" — combine
 * to guarantee that a demotion discovered across a reload is never caught,
 * because the cache buster (version:user:tenant) is byte-identical either side
 * of a role change.
 */
const PERSISTED_EPOCH_KEY = "postwave.web.cache-epoch.v1";

/** Subscribers notified when the epoch MOVES (not when it is first learned). */
const listeners = new Set<(epoch: string) => void>();

/**
 * Subscribers notified on EVERY observation, including the first of a session.
 *
 * Separate from `listeners` because the two answer different questions. A cache
 * reconciler must see the first sighting — that is exactly the moment a
 * rehydrated cache can be compared against the context it was written under —
 * while anything reacting to "the context just changed under you" must not.
 */
const observers = new Set<(epoch: string) => void>();

/** The header the server stamps. Lower-case: `Headers.get` is case-insensitive. */
export const CONTEXT_EPOCH_HEADER = "x-postwave-context-epoch";

/** The epoch this tab last saw, or undefined if no response has carried one. */
export function readContextEpoch(): string | undefined {
  return currentEpoch;
}

/**
 * Record the epoch from a response.
 *
 * Returns true when the context CHANGED — meaning the caller held state
 * computed under a different set of permissions and must drop it.
 *
 * First observation is not a change. At boot every response is the first one,
 * and treating that as a change would clear the cache on every page load,
 * turning a correctness mechanism into a performance bug that looks like one.
 */
export function observeContextEpoch(next: string | null | undefined): boolean {
  const value = (next ?? "").trim();
  // An absent header is not evidence of anything: unauthenticated responses
  // carry none by design, and clearing on one would discard a live context
  // every time the app fetched a public endpoint.
  if (!value) return false;
  const previous = currentEpoch;
  currentEpoch = value;
  for (const observer of observers) observer(value);
  if (!previous || previous === value) return false;
  for (const listener of listeners) listener(value);
  return true;
}

/** Subscribe to every observation, first sighting included. Returns unsubscribe. */
export function onContextEpochObserved(listener: (epoch: string) => void): () => void {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
}

/**
 * Reconcile the PERSISTED cache against the first epoch seen this session.
 *
 * Called once the client knows who it is. Returns true when the cache was
 * dropped, so a caller can log or test it.
 *
 * Identity-scoped by the caller, not here: the key is global because the
 * persisted cache it describes is itself replaced whenever the identity-based
 * buster changes, so a second identity never reads the first one's answer.
 */
export function reconcilePersistedCacheEpoch(
  observed: string | null | undefined,
  clearCache: () => void,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeLocalStorage(),
): boolean {
  const value = (observed ?? "").trim();
  if (!value || !storage) return false;
  let persisted: string | null = null;
  try {
    persisted = storage.getItem(PERSISTED_EPOCH_KEY);
  } catch {
    // A blocked or full store is not evidence about the cache. Reading it as
    // "no record" would clear nothing, which is the safe direction here.
    return false;
  }
  const decision = decideCacheForEpoch(persisted, value);
  // CLEAR FIRST, then record. Write-ahead is inverted here: advancing
  // provenance before the cache is actually dropped means a crash in between
  // leaves a record saying the cache belongs to the new epoch while it still
  // holds the old one — and every later launch compares equal and never clears
  // it. Crashing after the clear costs at most one redundant clear.
  if (decision.clearCache) clearCache();
  try {
    storage.setItem(PERSISTED_EPOCH_KEY, decision.persist);
  } catch {
    // Recording failed; the clear already happened.
  }
  return decision.clearCache;
}

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Subscribe to context changes. Returns an unsubscribe. */
export function onContextEpochChange(listener: (epoch: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — resets module state between cases. */
export function resetContextEpoch(): void {
  currentEpoch = undefined;
  listeners.clear();
  // Observers too. Leaving them left a GHOST subscriber alive across tests:
  // the first one to fire records the new provenance and clears ITS client, so
  // the next test reads persisted === observed and clears nothing. The suite
  // silently became order-dependent, and desktop and mobile already cleared
  // theirs — the asymmetry is exactly the drift this package exists to remove.
  observers.clear();
}

/** Test seam — forgets the persisted provenance. */
export function clearPersistedCacheEpoch(
  storage: Pick<Storage, "removeItem"> | undefined = safeLocalStorage() as
    | Pick<Storage, "removeItem">
    | undefined,
): void {
  try {
    storage?.removeItem(PERSISTED_EPOCH_KEY);
  } catch {
    /* nothing to forget */
  }
}

/**
 * Drop a query cache whenever the context it was built under is not the current
 * one — whether that changed mid-session or between two launches.
 *
 * ONE mechanism for both, because they are one question. Subscribing to every
 * observation (not only to a move) and comparing against the epoch PERSISTED
 * alongside the cache covers the in-session change — the persisted value was
 * recorded on the first response of this session — and the across-reload
 * change, which the move-only listener structurally could not: the cache buster
 * is `version:user:tenant`, byte-identical either side of a demotion, and the
 * first response of the new session is a first sighting rather than a change.
 *
 * Extracted from the provider so it can be TESTED. As a `useEffect` body it was
 * reachable only by rendering the whole tree, which is why a review deleted the
 * subscription with every suite still green.
 *
 * `clear()` rather than `invalidateQueries()`: invalidation marks entries stale
 * but keeps SERVING them while it refetches, so the pre-change answer stays on
 * screen during exactly the window this exists to close.
 *
 * Returns an unsubscribe, so a provider that rebuilds its client on an identity
 * change cannot leave the old client subscribed and clearing.
 */
export function subscribeContextEpochCacheReset(
  client: { clear: () => void },
  alsoOnClear?: () => void,
  storage?: Pick<Storage, "getItem" | "setItem">,
): () => void {
  return onContextEpochObserved((epoch) => {
    reconcilePersistedCacheEpoch(
      epoch,
      () => {
        client.clear();
        alsoOnClear?.();
      },
      storage,
    );
  });
}
