import { describe, expect, it } from "vitest";

import { extentOf } from "./chartScale";
import {
  parseReplySummary,
  parseReplyTimeseries,
  parseReplyTopSenders,
  REPLIES_EMPTY_HEADLINE,
  replyHeadline,
  replyProvenanceCaption,
  replyTrend,
  replyWindowCaption,
  replyWindowDays,
  topSenderRows,
  TOP_SENDERS_SHOWN,
  TREND_NO_POINTS,
  TREND_ONE_POINT,
  type ReplySummary,
} from "./replyAnalytics";

// The three payloads exactly as reply_analytics.go writes them (Summary :123,
// Timeseries :319, TopSenders :268). A test that invents a friendlier shape
// would pass while the screen rendered em-dashes.
const SUMMARY_WIRE = {
  window_days: 30,
  total: 212,
  matched: 207,
  unmatched: 5,
  human_replies: 180,
  excluded_non_human: 20,
  unclassified_replies: 12,
  top_campaigns: [{ campaign_id: "c1", replies: 90 }],
};

function summary(over: Partial<ReplySummary> = {}): ReplySummary {
  return {
    windowDays: 30,
    total: 212,
    humanReplies: 180,
    excludedNonHuman: 20,
    unclassified: 12,
    matched: 207,
    unmatched: 5,
    ...over,
  };
}

describe("parseReplySummary", () => {
  it("reads the handler's wire shape", () => {
    expect(parseReplySummary(SUMMARY_WIRE)).toEqual(summary());
  });

  it("answers null for a payload it cannot read, never a zeroed card", () => {
    expect(parseReplySummary(null)).toBeNull();
    expect(parseReplySummary("nope")).toBeNull();
    expect(parseReplySummary([])).toBeNull();
    // `total` is the load-bearing field: a truncated body without it must not
    // become "No replies in this window."
    const { total: _dropped, ...withoutTotal } = SUMMARY_WIRE;
    expect(parseReplySummary(withoutTotal)).toBeNull();
    expect(parseReplySummary({ ...SUMMARY_WIRE, total: "212" })).toBeNull();
    expect(parseReplySummary({ ...SUMMARY_WIRE, total: -1 })).toBeNull();
  });

  it("zero-fills the secondary counts and truncates fractions", () => {
    const parsed = parseReplySummary({ total: 3.9, human_replies: "x" });
    expect(parsed).toEqual({
      windowDays: 0,
      total: 3,
      humanReplies: 0,
      excludedNonHuman: 0,
      unclassified: 0,
      matched: 0,
      unmatched: 0,
    });
  });
});

describe("parseReplyTimeseries", () => {
  it("reads the handler's points and keeps a missing count as a GAP", () => {
    const parsed = parseReplyTimeseries({
      window_days: 3,
      points: [
        { date: "2026-08-30", replies: 4 },
        { date: "2026-08-31" },
        { date: "2026-09-01", replies: 0 },
      ],
    });
    expect(parsed).toEqual([
      { date: "2026-08-30", replies: 4 },
      { date: "2026-08-31", replies: null },
      { date: "2026-09-01", replies: 0 },
    ]);
  });

  it("treats a null or missing array as empty, and a non-object as unreadable", () => {
    expect(parseReplyTimeseries({ points: null })).toEqual([]);
    expect(parseReplyTimeseries({})).toEqual([]);
    expect(parseReplyTimeseries({ points: "not-a-list" })).toEqual([]);
    expect(parseReplyTimeseries(null)).toBeNull();
    expect(parseReplyTimeseries([])).toBeNull();
  });

  it("drops rows without a date rather than inventing an x position", () => {
    expect(
      parseReplyTimeseries({ points: [{ replies: 3 }, { date: "", replies: 1 }, 7] }),
    ).toEqual([]);
  });
});

describe("parseReplyTopSenders", () => {
  it("reads the handler's senders", () => {
    expect(
      parseReplyTopSenders({
        window_days: 30,
        senders: [
          { recipient_email: " a@x.io ", replies: 7, last_at: "2026-08-30T10:00:00Z" },
          { recipient_email: "b@x.io", replies: 2 },
        ],
      }),
    ).toEqual([
      { email: "a@x.io", replies: 7, lastAt: "2026-08-30T10:00:00Z" },
      { email: "b@x.io", replies: 2, lastAt: null },
    ]);
  });

  it("treats a null array as empty and a non-object as unreadable", () => {
    expect(parseReplyTopSenders({ senders: null })).toEqual([]);
    expect(parseReplyTopSenders({})).toEqual([]);
    expect(parseReplyTopSenders(undefined)).toBeNull();
  });

  it("skips rows with no address — a bar with no name is noise", () => {
    expect(
      parseReplyTopSenders({ senders: [{ replies: 3 }, { recipient_email: "  " }, null] }),
    ).toEqual([]);
  });
});

