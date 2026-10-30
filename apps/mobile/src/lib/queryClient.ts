/**
 * lib/queryClient.ts
 *
 * Single TanStack Query client wired to mobile-friendly defaults:
 *
 *   - staleTime: 30s. Mobile bandwidth + battery favour stale-while-
 *     revalidate over aggressive refetches; 30s feels fresh enough for
 *     dashboard tiles and lists.
 *
 *   - retry: 1. Network blips are common on phones, but the SDK ALREADY
 *     retries idempotent requests ~3x at the HTTP layer, and the two
 *     multiply. See the note on the option itself: at retry:2 the worst-case
 *     time from tap to error ran to minutes, which is a worse answer than a
 *     fast failure with a Retry button.
 *
 *   - refetchOnWindowFocus: false. RN focus is wired explicitly in
 *     lib/connectivity.ts using AppState + TanStack focusManager.
 *
 *   - gcTime: 2m. Detail pages and long feeds can carry many rows; once
 *     no screen observes them, evict faster than the web default to keep
 *     the mobile heap lean.
 */
import { QueryClient, type Mutation, type Query } from "@tanstack/react-query";
import { wireContextEpochCacheReset } from "./contextEpoch";

import { queryPersister } from "./secureQueryPersister";

/**
 * Query-key roots that are refetched when the device comes back online.
 *
 * On reconnect we deliberately do NOT call `invalidateQueries()` with no
 * filter — that stampedes every cached query (detail pages, audit feeds,
 * settings, ops screens, the lot) the instant the radio flips back on,
 * which is wasteful on cellular and can spike the API. Instead we refetch
 * only the primary, at-a-glance data domains the user is most likely
 * looking at: the dashboard, campaign/subscriber/sequence/list overviews.
 *
 * Everything else (detail screens, audit, integrations, settings, ops)
 * refetches on its own screen focus via TanStack's focusManager, so it
 * stays fresh without being part of the reconnect fan-out.
 *
 * Roots are the literal `queryKey[0]` values used by the app's hooks:
 *   - "dashboard-stats"     — useDashboardStatsQuery (hooks/useDashboard.ts)
 *   - "dashboard"           — dashboard tiles (event-cache-invalidation roots)
 *   - "dashboard-anomalies" — useDashboardAnomalies
 *   - "dashboard-goals"     — useGoalsProgress
 *   - "approvals"           — usePendingApprovalsCount
 *   - "campaigns"           — useCampaignsList / useCampaigns
 *   - "subs"                — useSubscribers
 *   - "sequences"           — app/(tabs)/sequences
 *   - "lists"               — useListOptions (hooks/useListOptions.ts)
 *
 * The last two additions are both READ FROM THE DASHBOARD, which is the screen
 * a user is most likely staring at when the radio comes back. Leaving them out
 * meant returning from airplane mode restored the six tiles while the detected
 * anomalies underneath them, and the pending-approvals count MIRRORED TO THE
 * HOME-SCREEN WIDGET, stayed as they were before the outage — stale, and
 * unmarked as stale, next to numbers that had just refreshed.
 */
export const RECONNECT_REFETCH_QUERY_ROOTS = new Set<string>([
  "dashboard-stats",
  "dashboard",
  "dashboard-anomalies",
  "dashboard-goals",
  "approvals",
  "campaigns",
  "subs",
  "sequences",
  "lists",
]);

/** True when a query belongs to a primary reconnect-refetch domain. */
export function isReconnectRefetchQuery(query: Query): boolean {
  const root = query.queryKey[0];
  return typeof root === "string" && RECONNECT_REFETCH_QUERY_ROOTS.has(root);
}

/**
 * Targeted reconnect invalidation. Pass the app's QueryClient; only the
 * primary visible data domains are invalidated (see
 * RECONNECT_REFETCH_QUERY_ROOTS) — never a blanket refetch of the cache.
 */
