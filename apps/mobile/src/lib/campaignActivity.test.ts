import { describe, expect, it } from "vitest";

import {
  activityActor,
  activityLabel,
  campaignActivityQueryKey,
  readCampaignActivity,
} from "./campaignActivity";

describe("campaignActivityQueryKey", () => {
  it("is rooted at the literal 'audit' — the event-bus live wire", () => {
    // api/event-cache-invalidation.ts maps `audit.created` onto the query
    // root "audit" and TanStack invalidates by prefix. Re-rooting this key
    // silently kills the activity card's live updates while every read
    // still works — exactly the regression this assertion exists to catch.
    expect(campaignActivityQueryKey("t-1", "c-1")[0]).toBe("audit");
    // Disjoint from useAudit()'s snapshot-backed vault keys by the second
    // element.
    expect(campaignActivityQueryKey("t-1", "c-1")).toEqual([
      "audit",
      "campaign-activity",
      "t-1",
      "c-1",
    ]);
  });
});

describe("activityLabel", () => {
  it("names the actions an operator recognises", () => {
    expect(activityLabel("campaign.scheduled")).toBe("Scheduled");
    expect(activityLabel("campaign.cancelled")).toBe("Cancelled");
  });

  it("degrades an unknown action to a readable phrase, never raw", () => {
    // A dotted engine action shown verbatim reads as an error to anyone who
    // does not know the audit vocabulary.
    expect(activityLabel("campaign.queue_filled")).toBe("Queue filled");
    expect(activityLabel("")).toBe("Changed");
    expect(activityLabel(undefined)).toBe("Changed");
  });
});

describe("activityActor", () => {
  it("prefers the human label", () => {
    expect(activityActor({ actorLabel: "ada@acme.com" })).toBe("ada@acme.com");
  });

  it("names non-human actors rather than saying 'Someone'", () => {
    expect(activityActor({ actorType: "system" })).toBe("Moosewave");
    expect(activityActor({ actorType: "api_key" })).toBe("An API key");
    expect(activityActor({ actorType: "agent" })).toBe("An agent");
    expect(activityActor({})).toBe("Someone");
  });
});

describe("readCampaignActivity", () => {
  const page = {
    rows: [
      {
        id: 2,
        action: "campaign.scheduled",
        actorLabel: "ada@acme.com",
        at: "2026-07-01T10:00:00Z",
      },
      {
        id: 1,
        action: "campaign.created",
        actorType: "system",
        at: "2026-06-30T10:00:00Z",
        redactedFields: ["metadata.subject"],
      },
    ],
  };

  it("reads the {rows} envelope the audit endpoint returns", () => {
    const rows = readCampaignActivity(page);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe("Scheduled");
    expect(rows[0]?.actor).toBe("ada@acme.com");
    expect(rows[0]?.absolute).not.toBe("");
  });

  it("also accepts a bare array, in case the envelope changes", () => {
    expect(readCampaignActivity(page.rows)).toHaveLength(2);
  });

  it("flags a redacted row — a masked value read as truth is a compliance failure", () => {
    expect(readCampaignActivity(page)[1]?.redactedNote).toBe("1 field redacted");
    expect(readCampaignActivity(page)[0]?.redactedNote).toBeNull();
  });

  it("bounds the list", () => {
    const many = { rows: Array.from({ length: 50 }, (_, i) => ({ id: i, at: "2026-07-01T10:00:00Z" })) };
    expect(readCampaignActivity(many, 5)).toHaveLength(5);
  });

  it("survives a payload that is neither", () => {
    expect(readCampaignActivity(null)).toEqual([]);
    expect(readCampaignActivity({ items: [] })).toEqual([]);
  });
});
