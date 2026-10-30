/**
 * api/event-cache-invalidation.ts
 *
 * Live-on-event TanStack Query cache invalidation, driven by the realtime
 * event-bus (`connectEventBus` in api/eventBus.ts).
 *
 * This complements — it does not replace — the targeted reconnect
 * invalidation in lib/queryClient.ts (`invalidatePrimaryDataOnReconnect`).
 *
 *   - reconnect path:  one-shot refetch of the primary visible domains the
 *                      moment the radio flips back on (covers data that
 *                      changed *while we were offline*).
 *   - this path:       per-server-event invalidation of the exact query-key
 *                      roots a given mutation touches, *while connected*, so
 *                      a teammate's change shows up without the local user
 *                      pulling-to-refresh.
 *
 * Why "query-key roots" and not the full @postwave/query-contract `qk`
 * tuples: the mobile hooks (src/hooks/*) intentionally use a flatter key
 * shape — `["campaigns", tenantId]`, `["subs", tenantId, query]`,
 * `["approvals", tenantId, "pending"]`, etc. — rather than the
 * `[resource, tenantId, role, ...]` shape `qk` produces. Invalidating by the
 * literal `queryKey[0]` root (TanStack does a prefix match) therefore catches
 * every tenant / param / page / filter variant of a domain in one call,
 * which is exactly the granularity a `campaign.*` event implies. The
 * `qk`-shaped roots (web/desktop) share the same first element, so this
 * mapping stays conceptually aligned with the query-contract resource names.
 *
 * Topic shape mirrors the server event-bus: `<domain>.<event>` (e.g.
 * `campaign.sent`, `subscriber.added`) — see @postwave/notifications'
 * NOTIFICATION_EVENTS for the canonical event catalog. We key off the
 * `<domain>` prefix so a new concrete event under a known domain
 * automatically invalidates the right roots without a code change here.
 */
import {
  canonicalResourcesForEvent,
  type CanonicalResource,
} from "@postwave/query-contract";

import type { MobileEventBusEvent } from "./eventBus";

/**
 * Just enough of a cached query for the fan-out predicate below. Declared
 * structurally so the predicate can be handed to a real QueryClient without
 * this module importing TanStack's `Query` type (and the cycle through
 * lib/queryClient.ts that comes with it).
 */
export interface CachedQueryLike {
  state?: { data?: unknown };
}

/**
 * Minimal slice of QueryClient this module needs. Declaring it locally keeps
 * the mapping pure + trivially unit-testable (no real QueryClient required)
 * and avoids a hard import cycle through lib/queryClient.ts.
 *
 * The staleness MARK and the REFETCH are separate members on purpose — see
 * `invalidateRoot`: one event must dirty everything under a root while paying
 * for at most one request per query.
 */
export interface InvalidatingClient {
  invalidateQueries(filter: {
    queryKey: readonly unknown[];
    refetchType?: "active" | "inactive" | "all" | "none";
  }): Promise<unknown>;
  refetchQueries(filter: {
    queryKey: readonly unknown[];
    type?: "active" | "inactive" | "all";
    predicate?: (query: CachedQueryLike) => boolean;
  }): Promise<unknown>;
}

/**
 * Adapter: canonical resource (from @postwave/query-contract's shared
 * event→resource authority — the SAME table web + desktop consume) → the
 * mobile query-key roots that back it. Roots are the literal `queryKey[0]`
 * values the hooks in src/hooks/* (and a couple of inline screen queries) use;
 * a canonical resource may fan out to several mobile-local satellite views
 * (e.g. `campaign` → detail + report + A/B + archive) the other surfaces don't
 * have. Invalidating by `queryKey[0]` alone lets TanStack's prefix match catch
 * every tenant / param / page / filter variant in one call.
 *
 * Bringing mobile onto @postwave/query-contract closes the "mobile off the
 * contract" gap: WHICH resources an event dirties is now decided once, in the
 * shared authority, instead of a third hand-rolled table that disagreed with
 * web + desktop (notably `approval.*`, which mobile used to refresh only the
 * approvals queue and never the dashboard badge).
 *
 * MUST stay TOTAL over `CanonicalResource`; TypeScript enforces this at compile
 * time (a dropped resource is a type error) and the drift test asserts it.
 */
