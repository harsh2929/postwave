import { describe, expect, it } from "vitest";

import {
  EMPTY_REPLIES,
  MAX_RENDERED_REPLIES,
  MAX_SNIPPET_CHARS,
  readCampaignReplies,
  replyRateSpoken,
} from "./campaignReplies";

describe("readCampaignReplies", () => {
  it("returns the empty reading for absent / malformed payloads", () => {
    expect(readCampaignReplies(null)).toEqual(EMPTY_REPLIES);
    expect(readCampaignReplies(undefined)).toEqual(EMPTY_REPLIES);
    expect(readCampaignReplies({})).toEqual(EMPTY_REPLIES);
  });

  it("converts the wire's FRACTION to a percent exactly once", () => {
    // The handler computes distinct_replyers / unique_recipients and does not
    // scale it. Reading it as an already-percent value understates by 100x.
    const r = readCampaignReplies({
      replies: 12,
      distinct_replyers: 10,
      unique_recipients: 250,
      reply_rate: 0.04,
    });
    expect(r.replyRatePercent).toBeCloseTo(4, 6);
  });

  it("clamps an impossible rate rather than rendering it", () => {
    expect(readCampaignReplies({ reply_rate: 1.37 }).replyRatePercent).toBe(100);
    expect(readCampaignReplies({ reply_rate: -1 }).replyRatePercent).toBe(0);
    expect(readCampaignReplies({ reply_rate: "0.5" }).replyRatePercent).toBe(0);
  });

  it("parses recent rows and gives each a stable, unique key", () => {
    const r = readCampaignReplies({
      replies: 2,
      recent: [
        {
          recipient_email: "a@example.com",
          subject: "Re: Launch",
          body_snippet: "Looks great",
          source: "imap",
          received_at: "2026-07-01T09:00:00Z",
        },
        {
          recipient_email: "a@example.com",
          subject: "Re: Launch",
          body_snippet: "One more thing",
          source: "imap",
          received_at: "2026-07-01T09:00:00Z",
        },
      ],
    });
    expect(r.rows).toHaveLength(2);
    // Same address, same second: the index is what keeps the keys distinct.
    expect(r.rows[0]?.key).not.toBe(r.rows[1]?.key);
    expect(r.rows[0]?.receivedAt).toBe(Date.parse("2026-07-01T09:00:00Z"));
    expect(r.empty).toBe(false);
  });

  it("drops a row with no address, subject or text", () => {
    const r = readCampaignReplies({
      replies: 1,
      recent: [
        { received_at: "2026-07-01T09:00:00Z" },
        { recipient_email: "b@example.com" },
        "not-an-object",
        null,
      ],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.email).toBe("b@example.com");
  });

  it("bounds a long snippet", () => {
    const long = "y".repeat(MAX_SNIPPET_CHARS + 100);
    const r = readCampaignReplies({
      replies: 1,
      recent: [{ recipient_email: "a@example.com", body_snippet: long }],
    });
    expect(r.rows[0]?.snippet.length).toBe(MAX_SNIPPET_CHARS + 1);
    expect(r.rows[0]?.snippet.endsWith("…")).toBe(true);
  });

  it("reports truncation only when the server's page is genuinely full", () => {
    const many = Array.from({ length: MAX_RENDERED_REPLIES }, (_, i) => ({
      recipient_email: `p${i}@example.com`,
      body_snippet: "hi",
      received_at: "2026-07-01T09:00:00Z",
    }));
    expect(
      readCampaignReplies({ replies: 120, recent: many }).truncated,
    ).toBe(true);
    // A short page with a higher total is a counting quirk, not "more behind".
    expect(
      readCampaignReplies({ replies: 120, recent: many.slice(0, 3) }).truncated,
    ).toBe(false);
  });

  it("treats a campaign with a count but no previews as non-empty", () => {
    expect(readCampaignReplies({ replies: 4, recent: [] }).empty).toBe(false);
  });
});

describe("replyRateSpoken", () => {
  it("says the denominator, not just the percentage", () => {
    const r = readCampaignReplies({
      replies: 12,
      distinct_replyers: 10,
      unique_recipients: 250,
      reply_rate: 0.04,
    });
    expect(replyRateSpoken(r)).toBe(
      "4.0 percent reply rate: 10 of 250 recipients replied.",
    );
  });

  it("refuses to state a rate with no denominator", () => {
    expect(replyRateSpoken(EMPTY_REPLIES)).toContain("unavailable");
  });
});