describe("replyHeadline", () => {
  it("carries the raw volume AND the human subset", () => {
    expect(replyHeadline(summary())).toBe("212 replies · 180 written by people");
    expect(
      replyHeadline(summary({ total: 1, humanReplies: 1, excludedNonHuman: 0, unclassified: 0 })),
    ).toBe("1 reply · 1 written by people");
  });

  it("says nothing was classified rather than '0 written by people'", () => {
    expect(
      replyHeadline(summary({ total: 40, humanReplies: 0, excludedNonHuman: 0, unclassified: 40 })),
    ).toBe("40 replies · not yet classified");
    // Zero human WITH exclusions is a real verdict: every reply was a machine.
    expect(
      replyHeadline(summary({ total: 40, humanReplies: 0, excludedNonHuman: 40, unclassified: 0 })),
    ).toBe("40 replies · 0 written by people");
  });

  it("names an empty window", () => {
    expect(replyHeadline(summary({ total: 0 }))).toBe(REPLIES_EMPTY_HEADLINE);
  });
});

describe("replyProvenanceCaption", () => {
  it("states only the non-zero parts, in a fixed order", () => {
    expect(replyProvenanceCaption(summary())).toBe(
      "20 auto-responders and bounce chatter excluded · 12 not yet classified · 5 not matched to a campaign.",
    );
    expect(
      replyProvenanceCaption(summary({ excludedNonHuman: 0, unclassified: 0, unmatched: 3 })),
    ).toBe("3 not matched to a campaign.");
  });

  it("is silent when there is nothing to disclose", () => {
    expect(replyProvenanceCaption(summary({ total: 0 }))).toBeNull();
    expect(
      replyProvenanceCaption(summary({ excludedNonHuman: 0, unclassified: 0, unmatched: 0 })),
    ).toBeNull();
  });
});

describe("replyTrend", () => {
  const day = (n: number, replies: number | null) => ({
    date: `2026-09-${String(n).padStart(2, "0")}`,
    replies,
  });

  it("draws nothing under an empty headline", () => {
    expect(replyTrend([day(1, 0), day(2, 0)], 0)).toEqual({ kind: "none" });
  });

  it("refuses an empty series and a single measured day, each with its own sentence", () => {
    expect(replyTrend([], 5)).toEqual({ kind: "insufficient", message: TREND_NO_POINTS });
    expect(replyTrend([day(1, 5)], 5)).toEqual({
      kind: "insufficient",
      message: TREND_ONE_POINT,
    });
    // Two rows but only one MEASURED: a gap is not a second point.
    expect(replyTrend([day(1, 5), day(2, null)], 5)).toEqual({
      kind: "insufficient",
      message: TREND_ONE_POINT,
    });
  });

  it("charts two or more measured days, keeping gaps as nulls", () => {
    expect(replyTrend([day(1, 2), day(2, null), day(3, 4)], 6)).toEqual({
      kind: "chart",
      labels: ["2026-09-01", "2026-09-02", "2026-09-03"],
      values: [2, null, 4],
    });
  });

  it("charts a flat-at-zero week without collapsing the axis", () => {
    // A reply on the window's edge can sit in the summary and not the series
    // (the two reads use different day boundaries), so this case is reachable.
    const trend = replyTrend(
      [day(1, 0), day(2, 0), day(3, 0), day(4, 0), day(5, 0), day(6, 0), day(7, 0)],
      1,
    );
    expect(trend.kind).toBe("chart");
    if (trend.kind !== "chart") return;
    // The chart's own scale is what keeps this from dividing by zero; pin the
    // pairing so a future "values: []" shortcut here cannot regress it.
    expect(extentOf(trend.values)).toEqual({ min: 0, max: 1 });
  });
});

describe("topSenderRows", () => {
  const senders = [
    { email: "a@x.io", replies: 8, lastAt: "2026-08-30T10:00:00Z" },
    { email: "b@x.io", replies: 4, lastAt: null },
    { email: "c@x.io", replies: 1, lastAt: null },
  ];

  it("ranks shares against the biggest replier and speaks each row", () => {
    const rows = topSenderRows(senders);
    expect(rows.map((r) => r.share)).toEqual([1, 0.5, 0.125]);
    expect(rows[0]).toEqual({
      key: "a@x.io-0",
      email: "a@x.io",
      replies: 8,
      countLabel: "8 replies",
      lastAt: "2026-08-30T10:00:00Z",
      spoken: "a@x.io, 8 replies",
      share: 1,
    });
    expect(rows[2]?.countLabel).toBe("1 reply");
  });

  it("caps the list at the shown limit and survives an empty list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      email: `u${i}@x.io`,
      replies: 12 - i,
      lastAt: null,
    }));
    expect(topSenderRows(many)).toHaveLength(TOP_SENDERS_SHOWN);
    expect(topSenderRows(many, 2)).toHaveLength(2);
    expect(topSenderRows([])).toEqual([]);
  });

  it("gives a zero-count list zero shares rather than NaN", () => {
    expect(topSenderRows([{ email: "z@x.io", replies: 0, lastAt: null }])[0]?.share).toBe(0);
  });
});

describe("window copy", () => {
  it("maps the screen's range tokens to the endpoints' days", () => {
    expect(replyWindowDays("7d")).toBe(7);
    expect(replyWindowDays("30d")).toBe(30);
    expect(replyWindowDays("90d")).toBe(90);
    expect(replyWindowDays("bogus")).toBe(30);
  });

  it("leads the caveat with the window it applies to", () => {
    expect(replyWindowCaption("Last 7 days")).toMatch(/^Last 7 days\. Counts every inbound reply/u);
  });
});
