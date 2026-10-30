import { describe, it, expect } from "vitest";

import {
  CANONICAL_RESOURCES,
  EVENT_DOMAINS,
  EVENT_TOPIC_FILTER_PATTERN,
  canonicalResourcesForEvent,
  eventDomain,
  isInvalidatingTopic,
  isValidEventTopicFilter,
} from "./events.js";

describe("isValidEventTopicFilter (the wire grammar)", () => {
  it("accepts every topic and domain glob the gateway publishes", () => {
    for (const topic of [
      "*",
      "campaign.sent",
      "campaign.*",
      "list.subscriber.added",
      "list_health.degraded",
      "list_health.*",
      "subscriber.engagement_updated",
      "subscriber.lifecycle_stage_changed",
      "subscriber.pii_scan_truncated",
      "referral.milestone.unlocked",
      "referral.*",
      "notification.created",
      "audit.created",
    ]) {
      expect(isValidEventTopicFilter(topic), topic).toBe(true);
    }
  });

  it("rejects shapes the gateway must not accept", () => {
    for (const bad of [
      "",
      " ",
      "Campaign.Bad",
      "../x",
      "a..b",
      "_leading",
      "9x.y",
      "trailing.",
      "a.*.b",
      "campaign.*extra",
      "a b.c",
    ]) {
      expect(isValidEventTopicFilter(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("every EVENT_DOMAIN yields a legal glob", () => {
    for (const domain of EVENT_DOMAINS) {
      expect(isValidEventTopicFilter(`${domain}.*`), domain).toBe(true);
    }
  });

  it("exposes the pattern source so cross-language drift is checkable", () => {
    expect(typeof EVENT_TOPIC_FILTER_PATTERN).toBe("string");
    expect(EVENT_TOPIC_FILTER_PATTERN).toContain("a-z0-9_-");
  });
});

describe("canonicalResourcesForEvent (the shared authority)", () => {
  it("maps each domain to its canonical resources", () => {
    expect(canonicalResourcesForEvent("campaign.sent")).toEqual([
      "campaigns",
      "campaign",
      "dashboard",
    ]);
    expect(canonicalResourcesForEvent("subscriber.updated")).toEqual([
      "subscribers",
      "subscriber",
      "dashboard",
    ]);
    expect(canonicalResourcesForEvent("list.subscriber.added")).toEqual([
      "lists",
      "subscribers",
    ]);
    // The approval fix: approvals + dashboard on EVERY client (was `audit` on
    // desktop, missing dashboard on mobile).
    expect(canonicalResourcesForEvent("approval.requested")).toEqual([
      "approvals",
      "dashboard",
    ]);
    expect(canonicalResourcesForEvent("audit.created")).toEqual(["audit"]);
    // The server notification fanout event refreshes the in-app bell feed.
    expect(canonicalResourcesForEvent("notification.created")).toEqual([
      "notificationFeed",
    ]);
  });

  it("maps the deliverability-hub degradation event", () => {
    // apps/api/internal/deliverability_hub/hub.go emitDegraded() — published
    // live by the hub Worker (hub.go:850). Before this mapping the event
    // dirtied nothing on any client: the 2am "are we throttled?" screen kept
    // serving a 60s-stale score through an active degradation.
    expect(canonicalResourcesForEvent("list_health.degraded")).toEqual([
      "deliverability",
    ]);
  });

  it("maps referral program events", () => {
    // apps/api/internal/referrals/events.go, emitted by congrats_sender.go and
    // verification_worker.go through the main.go EventEmitter → Bus.Publish.
    expect(
      canonicalResourcesForEvent("referral.milestone.unlocked"),
    ).toEqual(["referrals"]);
    expect(canonicalResourcesForEvent("referral.payout.pending")).toEqual([
      "referrals",
    ]);
  });

  it("does NOT map the release-held account.* lifecycle", () => {
    // The API has no authoritative account suspension/lifecycle state. A
    // subscription downgrade and a dunning recovery are distinct state
    // machines and cannot truthfully form deactivate/reactivate. Keep clients
    // unsubscribed until the registered release locks have a real state owner.
    for (const t of [
      "account.compliance_suspend",
      "account.deactivate",
      "account.reactivate",
    ]) {
      expect(canonicalResourcesForEvent(t)).toEqual([]);
      expect(isInvalidatingTopic(t)).toBe(false);
    }
  });

  it("adds suppressions only for deliverability-terminal subscriber topics", () => {
    for (const t of [
      "subscriber.bounced",
      "subscriber.complained",
      "subscriber.unsubscribed",
    ]) {
      expect(canonicalResourcesForEvent(t)).toContain("suppressions");
    }
    // A generic subscriber edit must NOT refetch suppressions.
    expect(canonicalResourcesForEvent("subscriber.updated")).not.toContain(
      "suppressions",
    );
    expect(
      canonicalResourcesForEvent("subscriber.engagement_updated"),
    ).not.toContain("suppressions");
  });

  it("routes any concrete event under a known domain by prefix", () => {
    // A brand-new server event under a known domain still routes correctly.
    expect(canonicalResourcesForEvent("campaign.some_new_event")).toEqual([
      "campaigns",
      "campaign",
      "dashboard",
    ]);
  });

  it("no-ops for unknown / collaboration / malformed topics", () => {
    for (const t of ["presence.update", "cursor.move", "selection.move", "", "x"]) {
      expect(canonicalResourcesForEvent(t)).toEqual([]);
      expect(isInvalidatingTopic(t)).toBe(false);
    }
  });

  it("only ever returns declared canonical resources", () => {
    const allowed = new Set<string>(CANONICAL_RESOURCES);
    for (const domain of EVENT_DOMAINS) {
      for (const r of canonicalResourcesForEvent(`${domain}.anything`)) {
        expect(allowed.has(r)).toBe(true);
      }
    }
    // suppressions path too
    for (const r of canonicalResourcesForEvent("subscriber.bounced")) {
      expect(allowed.has(r)).toBe(true);
    }
  });

  it("eventDomain extracts the leading segment", () => {
    expect(eventDomain("campaign.sent")).toBe("campaign");
    expect(eventDomain("audit")).toBe("audit");
    expect(eventDomain("list.subscriber.added")).toBe("list");
  });
});
