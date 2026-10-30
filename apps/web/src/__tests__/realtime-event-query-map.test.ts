// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  base,
  CANONICAL_RESOURCES,
  canonicalResourcesForEvent,
  isValidEventTopicFilter,
  qk,
} from "@postwave/query-contract";
import {
  isInvalidatableTopic,
  queryKeysForEvent,
  WEB_INVALIDATION_TOPICS,
  WEB_UNBACKED_RESOURCES,
  type RealtimeEvent,
} from "@/lib/realtime/event-query-map";
import { buildTopicsCsv } from "@/lib/realtime/event-bus-client";

const IDENTITY = { tenantId: "tnt_1", role: "admin" as const };

/** Deep-equal membership check for query-key arrays. */
function hasKey(keys: readonly unknown[][], want: readonly unknown[]): boolean {
  const target = JSON.stringify(want);
  return keys.some((k) => JSON.stringify(k) === target);
}

/** Whether `prefix` is a TanStack `exact:false` prefix of `key`. */
function isPrefixOf(
  prefix: readonly unknown[],
  key: readonly unknown[],
): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every(
    (seg, i) => JSON.stringify(seg) === JSON.stringify(key[i]),
  );
}

describe("queryKeysForEvent", () => {
  it("maps campaign.sent to the campaigns list, dashboard, and that campaign detail", () => {
    const evt: RealtimeEvent = {
      topic: "campaign.sent",
      campaign_id: "cmp_42",
    };
    const keys = queryKeysForEvent(evt, IDENTITY);
    expect(
      hasKey(keys, base("campaigns", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(
      hasKey(keys, base("dashboard", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(
      hasKey(keys, qk.campaign(IDENTITY.tenantId, IDENTITY.role, "cmp_42")),
    ).toBe(true);
  });

  it("emits a 3-element list prefix that prefix-matches every params variant", () => {
    // Regression for finding 2: a 4-element qk.campaigns() key (trailing null)
    // does NOT prefix-match the parametrised list entries the pages actually
    // cache (e.g. [campaigns, t, r, {page:1}]). The base() prefix must.
    const keys = queryKeysForEvent({ topic: "campaign.created" }, IDENTITY);
    const listKey = keys.find((k) => k[0] === "campaigns");
    expect(listKey).toBeDefined();
    // Exactly [resource, tenant, role] — no trailing null params slot.
    expect(listKey).toHaveLength(3);
    // The old buggy key shape (qk.campaigns -> trailing null) must NOT appear.
    expect(hasKey(keys, qk.campaigns(IDENTITY.tenantId, IDENTITY.role))).toBe(
      false,
    );
    // And it must be a real prefix of a parametrised list entry.
    const paramKey = qk.campaigns(IDENTITY.tenantId, IDENTITY.role, {
      page: 1,
      per_page: 25,
    });
    expect(isPrefixOf(listKey!, paramKey)).toBe(true);
  });

  it("reads the campaign id from the nested payload when not hoisted", () => {
    const evt: RealtimeEvent = {
      topic: "campaign.updated",
      payload: { id: 7 },
    };
    const keys = queryKeysForEvent(evt, IDENTITY);
    expect(
      hasKey(keys, qk.campaign(IDENTITY.tenantId, IDENTITY.role, "7")),
    ).toBe(true);
  });

  it("omits the detail key when no campaign id is present", () => {
    const keys = queryKeysForEvent({ topic: "campaign.created" }, IDENTITY);
    expect(
      hasKey(keys, base("campaigns", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    // No id -> no detail key, only list + dashboard.
    expect(keys.length).toBe(2);
  });

  it("maps subscriber.bounced to subscribers list + that subscriber detail", () => {
    const evt: RealtimeEvent = {
      topic: "subscriber.bounced",
      subscriber_id: "sub_9",
    };
    const keys = queryKeysForEvent(evt, IDENTITY);
    expect(
      hasKey(keys, base("subscribers", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(
      hasKey(keys, base("suppressions", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(
      hasKey(keys, qk.subscriber(IDENTITY.tenantId, IDENTITY.role, "sub_9")),
    ).toBe(true);
  });

  it("maps suppression-relevant subscriber events to suppressions", () => {
    for (const topic of [
      "subscriber.bounced",
      "subscriber.complained",
      "subscriber.unsubscribed",
    ]) {
      const keys = queryKeysForEvent({ topic }, IDENTITY);
      expect(
        hasKey(keys, base("suppressions", IDENTITY.tenantId, IDENTITY.role)),
      ).toBe(true);
    }
    const keys = queryKeysForEvent({ topic: "subscriber.updated" }, IDENTITY);
    expect(
      hasKey(keys, base("suppressions", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(false);
  });

  it("maps the emitted list membership event to lists and subscribers", () => {
    const keys = queryKeysForEvent(
      { topic: "list.subscriber.added" },
      IDENTITY,
    );
    expect(hasKey(keys, base("lists", IDENTITY.tenantId, IDENTITY.role))).toBe(
      true,
    );
    expect(
      hasKey(keys, base("subscribers", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
  });

  it("maps notification.created to the bell's notification-feed query (realtime)", () => {
    // The server notifyfanout event makes the in-app bell realtime instead of a
    // 60s poll — it must invalidate exactly the key the bell reads
    // (qk.notificationFeed).
    const keys = queryKeysForEvent({ topic: "notification.created" }, IDENTITY);
    expect(
      hasKey(keys, qk.notificationFeed(IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(isInvalidatableTopic("notification.created")).toBe(true);
    expect(WEB_INVALIDATION_TOPICS).toContain("notification.created");
  });

  it("maps approval.* to the dashboard + approvals settings scope", () => {
    const keys = queryKeysForEvent({ topic: "approval.requested" }, IDENTITY);
    const approvalsScope = qk.settings(
      IDENTITY.tenantId,
      IDENTITY.role,
      "approvals",
    );
    expect(
      hasKey(keys, base("dashboard", IDENTITY.tenantId, IDENTITY.role)),
    ).toBe(true);
    expect(hasKey(keys, approvalsScope)).toBe(true);
    expect(
      isPrefixOf(approvalsScope, [...approvalsScope, { status: "pending" }]),
    ).toBe(true);
  });

  it("does not advertise engagement-firehose or unpublished topics", () => {
    // Two reasons a topic is out of scope for web invalidation:
    //  - never published to the bus: sequence.generated / automation.failed /
    //    form.submitted / segment.updated (no emitter in those packages), and
    //    campaign.opened (a mobilepush/webhook type, not a Bus event);
    //  - published but engagement-firehose that doesn't dirty a list the user
    //    reads: subscriber.opened IS bus-published (listmonk_events) but an open
    //    must not trigger a subscribers-list refetch on every tab.
    for (const topic of [
      "sequence.generated",
      "automation.failed",
      "form.submitted",
      "segment.updated",
      "campaign.opened",
      "subscriber.opened",
    ]) {
      expect(queryKeysForEvent({ topic }, IDENTITY), topic).toEqual([]);
      expect(isInvalidatableTopic(topic), topic).toBe(false);
      expect(WEB_INVALIDATION_TOPICS, topic).not.toContain(topic);
    }
  });

  it("emits no 4-element list keys with a trailing null params slot", () => {
    // Every LIST domain must invalidate via the 3-element base() prefix.
    for (const topic of [
      "campaign.created",
      "subscriber.created",
      "list.subscriber.added",
      "approval.requested",
    ]) {
      const keys = queryKeysForEvent({ topic }, IDENTITY);
      for (const k of keys) {
        // A list key (base) is exactly length 3. Detail/settings keys carry a
        // real 4th segment (id / scope) — never a literal null.
        if (k.length === 4) {
          expect(k[3]).not.toBeNull();
        }
      }
    }
  });

  it("returns no keys for an unknown / out-of-scope topic", () => {
    expect(queryKeysForEvent({ topic: "cursor.move" }, IDENTITY)).toEqual([]);
    expect(queryKeysForEvent({ topic: "" }, IDENTITY)).toEqual([]);
    expect(
      queryKeysForEvent({ topic: undefined as unknown as string }, IDENTITY),
    ).toEqual([]);
  });

  it("scopes keys to the supplied tenant + role", () => {
    const a = queryKeysForEvent(
      { topic: "campaign.sent" },
      {
        tenantId: "tnt_a",
        role: "owner",
      },
    );
    const b = queryKeysForEvent(
      { topic: "campaign.sent" },
      {
        tenantId: "tnt_b",
        role: "owner",
      },
    );
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe("buildTopicsCsv (the ?topics= wire filter)", () => {
  it("passes the real subscription through unchanged", () => {
    expect(buildTopicsCsv([...WEB_INVALIDATION_TOPICS]).split(",")).toEqual([
      ...WEB_INVALIDATION_TOPICS,
    ]);
  });

  it("drops entries the gateway would silently discard", () => {
    // Before this validation existed, web did a bare `topics.join(",")` and the
    // server dropped anything failing its grammar with no error on either side.
    expect(
      buildTopicsCsv(["campaign.sent", "Campaign.Bad", "../x", "a..b"]),
    ).toBe("campaign.sent");
  });

  it("keeps underscore topics the gateway now accepts", () => {
    expect(
      buildTopicsCsv(["subscriber.lifecycle_stage_changed", "list_health.*"]),
    ).toBe("subscriber.lifecycle_stage_changed,list_health.*");
  });

  it("de-duplicates without reordering", () => {
    expect(buildTopicsCsv(["a.b", "c.d", "a.b"])).toBe("a.b,c.d");
  });

  it("falls back to the wildcard rather than a silently narrowed filter", () => {
    // An over-long CSV makes the gateway substitute its no-match sentinel, so
    // the stream would stay open and deliver nothing. Truncating mid-list would
    // be just as silent, so widen instead.
    const huge = Array.from(
      { length: 60 },
      (_, i) => `topic${i}.averylongeventname`,
    );
    expect(buildTopicsCsv(huge)).toBe("*");
    expect(buildTopicsCsv([])).toBe("*");
    expect(buildTopicsCsv(["!!!"])).toBe("*");
  });

  it("caps the entry count at the gateway's limit", () => {
    const many = Array.from({ length: 80 }, (_, i) => `t${i}.e`);
    expect(buildTopicsCsv(many).split(",")).toHaveLength(50);
  });
});

describe("canonical resources the web dashboard does not back", () => {
  it("declares deliverability + referrals as unbacked with no invented keys", () => {
    // The web dashboard ships no deliverability-hub or referral screen — a
    // repo-wide grep for a `queryKey` mentioning either domain returns nothing
    // (only the unrelated webhook-DELIVERIES page matches on substring). The
    // truthful adapter entry is therefore "no keys", declared here so the
    // absence is a decision rather than a gap someone forgot.
    expect([...WEB_UNBACKED_RESOURCES].sort()).toEqual([
      "deliverability",
      "referrals",
    ]);
    for (const resource of WEB_UNBACKED_RESOURCES) {
      expect(CANONICAL_RESOURCES).toContain(resource);
    }
  });

  it("recognises them upstream while emitting no web keys", () => {
    // Discriminating on BOTH sides: the shared authority must resolve each
    // live topic to a canonical resource, and every resource it resolves to
    // must be one web has declared unbacked. A future mapping change that
    // routes `list_health.degraded` to, say, `dashboard` fails here rather
    // than quietly producing a key web cannot serve.
    for (const topic of [
      "list_health.degraded",
      "referral.milestone.unlocked",
      "referral.payout.pending",
    ]) {
      const resources = canonicalResourcesForEvent(topic);
      expect(resources.length, topic).toBeGreaterThan(0);
      for (const resource of resources) {
        expect(WEB_UNBACKED_RESOURCES, topic).toContain(resource);
      }
      expect(queryKeysForEvent({ topic }, IDENTITY), topic).toEqual([]);
      expect(isInvalidatableTopic(topic), topic).toBe(false);
      expect(WEB_INVALIDATION_TOPICS, topic).not.toContain(topic);
    }
  });

  it("every topic web subscribes to survives the shared wire grammar", () => {
    // Web sends WEB_INVALIDATION_TOPICS verbatim as `?topics=`; the gateway
    // silently discards any entry failing its grammar. Before the grammar was
    // unified, web's own `subscriber.lifecycle_stage_changed` entry was being
    // dropped server-side — web asked for it on every connection and never
    // received one.
    for (const topic of WEB_INVALIDATION_TOPICS) {
      expect(isValidEventTopicFilter(topic), topic).toBe(true);
    }
  });
});

describe("isInvalidatableTopic / WEB_INVALIDATION_TOPICS", () => {
  it("recognises the in-scope domains", () => {
    expect(isInvalidatableTopic("campaign.sent")).toBe(true);
    expect(isInvalidatableTopic("subscriber.created")).toBe(true);
    expect(isInvalidatableTopic("presence.update")).toBe(false);
  });

  it("negotiates concrete emitted topics without firehose globs", () => {
    expect(WEB_INVALIDATION_TOPICS).toContain("campaign.sent");
    expect(WEB_INVALIDATION_TOPICS).toContain("subscriber.bounced");
    expect(WEB_INVALIDATION_TOPICS).toContain("approval.decided");
    for (const topic of WEB_INVALIDATION_TOPICS) {
      expect(topic).not.toContain("*");
    }
  });
});
