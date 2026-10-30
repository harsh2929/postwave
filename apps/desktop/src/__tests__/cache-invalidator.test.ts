// Tests for the app-level server-event → TanStack-Query cache invalidation
// router (initiative #2: event-bus cache invalidation).
//
// Companion to app-notifier.test.ts. Where the notifier maps a server event
// to an OS notification, this maps a server event to the set of
// `@postwave/query-contract` resource-prefix query keys to invalidate. The
// mapping is pinned here so a topic-name regression (or a stale resource
// prefix) is caught loudly: the qk factory keys ALWAYS lead with the
// resource string ([resource, tenantId, role, ...]), so prefix invalidation
// covers every tenant/role/params variant without resolving identity at the
// event site.

import { describe, expect, it } from "vitest";

import {
  CANONICAL_RESOURCES,
  canonicalResourcesForEvent,
} from "@postwave/query-contract";

import {
  CACHE_INVALIDATION_TOPICS,
  DESKTOP_UNBACKED_RESOURCES,
  invalidationKeysForEvent,
} from "../lib/cache-invalidator";
import type { EventBusMessage } from "../lib/event-bus";
import {
  DEFAULT_EVENT_BUS_TOPICS,
  normalizeEventBusTopics,
} from "../lib/event-bus-topics";

function msg(
  topic: string,
  payload?: Record<string, unknown>,
): EventBusMessage {
  return { topic, tenant_id: "t1", at: "2026-06-21T00:00:00Z", payload };
}

