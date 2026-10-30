import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANONICAL_RESOURCES, EVENT_DOMAINS } from "@postwave/query-contract";

import {
  createDebouncedInvalidator,
  EVENT_INVALIDATION_TOPICS,
  invalidateForEvent,
  queryRootsForEvent,
  refetchesAsSingleRequest,
  type CachedQueryLike,
} from "./event-cache-invalidation";
import { normalizeEventBusTopics } from "./event-bus-topics";
import type { MobileEventBusEvent } from "./eventBus";

type InvalidateCall = {
  queryKey: readonly unknown[];
  refetchType?: string | undefined;
};
type RefetchCall = {
  queryKey: readonly unknown[];
  type?: string | undefined;
  predicate?: ((query: CachedQueryLike) => boolean) | undefined;
};

/**
 * Both halves are recorded separately: the staleness MARK and the REFETCH are
 * now two different calls, and only the second one costs a request.
 */
function fakeClient() {
  const calls: InvalidateCall[] = [];
  const refetchCalls: RefetchCall[] = [];
  return {
    calls,
    refetchCalls,
    invalidateQueries: vi.fn((filter: InvalidateCall) => {
      calls.push(filter);
      return Promise.resolve();
    }),
    refetchQueries: vi.fn((filter: RefetchCall) => {
      refetchCalls.push(filter);
      return Promise.resolve();
    }),
  };
}

/** An infinite query with `n` pages already in the cache. */
function pagedQuery(n: number): CachedQueryLike {
  return {
    state: {
      data: {
        pages: Array.from({ length: n }, (_, i) => ({ rows: [], cursor: i })),
        pageParams: Array.from({ length: n }, (_, i) => i),
      },
    },
  };
}

describe("queryRootsForEvent", () => {
  it("maps campaign.* events to campaign + dashboard query roots", () => {
    const roots = queryRootsForEvent("campaign.sent");
    expect(roots).toContain("campaigns");
    expect(roots).toContain("campaign");
    expect(roots).toContain("campaign-report");
    expect(roots).toContain("dashboard");
    expect(roots).toContain("dashboard-stats");
  });

  it("maps subscriber.* events to subscriber + dashboard query roots", () => {
    const roots = queryRootsForEvent("subscriber.added");
    expect(roots).toContain("subs");
    expect(roots).toContain("sub");
    expect(roots).toContain("sub-timeline");
    expect(roots).toContain("dashboard");
  });

  it("maps subscriber.bounced / complained to suppression roots", () => {
    expect(queryRootsForEvent("subscriber.bounced")).toContain("suppressions");
    expect(queryRootsForEvent("subscriber.complained")).toContain(
      "suppressions",
    );
  });

  it("maps approval.* events to the approvals queue AND the dashboard badge", () => {
    // Sourced from the shared authority: approval events now also refresh the
    // dashboard pending-count roots (the old mobile map hit only "approvals",
    // disagreeing with web). Agrees with web + desktop now.
    for (const t of ["approval.requested", "approval.decided"]) {
      const roots = queryRootsForEvent(t);
      expect(roots).toContain("approvals");
      expect(roots).toContain("dashboard");
      expect(roots).toContain("dashboard-stats");
    }
  });

  it("maps audit.* events to the audit feed", () => {
    expect(queryRootsForEvent("audit.created")).toEqual(["audit"]);
  });

  it("resolves a bare prefix the same as any concrete sub-event", () => {
    // The bus may deliver either the wildcard root ("campaign") or a
    // concrete event ("campaign.created"); both resolve to the same roots.
    expect(queryRootsForEvent("campaign")).toEqual(
      queryRootsForEvent("campaign.anything-new"),
    );
  });

  it("returns an empty list for unknown / collaboration / malformed topics", () => {
    // list.* is deliberately NOT in this empty set: it maps (and mobile now
    // subscribes to it — see EVENT_INVALIDATION_TOPICS — for the Lists tab).
    expect(queryRootsForEvent("presence.update")).toEqual([]);
    expect(queryRootsForEvent("sequence.generated")).toEqual([]);
    expect(queryRootsForEvent("cursor.move")).toEqual([]);
    expect(queryRootsForEvent("")).toEqual([]);
    expect(queryRootsForEvent("garbage")).toEqual([]);
  });

  it("covers every canonical resource the shared authority can emit (no silent drop)", () => {
    // Totality guard. MOBILE_RESOURCE_ROOTS is typed Record<CanonicalResource,…>
    // so a dropped resource is a compile error; this pins the end-to-end
    // pipeline at runtime. Exercise one event per subscribed domain and assert
    // each resolves to a non-empty, mobile-rooted set.
    for (const topic of [
      "campaign.sent",
      "subscriber.bounced",
      "list.subscriber.added",
      "approval.requested",
      "audit.created",
    ]) {
      expect(queryRootsForEvent(topic).length, topic).toBeGreaterThan(0);
    }
    // The `lists` canonical resource (unique to list.*) must reach a mobile root.
    expect(queryRootsForEvent("list.subscriber.added")).toContain("lists");
    // Pin the guard against the shared vocabulary so a new canonical resource
    // forces a conscious mobile-adapter update.
    expect(CANONICAL_RESOURCES.length).toBe(12);
  });

  it("refreshes the deliverability hub on a list_health.degraded event", () => {
    // The 2am screen. apps/api/internal/deliverability_hub/hub.go emitDegraded
    // publishes this the moment the account score crosses a breach threshold;
    // useDeliverabilityHub has a 60s staleTime, so without this the phone kept
    // showing a healthy score through an active degradation.
    const roots = queryRootsForEvent("list_health.degraded");
    expect(roots).toContain("deliverability-hub");
    expect(roots).toContain("blocklist-hits");
  });

  it("refreshes referral views on referral.* events", () => {
    for (const topic of [
      "referral.milestone.unlocked",
      "referral.payout.pending",
    ]) {
      expect(queryRootsForEvent(topic), topic).toContain("referrals");
    }
  });

  it("never returns duplicate roots", () => {
    for (const topic of [
      "campaign.sent",
      "subscriber.added",
      "approval.requested",
      "audit.created",
    ]) {
      const roots = queryRootsForEvent(topic);
      expect(new Set(roots).size).toBe(roots.length);
    }
  });
});