export function invalidatePrimaryDataOnReconnect(
  client: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  return client.invalidateQueries(
    { predicate: isReconnectRefetchQuery },
    // JOIN the reconnect refetch TanStack has ALREADY started — never cancel it.
    //
    // `refetchOnReconnect` is true for every query in this client, so when
    // `onlineManager` flips, TanStack's own `queryCache.onOnline()` already
    // refetches every STALE active query. This call runs a beat later (the
    // reconnect handler awaits `revalidateSession()` first), and
    // `invalidateQueries` defaults to `cancelRefetch: true` — so it aborted
    // the request TanStack had in flight and issued a second one for the same
    // key. Measured against the app's real client with 6 plain queries and a
    // 10-page infinite subscriber list mounted: 21 requests on one reconnect
    // with 5 killed mid-flight, where 16 do the same work. Those are the most
    // expensive requests the app ever makes, because they go out the instant a
    // flaky radio came back.
    //
    // `cancelRefetch: false` only changes what happens when a fetch for the
    // SAME key is already running: join it instead of restarting it. The
    // reason this invalidation exists is untouched — a user offline for less
    // than `staleTime` leaves the primary roots FRESH, so TanStack skips them
    // and only `invalidate()` marks them for refetch. In that case nothing is
    // in flight to join and the request is made exactly as before.
    { cancelRefetch: false },
  );
}

export function shouldPersistQuery(query: Query): boolean {
  // Query responses can contain customer, DNS, sender, campaign, or audit
  // data even when the top-level key appears harmless. Cold-offline screens
  // use explicit minimized SecureStore vault projections instead. Only
  // allowlisted paused mutations are persisted by this TanStack persister.
  void query;
  return false;
}

/**
 * Only PAUSED offline-safe mutations are durable.
 *
 * The `offlineSafe` meta says a write MAY be resumed after a restart; it does
 * not say this particular one still needs to be. Without the `isPaused` half,
 * every SUCCESSFUL ONLINE write was dehydrated too — and TanStack persists a
 * mutation's whole `state`, including the `context` an optimistic `onMutate`
 * returns, which in this app is the rollback snapshot of the cached list the
 * write overwrote. So a subscriber edit made on wifi chunked and encrypted a
 * copy of the surrounding customer rows into the Keychain, on a persister that
 * fires on every cache event and evicts the OLDEST entries when the budget is
 * exceeded (lib/secureQueryPersister.ts) — meaning the genuinely queued
 * offline writes were competing for space with writes that had already landed.
 *
 * A non-paused mutation is either finished or on the wire right now; neither
 * has anything left for a restart to resume, and mutations are `retry: 0`
 * precisely because replaying an uncertain one is worse than losing it.
 */
export function shouldPersistMutation(mutation: Mutation): boolean {
  return (
    mutation.options.meta?.offlineSafe === true &&
    mutation.state.isPaused === true
  );
}

export const offlineSafeMutationMeta = {
  offlineSafe: true,
} as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 2 * 60 * 1000,
      // The @postwave/sdk already retries idempotent requests ~3x at the
      // HTTP layer, so a single Query-level retry is plenty. (retry:2 here
      // stacked on the SDK's 3 → up to ~12 attempts and multi-minute
      // spinner hangs on flaky cellular.)
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      networkMode: "online",
      retry: 0, // Never auto-retry mutations — duplicates are worse than failures.
    },
  },
});

export { queryPersister } from "./secureQueryPersister";

export const queryPersistOptions = {
  persister: queryPersister,
  maxAge: 2 * 60 * 60 * 1000,
  // v5 adds a required durable operation/idempotency identity to every
  // persisted mutation. Purge older queued records instead of replaying a
  // write that cannot remain deduplicated across process death.
  buster: "postwave-mobile-encrypted-v5",
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersistQuery,
    shouldDehydrateMutation: shouldPersistMutation,
  },
};

// Drop cached ANSWERS when the server reports the caller's context moved.
//
// A correction: an earlier version of this comment said mobile "persists
// queries, so a demotion survives an app restart". It does NOT —
// `shouldPersistQuery` returns false unconditionally, and the persisted blob
// holds only allowlisted paused MUTATIONS. So the restart scenario does not
// apply here, and clearing the whole client would have destroyed the queued
// offline writes instead. What this does cover is the in-session case: a
// demotion or plan change while the app is open leaves the in-memory query
// cache full of answers computed under permissions the person no longer has,
// behind affordances the UI still offers.
//
// Wired at module scope so it is live before the first response can arrive,
// and idempotent inside.
wireContextEpochCacheReset(queryClient);
