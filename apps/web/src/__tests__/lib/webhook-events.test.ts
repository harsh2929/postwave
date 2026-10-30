// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the webhook event catalog helpers (SETA-037).

import { describe, it, expect } from "vitest";

import { ALL_WEBHOOK_EVENTS } from "@/lib/webhooks-api";
import {
  WEBHOOK_EVENT_DESCRIPTIONS,
  filterWebhookEvents,
  groupWebhookEvents,
  webhookEventPrefix,
} from "@/lib/webhook-events";

describe("WEBHOOK_EVENT_DESCRIPTIONS", () => {
  it("has a non-empty description for every event", () => {
    for (const event of ALL_WEBHOOK_EVENTS) {
      expect(WEBHOOK_EVENT_DESCRIPTIONS[event]).toBeTruthy();
    }
  });
});

describe("webhookEventPrefix", () => {
  it("returns the namespace before the first dot", () => {
    expect(webhookEventPrefix("subscriber.created")).toBe("subscriber");
    expect(webhookEventPrefix("campaign.opens.digest")).toBe("campaign");
  });
  it("returns the whole string when there is no dot", () => {
    expect(webhookEventPrefix("ping")).toBe("ping");
  });
});

describe("groupWebhookEvents", () => {
  it("groups every event under its prefix without dropping any", () => {
    const groups = groupWebhookEvents();
    const flattened = groups.flatMap((g) => g.events);
    expect(flattened.sort()).toEqual([...ALL_WEBHOOK_EVENTS].sort());
  });

  it("produces the expected namespaces in first-seen order", () => {
    const prefixes = groupWebhookEvents().map((g) => g.prefix);
    expect(prefixes).toEqual([
      "subscriber",
      "campaign",
      "automation",
      "migration",
      "form",
      "sequence",
      "approval",
    ]);
  });

  it("keeps all subscriber.* events in one group", () => {
    const group = groupWebhookEvents().find((g) => g.prefix === "subscriber");
    expect(group?.events.length).toBe(10);
  });
});

describe("filterWebhookEvents", () => {
  it("returns all events for an empty query", () => {
    expect(filterWebhookEvents("")).toHaveLength(ALL_WEBHOOK_EVENTS.length);
    expect(filterWebhookEvents("   ")).toHaveLength(ALL_WEBHOOK_EVENTS.length);
  });

  it("matches on the event name", () => {
    const result = filterWebhookEvents("bounce");
    expect(result).toContain("subscriber.bounced");
    expect(result).not.toContain("campaign.sent");
  });

  it("matches on the description text (case-insensitive)", () => {
    // "spam" only appears in the description of subscriber.complained.
    const result = filterWebhookEvents("SPAM");
    expect(result).toContain("subscriber.complained");
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterWebhookEvents("zzz-nope")).toEqual([]);
  });
});