describe("EVENT_INVALIDATION_TOPICS", () => {
  it("subscribes to the surface's live domains as wildcards", () => {
    // Includes list.* — mobile has a Lists tab whose per-list counts change on
    // list.subscriber.added (a real bus event). Excludes sequence.* (never
    // published to the bus).
    expect(EVENT_INVALIDATION_TOPICS).toEqual([
      "campaign.*",
      "subscriber.*",
      "list.*",
      "approval.*",
      "audit.*",
      "notification.*",
      "list_health.*",
      "referral.*",
    ]);
  });

  it("survives wire normalization — every declared topic is actually sent", () => {
    // The gap that made `list_health.*` inert on first implementation: this
    // array is not the subscription. `normalizeEventBusTopics` builds the
    // `?topics=` CSV and SILENTLY DROPS any entry failing the topic grammar,
    // so a declared-but-ungrammatical topic looks subscribed and never
    // arrives. Assert the round-trip is lossless and order-preserving.
    const wire = normalizeEventBusTopics([...EVENT_INVALIDATION_TOPICS]);
    expect(wire.split(",")).toEqual([...EVENT_INVALIDATION_TOPICS]);
  });

  it("subscribes to every domain whose resources it actually backs", () => {
    // The gap this closes: mapping a resource and subscribing to the topic
    // that dirties it are two independent edits, and only the first is
    // compile-checked. A mobile adapter row for `deliverability` with no
    // `list_health.*` subscription is a mapping that can never run. Assert the
    // two agree: every domain that resolves to a non-empty mobile root set
    // must appear in the subscription list.
    for (const domain of EVENT_DOMAINS) {
      if (queryRootsForEvent(`${domain}.probe`).length === 0) continue;
      expect(
        EVENT_INVALIDATION_TOPICS.includes(`${domain}.*`),
        `${domain} maps to mobile roots but is not subscribed`,
      ).toBe(true);
    }
  });

  it("refreshes the notification inbox on a notification.created event", () => {
    // Makes the mobile bell (app/(tabs)/notifications.tsx) realtime.
    expect(queryRootsForEvent("notification.created")).toContain(
      "notification-feed",
    );
  });

  it("refreshes the Lists tab + subscribers on a subscribed list.* event", () => {
    // list.subscriber.added is published and subscribed; it must refresh the
    // lists view (member counts) and the subscribers list.
    const roots = queryRootsForEvent("list.subscriber.added");
    expect(roots).toContain("lists");
    expect(roots).toContain("subs");
  });
});

