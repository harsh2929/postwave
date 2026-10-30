/**
 * cache-invalidator — route live server events through TanStack Query
 * cache invalidation at the APP level, regardless of which page is mounted.
 *
 * Why this exists (initiative #2 — event-bus cache invalidation): the
 * desktop already pipes server events to OS notifications via the shared
 * SSE event-bus (lib/app-notifier.ts), but those same events were NOT used
 * to refresh cached data. So a campaign finishing its send, a subscriber
 * bouncing, an approval landing, etc. left the TanStack Query cache stale
 * until each query's staleTime elapsed (lists 30s / details 10s) or the
 * user manually refocused — the UI lagged reality. This module subscribes
 * to the SAME shared event-bus (lib/event-bus.ts — no new transport) and,
 * on a relevant event, invalidates the matching @postwave/query-contract
 * `qk` resource-prefix keys so affected queries refetch promptly.
 *
 * Why prefix invalidation (and why we don't resolve tenant/role here): the
 * shared `qk` factory keys ALWAYS lead with the resource string
 * (`[resource, tenantId, role, ...subkey]` — see @postwave/query-contract).
 * Invalidating by the resource prefix `[resource]` therefore covers every
 * tenant/role/params variant in cache without the event site needing to
 * know the current identity. This mirrors the proven post-replay
 * invalidation in api-client.ts (invalidateQueriesForReplayedResources).
 *
 * Relationship to app-notifier: this is ADDITIVE. The notifier still owns
 * OS notifications for its curated high-signal subset; this owns cache
 * freshness for a broader set of data-mutating event families. Both read
 * the one shared event-bus; neither disturbs the other.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  canonicalResourcesForEvent,
  type CanonicalResource,
} from "@postwave/query-contract";

import { type EventBusMessage, useEventSubscription } from "./event-bus";

/**
 * The wildcard topic families this router subscribes to. These are the
 * server event families that mutate cached, queryable data on the desktop.
 * Chatty collaboration topics (cursor.* / presence.* / selection.*) and the
 * high-volume audit firehose itself are deliberately excluded — they don't
 * back a TanStack query whose freshness a human notices.
 *
 * The families desktop subscribes to:
 *   - campaign.*  — apps/api/internal/campaigns/handlers.go emit()
 *                   (campaign.created / .updated / .sent)
 *   - subscriber.* — apps/api/internal/listmonk_events Wire* constants
 *                    (subscriber.opened/.clicked/.delivered/.bounced/
 *                    .complained/.unsubscribed) + .engagement_updated +
 *                    .lifecycle_stage_changed + .confirmed (subscribers pkg)
 *   - approval.*  — apps/api/internal/approvals/handlers.go emit()
 *                   (approval.requested / .decided)
 *
 * This is a SURFACE choice, not a claim about what the bus publishes — an
 * earlier version of this comment asserted the latter and was wrong.
 * `list.subscriber.added` IS bus-published (subscribers/bulk_operations.go
 * emits `outbound_webhooks.EventListSubscriberAdded` through `Deps.emit` →
 * `Bus.Publish` on the bulk add/move-to-list routes), as are `audit.created`,
 * `list_health.degraded` and `referral.*`. Desktop opts out of THOSE because it
 * has no TanStack query they would refresh — the `qk` roots desktop reads are
 * `campaigns`, `subscribers`, `dashboard` and now `notification-feed`.
 * Subscribing to a family that backs no query costs an SSE filter slot and
 * invalidates nothing.
 *
 * `sequence.*` genuinely is never bus-published — `sequence.generated` is an
 * outbound-webhook / chatops EventType that never reaches `Bus.Publish`.
 *
 * When a desktop page adopts TanStack for lists, the audit feed or the bell,
 * add that family here at the same time as the query — the mapping below is
 * already in place for each.
 */
export const CACHE_INVALIDATION_TOPICS = [
  "campaign.*",
  "subscriber.*",
  "approval.*",
  // Live now that the bell reads the SERVER feed (lib/notification-feed.ts).
  // While desktop kept a private vault this subscription would have refreshed
  // nothing, which is what the `notificationFeed` mapping below meant by
  // "inert until it adopts the feed".
  "notification.*",
] as const;

/**
 * A query key to invalidate. The shared `qk` factory keys lead with the
 * resource string, so a single-element `[resource]` prefix invalidates
 * every tenant/role/params variant of that resource.
 */
export type InvalidationKey = readonly [string];

/**
 * Adapter: canonical resource (from @postwave/query-contract's shared
 * event→resource authority) → the desktop `qk` resource-prefix string(s) whose
 * cached entries that resource backs. The strings are the EXACT resource names
 * the `qk` factory passes to `base()` (packages/query-contract/src/keys.ts):
 * campaigns / campaign / subscribers / subscriber / lists / audit / dashboard.
 *
 * `approvals` maps to the `approvals` prefix (the desktop approvals queue is
 * manual state today, so this is currently inert-but-correct); the dashboard's
 * pending-work count — a real cached query — is refreshed via the `dashboard`
 * resource the shared authority pairs with every approval event.
 *
 * MUST stay TOTAL over `CanonicalResource`; TypeScript enforces this at compile
 * time (a dropped resource is a type error), and the drift test asserts it.
 */