const MOBILE_RESOURCE_ROOTS: Record<CanonicalResource, readonly string[]> = {
  campaigns: ["campaigns"],
  campaign: ["campaign", "campaign-report", "ab-results", "archive"],
  subscribers: ["subs"],
  subscriber: ["sub", "sub-timeline"],
  lists: ["lists"],
  suppressions: ["suppressions"],
  approvals: ["approvals"],
  audit: ["audit"],
  dashboard: ["dashboard", "dashboard-stats"],
  // hooks/useDeliverability.ts — the hub score/grade/breaches/auto-throttle
  // state (`deliverability-hub`) and the actionable blocklist listings with
  // their delist links (`blocklist-hits`). Both are separate endpoints and both
  // render on app/(tabs)/deliverability.tsx, so both roots are named; the
  // home-screen widget mirrors the hub query and follows it without an entry
  // of its own.
  //
  // Deliberately NOT included: the same hook file's `dns-health` and
  // `sender-reputation` roots. They render on app/(tabs)/custom-domains.tsx and
  // describe domain configuration, which a send-health threshold breach does
  // not change. Invalidating them here would refetch two endpoints on an event
  // that cannot alter their answer.
  deliverability: ["deliverability-hub", "blocklist-hits"],
  // hooks/useReferrals.ts keys every referral view under one root
  // (["referrals", "stats"|"leaderboard"|"program", …]), so the single root
  // prefix-matches all three.
  referrals: ["referrals"],
  // The notification inbox (app/(tabs)/notifications.tsx) reads this feed root;
  // the server's `notification.created` event keeps it live (see the
  // notification.* subscription in EVENT_INVALIDATION_TOPICS below).
  notificationFeed: ["notification-feed"],
};

/**
 * The wildcard topics the invalidation stream subscribes to. This is mobile's
 * own surface choice — kept explicit rather than derived from the contract's
 * full domain set. Mobile has an audit feed screen (`audit.*`) AND a Lists tab
 * (`app/(tabs)/lists/index.tsx`, `useLists` → `["lists"]`), so it subscribes to
 * `list.*` — `list.subscriber.added` is a real bus event that changes per-list
 * member counts. It does NOT subscribe to `sequence.*` (never published to the
 * bus). Ordered for a stable, testable CSV.
 */
export const EVENT_INVALIDATION_TOPICS: readonly string[] = [
  "campaign.*",
  "subscriber.*",
  "list.*",
  "approval.*",
  "audit.*",
  // Makes the notification inbox (app/(tabs)/notifications.tsx) live — the
  // server's notifyfanout `notification.created` event invalidates the
  // `notification-feed` root (see MOBILE_RESOURCE_ROOTS.notificationFeed).
  "notification.*",
  // Deliverability hub degradation (deliverability_hub/hub.go emitDegraded).
  // Mobile is the surface most likely to be the ONLY one open when a send
  // starts crawling, and the hub query's 60s staleTime is too coarse for an
  // active incident.
  "list_health.*",
  // Referral milestone / payout events (referrals/events.go) move the stats
  // and leaderboard the Referrals tab is showing.
  "referral.*",
];

/**
 * queryRootsForEvent — pure map from an event topic to the mobile query-key
 * roots that should be invalidated. WHICH resources a topic dirties comes from
 * the shared `canonicalResourcesForEvent` authority; this only translates them
 * into mobile's flat roots via `MOBILE_RESOURCE_ROOTS`. Accepts a concrete
 * event (`campaign.sent`) or a bare domain (`campaign`). Returns `[]` for
 * unknown / unmapped / malformed topics. De-duplicated, order-stable.
 */
export function queryRootsForEvent(topic: string): readonly string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const resource of canonicalResourcesForEvent(topic)) {
    for (const root of MOBILE_RESOURCE_ROOTS[resource]) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

/**
 * True when refetching this query costs exactly ONE request.
 *
 * TanStack refetches EVERY loaded page of an infinite query, walking the
 * cursors in sequence. Several of the roots above back infinite lists (`subs`,
 * `campaigns`, `audit`, `notification-feed`), so a reader who had paged six
 * deep into a list turned one teammate edit into six of the most expensive
 * reads in the product — and a burst of them into six per event. That is
 * exactly the storm hooks/useAuditTail was written to avoid, re-created from
 * the cache side.
 *
 * The test is the CACHED PAGE COUNT, not "is this an infinite query": an
 * infinite list the user has not scrolled holds one page and is as cheap as
 * any other query, so it stays live. A query with nothing cached yet is also
 * one request (or none, if it is inactive).
 */
export function refetchesAsSingleRequest(query: CachedQueryLike): boolean {
  const pages = (query?.state?.data as { pages?: unknown } | undefined)?.pages;
  return !Array.isArray(pages) || pages.length <= 1;
}

/**
 * Dirty one root without fanning out to N page requests.
 *
 * Two calls, deliberately: the invalidation MARKS every variant under the root
 * stale but refetches nothing (`refetchType: "none"`), and the refetch is then
 * issued only for the queries that cost a single request. A deeply-paged list
 * is therefore still known-stale — so it refetches the moment the reader
 * brings it back to the front, and never serves an answer it knows is old —
 * it just does not pay for its whole history on a background event.
 */
function invalidateRoot(client: InvalidatingClient, root: string): void {
  void client.invalidateQueries({ queryKey: [root], refetchType: "none" });
  void client.refetchQueries({
    queryKey: [root],
    type: "active",
    predicate: refetchesAsSingleRequest,
  });
}

/**
 * invalidateForEvent — invalidate the query-key roots mapped to a single
 * realtime event. Each root is invalidated by its `queryKey[0]` alone so
 * TanStack's prefix match catches every tenant / param / page variant.
 *
 * Safe to call for any event: malformed events (no string topic) and
 * unmapped domains are no-ops. Returns the number of roots invalidated so
 * callers/tests can assert without poking the client.
 */
export function invalidateForEvent(
  client: InvalidatingClient,
  evt: MobileEventBusEvent,
): number {
  const topic = evt?.topic;
  if (typeof topic !== "string") return 0;
  const roots = queryRootsForEvent(topic);
  for (const root of roots) {
    invalidateRoot(client, root);
  }
  return roots.length;
}

/** Default trailing-debounce window (ms) for coalesced invalidation. */
export const INVALIDATION_DEBOUNCE_MS = 600;

/**
 * Coalescing ceiling (NATIVE#63). A trailing-only debounce collapses a burst
 * correctly but STARVES during a sustained stream: while a large send keeps
 * firing `subscriber.engagement_updated`, the trailing window is reset on
 * every event and the dashboard the user is watching never refetches until the
 * send finishes. Past this ceiling a root flushes regardless of continued
 * traffic, so a live send updates roughly every five seconds instead of once
 * at the end.
 */
export const INVALIDATION_MAX_WAIT_MS = 5_000;

/**
 * Minimal timer surface so the debouncer is unit-testable with fake timers
 * (vi.useFakeTimers) without leaning on a specific global shape.
 */
export interface DebounceTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Clock read; defaults to Date.now (which vi.useFakeTimers also fakes). */
  now?: () => number;
}