describe("cache-invalidator invalidationKeysForEvent", () => {
  it("invalidates campaign list + detail on campaign.* events", () => {
    for (const t of ["campaign.created", "campaign.updated", "campaign.sent"]) {
      const keys = invalidationKeysForEvent(msg(t));
      expect(keys).toEqual(
        expect.arrayContaining([["campaigns"], ["campaign"]]),
      );
    }
  });

  it("invalidates subscriber list + detail on subscriber.* events", () => {
    for (const t of [
      "subscriber.added",
      "subscriber.removed",
      "subscriber.bounced",
    ]) {
      const keys = invalidationKeysForEvent(msg(t));
      expect(keys).toEqual(
        expect.arrayContaining([["subscribers"], ["subscriber"]]),
      );
    }
  });

  it("subscriber engagement updates refresh subscriber caches", () => {
    const keys = invalidationKeysForEvent(msg("subscriber.engagement_updated"));
    expect(keys).toEqual(
      expect.arrayContaining([["subscribers"], ["subscriber"]]),
    );
  });

  it("refreshes the dashboard on campaign + subscriber events (pending-count freshness)", () => {
    // Now sourced from the shared authority: campaign/subscriber events also
    // dirty the dashboard tiles. (The old desktop map omitted this.)
    expect(invalidationKeysForEvent(msg("campaign.sent"))).toEqual(
      expect.arrayContaining([["dashboard"]]),
    );
    expect(invalidationKeysForEvent(msg("subscriber.added"))).toEqual(
      expect.arrayContaining([["dashboard"]]),
    );
  });

  it("adds suppressions only on deliverability-terminal subscriber events", () => {
    expect(invalidationKeysForEvent(msg("subscriber.bounced"))).toEqual(
      expect.arrayContaining([["suppressions"]]),
    );
    expect(invalidationKeysForEvent(msg("subscriber.updated"))).not.toEqual(
      expect.arrayContaining([["suppressions"]]),
    );
  });

  it("emits no keys for sequence.* / unknown families the bus never publishes", () => {
    // sequence.generated is only an outbound-webhook EventType, never passed to
    // events.Bus.Publish; there is no `sequence` domain in the shared authority.
    for (const t of ["sequence.generated", "widget.exploded"]) {
      expect(invalidationKeysForEvent(msg(t))).toEqual([]);
    }
  });

  it("refreshes approvals + dashboard on approval.* events (not the audit feed)", () => {
    // Sourced from the shared authority. The old desktop map pointed approval.*
    // at `audit` — a workaround for there being no approvals query — which also
    // never refreshed the dashboard's pending-approvals count. The canonical
    // mapping is `approvals` (the queue) + `dashboard` (the count); the desktop
    // approvals queue is manual state today, so `dashboard` is the load-bearing
    // refresh and the mapping now agrees with web + mobile.
    for (const t of ["approval.requested", "approval.decided"]) {
      const keys = invalidationKeysForEvent(msg(t));
      expect(keys).toEqual(
        expect.arrayContaining([["approvals"], ["dashboard"]]),
      );
      expect(keys).not.toEqual(expect.arrayContaining([["audit"]]));
    }
  });

  it("returns no keys for chatty / non-actionable collaboration topics", () => {
    expect(invalidationKeysForEvent(msg("cursor.move"))).toEqual([]);
    expect(invalidationKeysForEvent(msg("presence.update"))).toEqual([]);
    expect(invalidationKeysForEvent(msg("selection.move"))).toEqual([]);
  });

  it("returns no keys for an unknown topic family", () => {
    expect(invalidationKeysForEvent(msg("widget.exploded"))).toEqual([]);
  });

  it("each emitted key is a single-element resource-prefix array (qk leads with resource)", () => {
    const keys = invalidationKeysForEvent(msg("campaign.sent"));
    for (const k of keys) {
      expect(Array.isArray(k)).toBe(true);
      expect(k).toHaveLength(1);
      expect(typeof k[0]).toBe("string");
    }
  });

  it("maps every canonical resource the shared authority can emit (no silent drop)", () => {
    // Totality guard on the PURE map (not desktop's subscription set): the
    // adapter is typed Record<CanonicalResource,…> so a dropped resource is a
    // compile error; this pins it at runtime too. Some probe topics here
    // (list.*, audit.*, notification.*) are ones desktop does not subscribe to
    // — they exercise the adapter's totality, not desktop's live coverage (see
    // the subscription test below for what desktop actually receives). We probe
    // one event per domain and assert the union covers every desktop prefix (a
    // canonical resource's prefix name may differ from the resource key, e.g.
    // `notificationFeed` → `notification-feed`).
    const reached = new Set<string>();
    for (const topic of [
      "campaign.sent",
      "subscriber.bounced",
      "list.subscriber.added",
      "approval.requested",
      "audit.created",
      "notification.created",
    ]) {
      for (const [prefix] of invalidationKeysForEvent(msg(topic))) {
        reached.add(prefix);
      }
    }
    // Every distinct desktop resource-prefix must be reachable, and the count
    // must match the canonical vocabulary size (each canonical resource maps to
    // exactly one desktop prefix), so a new/dropped resource is caught here too.
    for (const prefix of [
      "campaigns",
      "campaign",
      "subscribers",
      "subscriber",
      "lists",
      "suppressions",
      "approvals",
      "audit",
      "dashboard",
      "notification-feed",
    ]) {
      expect(reached.has(prefix), prefix).toBe(true);
    }
    // Total-coverage invariant. Every canonical resource is either backed by a
    // desktop prefix or explicitly listed as unbacked with a reason — so a
    // newly added resource that nobody thought about still fails here rather
    // than silently mapping to nothing.
    expect(reached.size + DESKTOP_UNBACKED_RESOURCES.length).toBe(
      CANONICAL_RESOURCES.length,
    );
  });

  it("declares the canonical resources desktop deliberately does not cache", () => {
    // Desktop's Deliverability Hub (pages/useDeliverabilityHubData.ts) and
    // Referrals page are useState/useEffect surfaces, NOT TanStack queries —
    // grep confirms zero `queryKey` occurrences for either domain. There is no
    // cache entry to invalidate, so the honest mapping is an empty prefix list
    // rather than a plausible-looking guess. If either page adopts TanStack,
    // give it a prefix here and drop it from this list.
    expect([...DESKTOP_UNBACKED_RESOURCES].sort()).toEqual([
      "deliverability",
      "referrals",
    ]);
    for (const resource of DESKTOP_UNBACKED_RESOURCES) {
      expect(CANONICAL_RESOURCES).toContain(resource);
    }
  });

  it("recognises the unbacked domains upstream while emitting no desktop keys", () => {
    // Discriminating on BOTH sides. The shared authority must resolve these
    // live topics to a canonical resource (otherwise the mapping was never
    // added and the empty result below is meaningless), AND desktop must still
    // emit no key for them (otherwise the opt-out silently grew a mapping).
    for (const topic of [
      "list_health.degraded",
      "referral.milestone.unlocked",
      "referral.payout.pending",
    ]) {
      expect(canonicalResourcesForEvent(topic).length, topic).toBeGreaterThan(
        0,
      );
      for (const resource of canonicalResourcesForEvent(topic)) {
        expect(DESKTOP_UNBACKED_RESOURCES, topic).toContain(resource);
      }
      expect(invalidationKeysForEvent(msg(topic)), topic).toEqual([]);
    }
  });

  it("subscribes to the topic families desktop acts on", () => {
    // A desktop SURFACE choice (not a claim about what the bus publishes).
    // campaign.* / subscriber.* / approval.* back live desktop queries, and
    // notification.* went live when the bell adopted the server feed
    // (lib/notification-feed.ts) — until then that subscription would have
    // refreshed a query desktop did not have. list.* and audit.* ARE published
    // but still back no desktop TanStack query, so desktop opts out of both;
    // sequence.* is never bus-published at all.
    expect(CACHE_INVALIDATION_TOPICS).toEqual([
      "campaign.*",
      "subscriber.*",
      "approval.*",
      "notification.*",
    ]);
  });
});

describe("subscribed topics are actually negotiated", () => {
  it("every CACHE_INVALIDATION_TOPICS family reaches the server", () => {
    // Declaring a subscription here is not enough. The `?topics=` CSV is built
    // from DEFAULT_EVENT_BUS_TOPICS, so a family listed only in this module is
    // never sent by the server and the handler never fires — which is exactly
    // how `notification.*` was added, claimed as "live", and did nothing.
    const negotiated = new Set(
      normalizeEventBusTopics([...DEFAULT_EVENT_BUS_TOPICS]).split(","),
    );
    for (const topic of CACHE_INVALIDATION_TOPICS) {
      expect(
        negotiated.has(topic),
        `${topic} is subscribed in cache-invalidator but not negotiated in event-bus-topics`,
      ).toBe(true);
    }
  });
});