const DESKTOP_RESOURCE_PREFIXES: Record<CanonicalResource, readonly string[]> =
  {
    campaigns: ["campaigns"],
    campaign: ["campaign"],
    subscribers: ["subscribers"],
    subscriber: ["subscriber"],
    lists: ["lists"],
    suppressions: ["suppressions"],
    approvals: ["approvals"],
    audit: ["audit"],
    dashboard: ["dashboard"],
    // LIVE. The desktop bell reads the server feed (lib/notification-feed.ts);
    // this prefix is the query root that hook uses, so a `notification.created`
    // fanout refreshes it the same way it does on web and mobile. It sat inert
    // here for as long as desktop kept a private vault instead.
    notificationFeed: ["notification-feed"],
    // Deliberately empty — see DESKTOP_UNBACKED_RESOURCES.
    deliverability: [],
    referrals: [],
  };

/**
 * Canonical resources desktop deliberately does not cache, and therefore
 * cannot invalidate.
 *
 * The Deliverability Hub (pages/useDeliverabilityHubData.ts) and the Referrals
 * page are `useState`/`useEffect` surfaces — neither registers a TanStack
 * query, so there is no cache entry a `list_health.degraded` or `referral.*`
 * event could refresh. An empty prefix list is the truthful mapping; inventing
 * a plausible-looking prefix would produce an invalidation call that silently
 * matches nothing, which is worse than an explicit opt-out.
 *
 * This list exists so the omission is a DECLARATION rather than an absence:
 * the drift test asserts `reachable + unbacked === CANONICAL_RESOURCES`, so a
 * future resource nobody considered still fails loudly. When either page
 * adopts TanStack Query, give it a real prefix above and delete it from here.
 */
export const DESKTOP_UNBACKED_RESOURCES = [
  "deliverability",
  "referrals",
] as const satisfies readonly CanonicalResource[];

/**
 * Pure mapping: server event → the resource-prefix query keys to invalidate
 * (empty array when the event is not cache-relevant). WHICH resources an event
 * dirties is decided ONCE by the shared `canonicalResourcesForEvent` authority;
 * this only translates them into desktop's `[resource]` prefix shape. Kept pure
 * so it's trivially unit-testable with no React / TanStack dependency.
 *
 * De-duplicated and order-preserving so callers can pass the result straight
 * to queryClient.invalidateQueries per key.
 */
export function invalidationKeysForEvent(
  evt: EventBusMessage,
): InvalidationKey[] {
  const seen = new Set<string>();
  const out: InvalidationKey[] = [];
  for (const resource of canonicalResourcesForEvent(evt.topic)) {
    for (const p of DESKTOP_RESOURCE_PREFIXES[resource]) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push([p] as const);
    }
  }
  return out;
}

/**
 * Invalidate the caches affected by one event. Best-effort: a failing
 * invalidation never bubbles into the app or blocks the event-bus dispatch.
 */
function invalidateForEvent(
  queryClient: QueryClient,
  evt: EventBusMessage,
): void {
  for (const queryKey of invalidationKeysForEvent(evt)) {
    try {
      void queryClient.invalidateQueries({ queryKey });
    } catch {
      /* invalidation is best-effort */
    }
  }
}

/**
 * useCacheInvalidation — subscribe the shared event-bus to TanStack Query
 * cache invalidation for the lifetime of the host component. One
 * subscription per cache-invalidation topic family. useEventSubscription
 * keeps the latest handler live without re-subscribing on every render.
 *
 * The QueryClient is injected so this stays unit-testable and decoupled
 * from the query-client singleton module (App.tsx passes the live client).
 */
export function useCacheInvalidation(queryClient: QueryClient): void {
  useEventSubscription("campaign.*", (evt) => {
    invalidateForEvent(queryClient, evt as EventBusMessage);
  });
  useEventSubscription("subscriber.*", (evt) => {
    invalidateForEvent(queryClient, evt as EventBusMessage);
  });
  useEventSubscription("approval.*", (evt) => {
    invalidateForEvent(queryClient, evt as EventBusMessage);
  });
  useEventSubscription("notification.*", (evt) => {
    invalidateForEvent(queryClient, evt as EventBusMessage);
  });
}

/**
 * Invisible mount point for the app-level cache invalidator. Render once
 * inside <EventBusProvider> (App.tsx), ALONGSIDE <AppEventNotifier /> — not
 * replacing it. Returns null; its only job is to keep the event
 * subscriptions alive so the cache refreshes from live server events no
 * matter which page is currently mounted.
 */
export function AppCacheInvalidator(props: { queryClient: QueryClient }): null {
  useCacheInvalidation(props.queryClient);
  return null;
}
