// SPDX-License-Identifier: AGPL-3.0-only
//
// Event-bus → TanStack Query cache-invalidation map.
//
// The server's realtime event bus (GET /api/v1/events, see
// apps/api/internal/events) fans domain events out over SSE. This module is
// the PURE mapping from a wire event (topic + payload) to the set of
// @postwave/query-contract `qk` keys that should be invalidated so the
// dashboard's TanStack Query cache stays fresh without a manual refetch.
//
// It is deliberately framework-free (no React, no QueryClient) so it can be
// unit-tested in the node vitest environment. The thin runtime wrapper that
// opens the EventSource and calls queryClient.invalidateQueries lives in
// event-bus-client.ts + realtime-invalidator.tsx.

import {
  base,
  qk,
  canonicalResourcesForEvent,
  type CanonicalResource,
  type RoleKey,
} from "@postwave/query-contract";

/**
 * The wire payload shape emitted by the Go SSE handler
 * (apps/api/internal/events/handler.go::eventWirePayload). Topic uses
 * dot.notation (e.g. "campaign.sent"). The handler hoists a handful of
 * well-known ids to the top level (campaign_id, subscriber_id,
 * subscriber_email) in addition to nesting them under `payload`.
 */
export interface RealtimeEvent {
  topic: string;
  tenant_id?: string;
  at?: string;
  campaign_id?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  payload?: Record<string, unknown>;
}

/** Identity the keys are scoped to — supplied by the auth boot (whoami). */
export interface InvalidationIdentity {
  tenantId: string;
  role: RoleKey;
}

/**
 * Concrete topics the web dashboard subscribes to. This list is intentionally
 * derived from real Bus.Publish call sites; do not replace it with broad
 * subscriber.* or campaign.* globs, which would include engagement firehoses.
 */
export const WEB_INVALIDATION_TOPICS: readonly string[] = [
  "campaign.created",
  "campaign.updated",
  "campaign.sent",
  "subscriber.created",
  "subscriber.added",
  "subscriber.updated",
  "subscriber.confirmed",
  "subscriber.unsubscribed",
  "subscriber.bounced",
  "subscriber.complained",
  "subscriber.deleted",
  "subscriber.lifecycle_stage_changed",
  "list.subscriber.added",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.decided",
  // Server-authored notification fanout (notifyfanout.Dispatch) — makes the
  // in-app bell realtime instead of a 60s poll.
  "notification.created",
] as const;

const INVALIDATABLE_TOPICS = new Set<string>(WEB_INVALIDATION_TOPICS);

/**
 * Pull the entity id out of an event, preferring the hoisted top-level field
 * the server already extracted, then falling back to common payload keys.
 */
function idFrom(evt: RealtimeEvent, ...keys: string[]): string | undefined {
  const flat = evt as unknown as Record<string, unknown>;
  for (const k of keys) {
    const top = flat[k];
    if (typeof top === "string" && top) return top;
    if (typeof top === "number") return String(top);
  }
  const payload = evt.payload ?? {};
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Adapter: canonical resource (from @postwave/query-contract's shared
 * event→resource authority) → the concrete web `qk`/`base` keys to invalidate.
 *
 * LIST keys use the 3-element `base(resource, tenant, role)` prefix (NOT the
 * 4-element `qk.campaigns(...)` which appends a trailing `null` params slot) —
 * only the 3-element prefix matches every params variant the list pages cache
 * (e.g. `[campaigns, t, r, {page:1}]`). DETAIL keys keep `qk.*` since those
 * carry the id and prefix-match their own entry, and are emitted only when the
 * event actually carries that id. `approvals` maps to `settings("approvals")`
 * because that is where the web app routes the approvals queue.
 *
 * This table MUST stay TOTAL over `CanonicalResource` — the drift test
 * (event-query-map.test.ts) asserts it, so the web surface can never silently
 * drop a resource the shared authority emits.
 */
const WEB_RESOURCE_KEYS: Record<
  CanonicalResource,
  (
    evt: RealtimeEvent,
    tenantId: string,
    role: RoleKey,
  ) => readonly (readonly unknown[])[]
> = {
  campaigns: (_e, t, r) => [base("campaigns", t, r)],
  campaign: (e, t, r) => {
    const id = idFrom(e, "campaign_id", "id");
    return id ? [qk.campaign(t, r, id)] : [];
  },
  subscribers: (_e, t, r) => [base("subscribers", t, r)],
  subscriber: (e, t, r) => {
    const id = idFrom(e, "subscriber_id", "id");
    return id ? [qk.subscriber(t, r, id)] : [];
  },
  lists: (_e, t, r) => [base("lists", t, r)],
  suppressions: (_e, t, r) => [base("suppressions", t, r)],
  approvals: (_e, t, r) => [qk.settings(t, r, "approvals")],
  audit: (_e, t, r) => [base("audit", t, r)],
  dashboard: (_e, t, r) => [base("dashboard", t, r)],
  notificationFeed: (_e, t, r) => [qk.notificationFeed(t, r)],
  // Deliberately key-less — see WEB_UNBACKED_RESOURCES.
  deliverability: () => [],
  referrals: () => [],
};

/**
 * Canonical resources the web dashboard does not render, and therefore cannot
 * invalidate.
 *
 * The shared authority routes `list_health.degraded` → `deliverability` and
 * `referral.*` → `referrals` because the mobile client backs both with real
 * TanStack queries. The web dashboard ships neither screen, so there is no key
 * to return; an invented `base("deliverability", …)` would be a call that
 * matches nothing while reading like coverage.
 *
 * Declared (rather than silently empty) so the total-coverage test can assert
 * `backed + unbacked === CANONICAL_RESOURCES`. Web also never lists these
 * topics in `WEB_INVALIDATION_TOPICS`, so `queryKeysForEvent` short-circuits
 * before reaching this table at all — the entries exist to satisfy the
 * compile-time totality contract and to document why they are empty.
 */
export const WEB_UNBACKED_RESOURCES = [
  "deliverability",
  "referrals",
] as const satisfies readonly CanonicalResource[];

/**
 * Map one realtime event to the query keys that should be invalidated.
 *
 * Which resources an event dirties is decided ONCE by the shared
 * `canonicalResourcesForEvent` authority; this function only translates those
 * canonical resources into web's concrete key shape via `WEB_RESOURCE_KEYS`.
 * Callers pass each key to `queryClient.invalidateQueries({ queryKey, exact:
 * false })` so both the parametrised list entry and any detail entry refresh.
 * An unknown / out-of-scope topic returns an empty array (no-op) so a new
 * server event never crashes a client that predates it.
 */
export function queryKeysForEvent(
  evt: RealtimeEvent,
  identity: InvalidationIdentity,
): readonly unknown[][] {
  const { tenantId, role } = identity;
  const topic = typeof evt.topic === "string" ? evt.topic : "";
  if (!topic || !INVALIDATABLE_TOPICS.has(topic)) return [];

  const keys: unknown[][] = [];
  for (const resource of canonicalResourcesForEvent(topic)) {
    for (const key of WEB_RESOURCE_KEYS[resource](evt, tenantId, role)) {
      keys.push(key as unknown[]);
    }
  }
  return keys;
}

/** Whether a topic is one the web invalidation layer acts on. */
export function isInvalidatableTopic(topic: string): boolean {
  return INVALIDATABLE_TOPICS.has(topic);
}
