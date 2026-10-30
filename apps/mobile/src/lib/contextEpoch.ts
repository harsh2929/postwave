import AsyncStorage from "@react-native-async-storage/async-storage";
import { decideCacheForEpoch } from "@postwave/offline-outbox";

/**
 * The context epoch this app last saw from the server.
 *
 * The server stamps `X-Postwave-Context-Epoch` on every authenticated response
 * (apps/api/internal/middleware/context_epoch.go). One value that moves
 * whenever what this person may see or do changes.
 *
 * WHY MOBILE NEEDS IT WHEN `assertCurrentAuthScope` ALREADY RE-PROVES IDENTITY.
 * That check compares origin, tenant, principal and role — all facts the CLIENT
 * holds, so it catches what the client can see changing. It cannot see a change
 * only the server knows about: a plan downgrade that removes a feature, or a
 * role change that has not yet reached this device's auth store. The epoch is
 * the server's own answer to "is this the same context?", so it needs no
 * agreement between the two sides about how to derive one.
 *
 * DELIBERATELY IN MEMORY, NOT PERSISTED. It is re-learned from the next
 * response. A persisted copy would be stale at exactly the wrong moment — on a
 * cold start it would compare a queued write against the previous session's
 * epoch and refuse work that is perfectly valid. "Not yet known" is the honest
 * state at launch, and `isStaleContext` treats it as "cannot tell".
 */

let currentEpoch: string | undefined;

/** Subscribers notified when the epoch MOVES (not when it is first learned). */
const listeners = new Set<(epoch: string) => void>();

/**
 * Subscribers notified on EVERY observation, including the first of a launch.
 *
 * A cache reconciler must see the first sighting so any legacy/rehydrated cache
 * can be compared against the context it was written under. The current v5
 * persister excludes query responses, but the provenance check is deliberately
 * defensive against older blobs and a future policy regression.
 */
const observers = new Set<(epoch: string) => void>();

/**
 * Where the last cache-reconciled epoch is recorded.
 *
 * Query responses are NOT persisted by the current v5 policy
 * (`shouldPersistQuery` is always false); only allowlisted paused mutations are.
 * Keeping independent provenance still contains an older rehydrated blob or a
 * future persistence-policy regression, while the live reset below protects
 * the in-memory cache that actually exists today.
 */
const PERSISTED_EPOCH_KEY = "postwave.mobile.cache-epoch.v1";

/** The header the server stamps. Lower-case: `Headers.get` is case-insensitive. */
export const CONTEXT_EPOCH_HEADER = "x-postwave-context-epoch";

/** The epoch this app last saw, or undefined if no response has carried one. */
export function readContextEpoch(): string | undefined {
  return currentEpoch;
}

/**
 * Record the epoch from a response. Returns true when the context CHANGED.
 *
 * The first observation is not a change: at launch every response is the first.
 * An absent header is not evidence of anything — unauthenticated responses
 * carry none by design.
 */
export function observeContextEpoch(next: string | null | undefined): boolean {
  const value = (next ?? "").trim();
  if (!value) return false;
  const previous = currentEpoch;
  currentEpoch = value;
  for (const observer of observers) observer(value);
  if (!previous || previous === value) return false;
  for (const listener of listeners) listener(value);
  return true;
}

/** Subscribe to every observation, first sighting included. Returns unsubscribe. */
export function onContextEpochObserved(
  listener: (epoch: string) => void,
): () => void {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
}

