import { decideCacheForEpoch } from "@postwave/offline-outbox";

/**
 * The context epoch this window last saw from the server.
 *
 * The server stamps `X-Postwave-Context-Epoch` on every authenticated response
 * (apps/api/internal/middleware/context_epoch.go). One value that moves
 * whenever what this person may see or do changes: a demotion, a plan change,
 * a View-as-Viewer toggle, an MFA step-up, a colleague signing in.
 *
 * WHY THIS EXISTS WHEN QUERY KEYS ARE ALREADY TENANT-SCOPED. Keys carry the
 * tenant id, so one workspace's cache is never served to another. What they
 * cannot see is a change WITHIN one tenant id — and that is exactly the case
 * where the person is still sitting in front of the same window, with the
 * buttons their old role had.
 *
 * DESKTOP HOLDS QUEUED WRITES LONGER THAN ANY OTHER SURFACE. A laptop is shut
 * with work pending and opened days later; the queue survives restarts in the
 * encrypted vault. That makes the gap between "when this was written" and "who
 * I am now" widest here, which is why the same rule matters most on this
 * surface.
 *
 * DELIBERATELY IN MEMORY, NOT PERSISTED. The value is re-learned from the next
 * response, and a persisted copy would be a second source of truth that is
 * stale at exactly the wrong moment: on a cold start it would compare a queued
 * write against an epoch from the previous session and refuse work that is
 * perfectly valid. "Not yet known" is the honest state at launch, and
 * `isStaleContext` treats it as "cannot tell" rather than "changed".
 */

let currentEpoch: string | undefined;
const listeners = new Set<(epoch: string) => void>();

/**
 * Subscribers notified on EVERY observation, including the first of a launch.
 *
 * Separate from `listeners` because they answer different questions. A cache
 * reconciler must see the first sighting — that is exactly when a rehydrated
 * cache can be compared against the context it was written under — while
 * anything reacting to "the context just changed under you" must not.
 */
const observers = new Set<(epoch: string) => void>();

/**
 * Where the epoch the PERSISTED cache was written under is recorded.
 *
 * Desktop persists its query cache for 8 hours against a buster of
 * `version:user:tenant`, which a demotion leaves byte-identical — so on
 * relaunch the pre-demotion cache rehydrates and paints, and the first response
 * is a first sighting rather than a change. Without this value the two rules
 * that are each correct alone ("first sighting is not a change", "keep the live
 * epoch in memory") combine to guarantee the widest-gap case is never caught.
 */
const PERSISTED_EPOCH_KEY = "postwave.desktop.cache-epoch.v1";

/** The header the server stamps. Lower-case: `Headers.get` is case-insensitive. */
export const CONTEXT_EPOCH_HEADER = "x-postwave-context-epoch";

/** The epoch this window last saw, or undefined if no response has carried one. */
export function readContextEpoch(): string | undefined {
  return currentEpoch;
}

/**
 * Record the epoch from a response.
 *
 * Returns true when the context CHANGED — the caller holds state computed under
 * a different set of permissions and must drop it.
 *
 * The first observation is not a change: at launch every response is the first,
 * and treating that as a change would clear the cache on every start.
 */
export function observeContextEpoch(next: string | null | undefined): boolean {
  const value = (next ?? "").trim();
  // An absent header is not evidence of anything — unauthenticated responses
  // carry none by design, and clearing on one would discard a live context
  // whenever the app touched a public endpoint.
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
 * Drop a query cache whose context is not the current one — whether that
 * changed mid-launch or between two launches.
 *
 * ONE mechanism for both, because they are one question: is what this cache
 * holds still an answer this person is allowed to see?
 */
export function subscribeContextEpochCacheReset(
  client: { clear: () => void },
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeLocalStorage(),
): () => void {
  return onContextEpochObserved((epoch) => {
    if (!storage) return;
    let persisted: string | null = null;
    try {
      persisted = storage.getItem(PERSISTED_EPOCH_KEY);
    } catch {
      // A blocked store is not evidence about the cache; not clearing is the
      // safe direction.
      return;
    }
    const decision = decideCacheForEpoch(persisted, epoch);
    // CLEAR FIRST, then record. Write-ahead is inverted here: if provenance is
    // advanced and the process dies before the clear, the record says the cache
    // belongs to the new epoch while it still holds the old one — and the next
    // launch compares equal and never clears it again. Crashing between the two
    // costs at most one redundant clear.
    if (decision.clearCache) client.clear();
    try {
      storage.setItem(PERSISTED_EPOCH_KEY, decision.persist);
    } catch {
      // Recording failed; the clear already happened. A later launch simply
      // judges against older provenance and may clear once more.
    }
  });
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
  observers.clear();
}