const REAL_TIMERS: DebounceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * A debounced invalidator: same call signature as `invalidateForEvent`, but
 * it COALESCES bursts. A live send fires a storm of
 * `subscriber.engagement_updated` events (one per open/click); without this,
 * each one triggers an immediate `invalidateQueries` → a refetch storm on
 * cellular. Instead we accumulate the affected roots and flush each root at
 * most once per trailing `delayMs` window.
 *
 * Per-root trailing debounce (not one global timer) so an unrelated domain's
 * single event still flushes promptly on its own schedule rather than being
 * dragged out by a noisy neighbour.
 */
export interface DebouncedInvalidator {
  /** Queue the roots for `evt`; returns the count queued (0 if none). */
  push(evt: MobileEventBusEvent): number;
  /** Flush every pending root immediately (e.g. on teardown). */
  flush(): void;
  /** Cancel all pending timers without flushing. */
  cancel(): void;
}

export function createDebouncedInvalidator(
  client: InvalidatingClient,
  options?: { delayMs?: number; maxWaitMs?: number; timers?: DebounceTimers },
): DebouncedInvalidator {
  const delayMs = options?.delayMs ?? INVALIDATION_DEBOUNCE_MS;
  const maxWaitMs = options?.maxWaitMs ?? INVALIDATION_MAX_WAIT_MS;
  const timers = options?.timers ?? REAL_TIMERS;
  const now = (): number => (timers.now ?? Date.now)();
  // root → pending timer handle. Presence in the map == a flush is scheduled.
  const pending = new Map<string, unknown>();
  // root → when the currently-pending window first opened, for the ceiling.
  const queuedSince = new Map<string, number>();

  function flushRoot(root: string): void {
    pending.delete(root);
    queuedSince.delete(root);
    invalidateRoot(client, root);
  }

  return {
    push(evt: MobileEventBusEvent): number {
      const topic = evt?.topic;
      if (typeof topic !== "string") return 0;
      const roots = queryRootsForEvent(topic);
      const at = now();
      for (const root of roots) {
        // Reset the trailing window: the latest event in a burst wins, so a
        // sustained storm flushes once `delayMs` after the LAST event —
        // unless the ceiling below has been reached.
        const existing = pending.get(root);
        if (existing !== undefined) timers.clearTimeout(existing);
        const since = queuedSince.get(root) ?? at;
        if (maxWaitMs > 0 && at - since >= maxWaitMs) {
          flushRoot(root);
          continue;
        }
        queuedSince.set(root, since);
        pending.set(
          root,
          timers.setTimeout(() => flushRoot(root), delayMs),
        );
      }
      return roots.length;
    },
    flush(): void {
      // Snapshot keys first: flushRoot mutates `pending` during iteration.
      for (const root of [...pending.keys()]) {
        const handle = pending.get(root);
        if (handle !== undefined) timers.clearTimeout(handle);
        flushRoot(root);
      }
    },
    cancel(): void {
      for (const handle of pending.values()) timers.clearTimeout(handle);
      pending.clear();
      queuedSince.clear();
    },
  };
}