describe("invalidateForEvent", () => {
  it("invalidates one query-key root per mapped root", () => {
    const client = fakeClient();
    const evt: MobileEventBusEvent = {
      topic: "campaign.sent",
      tenant_id: "t1",
      at: "now",
    };
    invalidateForEvent(client, evt);
    const invalidatedRoots = client.calls.map((c) => c.queryKey[0]);
    expect(invalidatedRoots).toEqual(queryRootsForEvent("campaign.sent"));
    // Root-only filter so all tenant/param/page variants are caught.
    for (const c of client.calls) {
      expect(c.queryKey).toHaveLength(1);
    }
  });

  it("is a no-op for an unmapped topic", () => {
    const client = fakeClient();
    invalidateForEvent(client, {
      topic: "presence.update",
      tenant_id: "t1",
      at: "now",
    });
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("ignores malformed events without a string topic", () => {
    const client = fakeClient();
    invalidateForEvent(client, {
      tenant_id: "t1",
      at: "now",
    } as unknown as MobileEventBusEvent);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    expect(client.refetchQueries).not.toHaveBeenCalled();
  });
});

/**
 * NATIVE — one bus event must not become N requests.
 *
 * TanStack refetches EVERY loaded page of an infinite query, so a plain
 * `invalidateQueries` on a root backing one of the app's paged lists turned a
 * single teammate edit into one request per page the reader had pulled in.
 * That is the exact storm hooks/useAuditTail was written to avoid, re-created
 * from the other side of the cache.
 */
describe("infinite-list fan-out", () => {
  const evt = (topic: string): MobileEventBusEvent => ({
    topic,
    tenant_id: "t1",
    at: "now",
  });

  it("counts a deeply-paged query as more than one request", () => {
    expect(refetchesAsSingleRequest(pagedQuery(6))).toBe(false);
    expect(refetchesAsSingleRequest(pagedQuery(2))).toBe(false);
  });

  it("counts a one-page or unpaged query as a single request", () => {
    expect(refetchesAsSingleRequest(pagedQuery(1))).toBe(true);
    expect(refetchesAsSingleRequest(pagedQuery(0))).toBe(true);
    // A plain (non-infinite) query: its data is whatever the endpoint returns.
    expect(refetchesAsSingleRequest({ state: { data: { rows: [] } } })).toBe(
      true,
    );
    // Nothing fetched yet — refetching it is one request, not none.
    expect(refetchesAsSingleRequest({ state: { data: undefined } })).toBe(true);
    expect(refetchesAsSingleRequest({})).toBe(true);
  });

  it("marks a root stale without letting the invalidation refetch it", () => {
    const client = fakeClient();
    invalidateForEvent(client, evt("subscriber.added"));
    // Every mapped root is still marked stale, so nothing serves a known-old
    // answer past this point — but the mark itself issues zero requests.
    for (const call of client.calls) expect(call.refetchType).toBe("none");
  });

  it("refetches only the queries that cost a single request", () => {
    const client = fakeClient();
    invalidateForEvent(client, evt("subscriber.added"));

    const subs = client.refetchCalls.find((c) => c.queryKey[0] === "subs");
    expect(subs, "the subscribers root must still be refreshed live").toBeDefined();
    expect(subs?.type).toBe("active");
    // Six pages deep into an investigation, one bus event previously issued
    // six requests. Now it issues none, and the list refetches when the reader
    // next brings it to the front — the staleness mark above guarantees that.
    expect(subs?.predicate?.(pagedQuery(6))).toBe(false);
    expect(subs?.predicate?.(pagedQuery(1))).toBe(true);
  });

  it("applies the same ceiling on the debounced path", () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const d = createDebouncedInvalidator(client, { delayMs: 600 });
      d.push(evt("subscriber.added"));
      vi.advanceTimersByTime(600);
      for (const call of client.calls) expect(call.refetchType).toBe("none");
      const subs = client.refetchCalls.find((c) => c.queryKey[0] === "subs");
      expect(subs?.predicate?.(pagedQuery(6))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createDebouncedInvalidator", () => {
  const evt = (topic: string): MobileEventBusEvent => ({
    topic,
    tenant_id: "t1",
    at: "now",
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of engagement events into one invalidation per root", () => {
    // Regression for the MED finding: a live send fires a storm of
    // subscriber.engagement_updated events. Without debounce each one calls
    // invalidateQueries immediately → a refetch storm. With trailing debounce
    // the whole burst flushes once per affected root.
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });

    const roots = queryRootsForEvent("subscriber.engagement_updated");
    expect(roots.length).toBeGreaterThan(0);

    // 25 opens/clicks land in quick succession (no real timers elapse).
    for (let i = 0; i < 25; i++) d.push(evt("subscriber.engagement_updated"));

    // Nothing fires until the trailing window elapses.
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);

    // Exactly one invalidation per affected root — not 25 per root.
    expect(client.invalidateQueries).toHaveBeenCalledTimes(roots.length);
    const invalidatedRoots = client.calls.map((c) => c.queryKey[0]);
    expect(new Set(invalidatedRoots)).toEqual(new Set(roots));
    for (const c of client.calls) expect(c.queryKey).toHaveLength(1);
  });

  it("resets the trailing window on each event in a sustained burst", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });

    d.push(evt("subscriber.added"));
    vi.advanceTimersByTime(500); // not yet elapsed
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    d.push(evt("subscriber.added")); // resets the window
    vi.advanceTimersByTime(500); // 1000ms total but only 500 since last event
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // now 600ms since the last event
    expect(client.invalidateQueries).toHaveBeenCalled();
  });

  it("debounces each root independently (a quiet domain still flushes)", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });

    // approval.* maps to the approvals root that subscriber.* does not touch.
    d.push(evt("approval.requested"));
    // A noisy subscriber burst on other roots shouldn't delay approvals.
    vi.advanceTimersByTime(600);
    const invalidated = client.calls.map((c) => c.queryKey[0]);
    expect(invalidated).toContain("approvals");
  });

  it("flush() invalidates pending roots immediately", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });
    d.push(evt("subscriber.added"));
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    d.flush();
    expect(client.invalidateQueries).toHaveBeenCalled();
    // No double-fire when the (cleared) timer would have elapsed.
    const after = client.invalidateQueries.mock.calls.length;
    vi.advanceTimersByTime(600);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(after);
  });

  it("cancel() drops pending invalidations without firing them", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });
    d.push(evt("subscriber.added"));
    d.cancel();
    vi.advanceTimersByTime(600);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("push() is a no-op for unmapped / malformed topics", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, { delayMs: 600 });
    expect(d.push(evt("presence.update"))).toBe(0);
    expect(
      d.push({ tenant_id: "t1", at: "now" } as unknown as MobileEventBusEvent),
    ).toBe(0);
    vi.advanceTimersByTime(600);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  // NATIVE#63 — a trailing-only debounce starves during a SUSTAINED stream:
  // while a live send keeps firing engagement events, the window is reset on
  // every event and the dashboard the user is watching never refetches.
  it("forces a flush once the coalescing ceiling is reached", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, {
      delayMs: 600,
      maxWaitMs: 5_000,
    });

    // One event every 100ms for 6 seconds: the trailing window never elapses.
    for (let elapsed = 0; elapsed < 6_000; elapsed += 100) {
      d.push(evt("subscriber.engagement_updated"));
      vi.advanceTimersByTime(100);
    }

    const roots = client.calls.map((c) => c.queryKey[0]);
    expect(roots).toContain("subs");
    // Bounded: the ceiling flushes, it does not turn the debounce off.
    expect(client.invalidateQueries.mock.calls.length).toBeLessThan(10);
  });

  it("restarts the ceiling window after a forced flush", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, {
      delayMs: 600,
      maxWaitMs: 1_000,
    });
    d.push(evt("subscriber.added"));
    vi.advanceTimersByTime(1_000);
    d.push(evt("subscriber.added")); // ceiling reached -> immediate flush
    const afterForced = client.invalidateQueries.mock.calls.length;
    expect(afterForced).toBeGreaterThan(0);

    // The next event opens a fresh window rather than flushing every time.
    d.push(evt("subscriber.added"));
    expect(client.invalidateQueries.mock.calls.length).toBe(afterForced);
    vi.advanceTimersByTime(600);
    expect(client.invalidateQueries.mock.calls.length).toBeGreaterThan(
      afterForced,
    );
  });

  it("maxWaitMs = 0 disables the ceiling (pure trailing debounce)", () => {
    const client = fakeClient();
    const d = createDebouncedInvalidator(client, {
      delayMs: 600,
      maxWaitMs: 0,
    });
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      d.push(evt("subscriber.engagement_updated"));
      vi.advanceTimersByTime(100);
    }
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });
});
