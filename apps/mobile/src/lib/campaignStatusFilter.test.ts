import { describe, expect, it } from "vitest";

import {
  ALL_KNOWN_CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_BUCKETS,
  bucketCounts,
  bucketCountsFromRows,
  bucketIsProvenEmpty,
  matchesCampaignStatus,
} from "./campaignStatusFilter";

describe("matchesCampaignStatus", () => {
  it("partitions every documented backend status into exactly one bucket", () => {
    for (const status of ALL_KNOWN_CAMPAIGN_STATUSES) {
      const hits = CAMPAIGN_STATUS_BUCKETS.filter((bucket) =>
        matchesCampaignStatus(status, bucket),
      );
      expect(hits, `status "${status}" landed in ${hits.join("/") || "no"} bucket`).toHaveLength(1);
    }
  });

  it("puts an unrecognised future status somewhere rather than nowhere", () => {
    const hits = CAMPAIGN_STATUS_BUCKETS.filter((bucket) =>
      matchesCampaignStatus("queued_for_reprocess", bucket),
    );
    expect(hits).toEqual(["sent"]);
  });

  it("no longer hides failed/cancelled inside Sent", () => {
    expect(matchesCampaignStatus("failed", "sent")).toBe(false);
    expect(matchesCampaignStatus("cancelled", "sent")).toBe(false);
    expect(matchesCampaignStatus("failed", "attention")).toBe(true);
    expect(matchesCampaignStatus("cancelled", "attention")).toBe(true);
    expect(matchesCampaignStatus("paused", "attention")).toBe(true);
  });

  it("treats an absent status as a draft", () => {
    expect(matchesCampaignStatus(undefined, "draft")).toBe(true);
    expect(matchesCampaignStatus("", "draft")).toBe(true);
    expect(matchesCampaignStatus(null, "draft")).toBe(true);
  });

  it("matches everything under all", () => {
    expect(matchesCampaignStatus("failed", "all")).toBe(true);
    expect(matchesCampaignStatus(undefined, "all")).toBe(true);
  });
});

describe("bucketCounts", () => {
  it("projects a server by_status map onto the chip buckets", () => {
    const counts = bucketCounts(
      { draft: 12, scheduled: 3, sent: 40, finished: 5, failed: 2, cancelled: 1 },
      63,
    );
    expect(counts.draft).toBe(12);
    expect(counts.scheduled).toBe(3);
    expect(counts.sent).toBe(45);
    expect(counts.attention).toBe(3);
    expect(counts.all).toBe(63);
  });

  it("falls back to the summed total when the server omits it", () => {
    const counts = bucketCounts({ draft: 2, sent: 3 }, 0);
    expect(counts.all).toBe(5);
  });

  it("ignores negative / non-numeric server values", () => {
    const counts = bucketCounts(
      { draft: -4, sent: Number.NaN, failed: 2 } as unknown as Record<string, number>,
      2,
    );
    expect(counts.draft).toBe(0);
    expect(counts.sent).toBe(0);
    expect(counts.attention).toBe(2);
  });

  it("survives a null/undefined map", () => {
    expect(bucketCounts(null, null).all).toBe(0);
    expect(bucketCounts(undefined, undefined).draft).toBe(0);
  });
});

describe("bucketCountsFromRows", () => {
  it("counts a loaded page window", () => {
    const counts = bucketCountsFromRows([
      { status: "draft" },
      { status: undefined },
      { status: "failed" },
      { status: "running" },
    ]);
    expect(counts.draft).toBe(2);
    expect(counts.attention).toBe(1);
    expect(counts.sent).toBe(1);
    expect(counts.all).toBe(4);
  });
});

describe("bucketIsProvenEmpty", () => {
  it("is only true when the server says the bucket is zero", () => {
    const counts = bucketCounts({ draft: 4 }, 4);
    expect(bucketIsProvenEmpty(counts, "scheduled")).toBe(true);
    expect(bucketIsProvenEmpty(counts, "draft")).toBe(false);
    expect(bucketIsProvenEmpty(counts, "all")).toBe(false);
    expect(bucketIsProvenEmpty(null, "scheduled")).toBe(false);
  });
});