/** Subscribe to context changes. Returns an unsubscribe. */
export function onContextEpochChange(
  listener: (epoch: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop the query cache whenever the server reports the context moved.
 *
 * Mobile keeps server query answers in memory for the life of the process.
 * Without this, a demoted user keeps answers computed under the old role after
 * the next authenticated response proves the context moved. The persisted
 * provenance is defense-in-depth for legacy or accidentally re-enabled query
 * rehydration; current v5 persistence deliberately excludes query responses.
 *
 * `clear()` rather than invalidation: invalidation keeps serving stale entries
 * while it refetches, which is the window this exists to close.
 *
 * Idempotent — Fast Refresh and a remounting root would otherwise subscribe
 * more than once and clear repeatedly for one change.
 */
let cacheResetWired = false;

type QueryCacheHandle = {
  clear: () => void;
  getAll?: () => QueryCacheEntry[];
  remove?(query: QueryCacheEntry): void;
};

type QueryCacheEntry = {
  reset?: () => void;
  state?: {
    dataUpdateCount?: number;
    fetchStatus?: unknown;
  };
};

type QueryCacheSnapshot =
  | {
      query: QueryCacheEntry;
      dataUpdateCount: number | null;
      wasInFlight: boolean;
    }[]
  | null;

function snapshotLiveQueryCache(client: {
  getQueryCache: () => QueryCacheHandle;
}): QueryCacheSnapshot {
  const queries = client.getQueryCache().getAll?.();
  if (!queries) return null;
  return queries.map((query) => ({
    query,
    dataUpdateCount:
      typeof query.state?.dataUpdateCount === "number"
        ? query.state.dataUpdateCount
        : null,
    // A result that was already in flight when the new epoch was observed is
    // not demonstrably owned by that epoch. Its header may have arrived under
    // the retired context before another response revealed the change.
    wasInFlight:
      query.state?.fetchStatus === "fetching" ||
      query.state?.fetchStatus === "paused",
  }));
}

function mergeCacheSnapshots(
  older: QueryCacheSnapshot,
  newer: QueryCacheSnapshot,
): QueryCacheSnapshot {
  if (older === null || newer === null) return null;
  const superseded = new Set(newer.map((entry) => entry.query));
  return [...newer, ...older.filter((entry) => !superseded.has(entry.query))];
}

/**
 * Reset observed results before removing their cache entries.
 *
 * TanStack's `QueryCache.clear()` removes and destroys queries, but an active
 * QueryObserver can retain its last successful result. That is normally a
 * harmless implementation detail; during a role/epoch demotion it would keep
 * protected rows painted on a mounted screen. `reset()` publishes the empty
 * initial state to those observers and cancels their in-flight work, then the
 * clear removes every query entry. The optional seam keeps small test clients
 * structurally compatible; the production QueryCache implements `getAll` and
 * each production Query implements `reset`.
 */
function clearLiveQueryCache(client: {
  getQueryCache: () => QueryCacheHandle;
}): void {
  const cache = client.getQueryCache();
  for (const query of cache.getAll?.() ?? []) query.reset?.();
  cache.clear();
}

/**
 * Retire only cache state that belonged to an observation's starting point.
 *
 * `observeContextEpoch` runs inside the fetch wrapper before that Response is
 * returned to the SDK and before TanStack can publish its parsed data. A query
 * created after this snapshot, or an idle query whose data-update counter moves
 * afterward, is therefore demonstrably post-observation and is preserved. An
 * unchanged query — and any query already in flight at the boundary — is reset
 * and removed. This prevents a delayed provenance read from erasing new-context
 * results while still failing closed over the old-context cache.
 */
function clearObservedQueryCache(
  client: { getQueryCache: () => QueryCacheHandle },
  snapshot: QueryCacheSnapshot,
): void {
  const cache = client.getQueryCache();
  if (snapshot === null || !cache.getAll || !cache.remove) {
    clearLiveQueryCache(client);
    return;
  }
  const live = new Set(cache.getAll());
  for (const entry of snapshot) {
    const currentCount = entry.query.state?.dataUpdateCount;
    const demonstrablyUpdated =
      !entry.wasInFlight &&
      entry.dataUpdateCount !== null &&
      typeof currentCount === "number" &&
      currentCount !== entry.dataUpdateCount;
    if (demonstrablyUpdated) continue;
    // Reset even if another path already removed the Query from the cache:
    // TanStack observers can retain their last result after removal. The
    // snapshot's object reference is the only remaining route to blank it.
    entry.query.reset?.();
    if (live.has(entry.query)) cache.remove(entry.query);
  }
}

export function wireContextEpochCacheReset(
  client: { getQueryCache: () => QueryCacheHandle },
  storage: {
    getItem: (k: string) => Promise<string | null>;
    setItem: (k: string, v: string) => Promise<void>;
  } = AsyncStorage,
): void {
  if (cacheResetWired) return;
  cacheResetWired = true;
  // SERIALISED. The listener is synchronous but the storage is not, so two
  // responses landing together would otherwise both park on `getItem`, both
  // read the same provenance, and both decide to clear — clearing twice for one
  // change, with the second wipe destroying what the first refetch repopulated.
  // Their `setItem` promises can also resolve out of order, leaving provenance
  // permanently behind the live epoch so every later launch clears spuriously
  // and never converges. A chain makes each observation see the previous one's
  // completed write.
  let chain: Promise<void> = Promise.resolve();
  let latestObservation = 0;
  let latestObservedEpoch: string | undefined;
  let latestCacheAtObservation: QueryCacheSnapshot = null;
  let lastDrainedObservation = 0;
  let pendingCacheBoundary:
    | { observation: number; snapshot: QueryCacheSnapshot }
    | undefined;
  const enqueueCacheBoundary = (
    observation: number,
    snapshot: QueryCacheSnapshot,
  ): void => {
    // A newer boundary may already have been retired synchronously while an
    // older storage read was still pending. Never let that late completion
    // recreate an obsolete boundary and erase data fetched afterward.
    if (observation <= lastDrainedObservation) return;
    // Newer metadata supersedes older metadata for the SAME query, so a stale
    // `wasInFlight` bit cannot erase a safe update. Older query objects absent
    // from the new cache remain in the merged boundary: a mounted observer can
    // retain their result even after another path removed the cache entry.
    if (!pendingCacheBoundary) {
      pendingCacheBoundary = { observation, snapshot };
    } else if (observation > pendingCacheBoundary.observation) {
      pendingCacheBoundary = {
        observation,
        snapshot: mergeCacheSnapshots(pendingCacheBoundary.snapshot, snapshot),
      };
    }
  };
  const drainCacheBoundary = (): void => {
    if (!pendingCacheBoundary) return;
    const { observation, snapshot } = pendingCacheBoundary;
    pendingCacheBoundary = undefined;
    clearObservedQueryCache(client, snapshot);
    lastDrainedObservation = Math.max(lastDrainedObservation, observation);
  };
  onContextEpochObserved((epoch) => {
    const observation = ++latestObservation;
    const cacheAtObservation = snapshotLiveQueryCache(client);
    latestObservedEpoch = epoch;
    latestCacheAtObservation = cacheAtObservation;
    chain = chain.then(async () => {
      let persisted: string | null = null;
      try {
        persisted = await storage.getItem(PERSISTED_EPOCH_KEY);
      } catch {
        // UNKNOWN PROVENANCE FAILS CLOSED. The live query cache can contain
        // protected answers from the role/epoch that just lost access. A
        // storage failure gives us no basis for attributing those answers to
        // the new context, so keeping them is the dangerous direction.
        //
        // Carry this observation's starting cache to the newest owner.
        // Silently dropping it here is a leak: the successor may read
        // provenance equal to its epoch and otherwise leave old-context rows
        // beside new-context data. Carrying the SNAPSHOT rather than a boolean
        // also means a same-B successor does not erase B data published after
        // that snapshot.
        if (observation !== latestObservation) {
          enqueueCacheBoundary(observation, cacheAtObservation);
          return;
        }
        // A carried boundary (normally the snapshot taken at the A -> B
        // change) already covers every ambiguous pre-B entry. Adding a later
        // same-B snapshot would unnecessarily erase B data published between
        // those observations. With no carried boundary, this observation must
        // supply one so an isolated read failure still fails closed.
        if (!pendingCacheBoundary) {
          enqueueCacheBoundary(observation, cacheAtObservation);
        }
        drainCacheBoundary();
        return;
      }
      // `getItem` yielded to the event loop. If identity/role moved again in
      // that window, this result belongs to the retired observation. Only the
      // newest observation may mutate the cache or advance its provenance.
      if (observation !== latestObservation) {
        // A successful read can still retire before it gets to decide. Carry
        // its cache boundary only when a genuinely different epoch superseded
        // it; duplicate responses for one epoch do not manufacture a wipe.
        if (epoch !== latestObservedEpoch) {
          enqueueCacheBoundary(observation, cacheAtObservation);
        }
        return;
      }
      const decision = decideCacheForEpoch(persisted, epoch);
      if (decision.clearCache && !pendingCacheBoundary) {
        enqueueCacheBoundary(observation, cacheAtObservation);
      }
      if (pendingCacheBoundary) {
        // QUERIES ONLY — never `client.clear()`, which also empties the
        // mutationCache. On mobile the queued offline writes ARE react-query
        // mutations, and the persisted blob holds nothing else
        // (`shouldPersistQuery` returns false unconditionally). Clearing the
        // whole client would silently destroy the person's pending work — the
        // exact opposite of what STALE_CONTEXT_MESSAGE promises.
        drainCacheBoundary();
      }
      // ONLY WHEN IT ACTUALLY MOVED. The epoch is stable for the whole life of
      // a context, so all but the first response of a launch re-persist a byte
      // for byte identical value. This listener runs on EVERY authenticated
      // response, so an unconditional write meant a native storage write per
      // API call — on a list screen that is a write per pull-to-refresh, per
      // page, per tab, each one a JSI hop and a disk touch that changes
      // nothing. The read above is the provenance check and has to happen; the
      // write only has to happen when it would change the record.
      //
      // RECORDED AFTER THE CLEAR, not before.
      //
      // Write-ahead is inverted here. If provenance is advanced first and the
      // process dies before the clear — and on iOS a backgrounded app is killed
      // without warning, which is a normal flow rather than a rare race — the
      // record says "this cache belongs to epoch B" while the cache is still
      // A-era. The next launch compares B against B, finds them equal, and
      // never clears it again. Clearing first means a crash in the window costs
      // at most one redundant clear next launch, which is the cheap direction.
      if (persisted === decision.persist) return;
      try {
        await storage.setItem(PERSISTED_EPOCH_KEY, decision.persist);
      } catch {
        // Recording failed; the clear already happened. The next launch will
        // simply judge against older provenance and may clear once more.
      }
    });
  });
  // The observer above runs before change listeners in observeContextEpoch,
  // so this retires the exact pre-change boundary synchronously, before the
  // Response returns to the SDK/query layer. Native storage can reject or hang
  // indefinitely; neither may leave rows from the old role/tenant painted.
  // Async provenance remains defense in depth for the first sighting of a
  // launch, where there is no observed in-memory move to act on.
  onContextEpochChange(() => {
    enqueueCacheBoundary(latestObservation, latestCacheAtObservation);
    drainCacheBoundary();
  });
}

/** Test seam — resets module state between cases. */
export function resetContextEpoch(): void {
  currentEpoch = undefined;
  listeners.clear();
  observers.clear();
  cacheResetWired = false;
}
