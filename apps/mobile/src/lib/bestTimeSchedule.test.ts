import { describe, expect, it } from "vitest";

import {
  BEST_TIME_WINDOWS,
  BURST_WARN_PER_MINUTE,
  bestTimeCommitMessage,
  bestTimeHeadline,
  bestTimeHourBars,
  bestTimeNotices,
  bestTimePeakBar,
  bestTimeRequestBody,
  bestTimeUnavailableMessage,
  isBestTimeWindow,
} from "./bestTimeSchedule";

describe("bestTimeRequestBody", () => {
  it("ships the SAME shape the preview and the commit both parse", () => {
    const body = bestTimeRequestBody({
      withinDays: 3,
      referenceAt: new Date("2026-07-26T09:00:00.000Z"),
    });
    expect(body).toEqual({
      within_days: 3,
      strategy: "per_recipient",
      reference_at: "2026-07-26T09:00:00.000Z",
    });
  });

  it("falls back to the gateway's own default window for an unsupported value", () => {
    expect(bestTimeRequestBody({ withinDays: 99 }).within_days).toBe(7);
    expect(bestTimeRequestBody({ withinDays: 0 }).within_days).toBe(7);
  });

  it("omits an unusable anchor rather than sending one the gateway will drop", () => {
    // The handler falls back to server-now on a malformed reference_at without
    // telling anyone, so sending garbage would silently move the schedule.
    expect(
      bestTimeRequestBody({ withinDays: 7, referenceAt: new Date("nope") }),
    ).not.toHaveProperty("reference_at");
    expect(
      bestTimeRequestBody({ withinDays: 7, referenceAt: null }),
    ).not.toHaveProperty("reference_at");
  });

  it("only accepts the windows the control offers", () => {
    for (const window of BEST_TIME_WINDOWS) {
      expect(isBestTimeWindow(window.value)).toBe(true);
    }
    expect(isBestTimeWindow(5)).toBe(false);
    expect(isBestTimeWindow("7")).toBe(false);
  });
});

describe("bestTimeHourBars", () => {
  it("always returns 24 hours in order even when the gateway sends fewer", () => {
    const bars = bestTimeHourBars([{ hour: 9, count: 10 }]);
    expect(bars).toHaveLength(24);
    expect(bars.map((b) => b.hour)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
    expect(bars[9]?.count).toBe(10);
    expect(bars[0]?.count).toBe(0);
  });

  it("reads buckets by hour, so an out-of-order payload cannot shift the axis", () => {
    const bars = bestTimeHourBars([
      { hour: 23, count: 4 },
      { hour: 1, count: 8 },
    ]);
    expect(bars[1]?.count).toBe(8);
    expect(bars[23]?.count).toBe(4);
  });

  it("drops buckets outside 0..23 instead of letting them corrupt the chart", () => {
    const bars = bestTimeHourBars([
      { hour: 24, count: 100 },
      { hour: -1, count: 100 },
      { hour: 3.5, count: 100 },
      { hour: 3, count: 2 },
    ]);
    expect(bars.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });

  it("scales every bar against the busiest hour and marks the peak", () => {
    const bars = bestTimeHourBars([
      { hour: 0, count: 25 },
      { hour: 6, count: 100 },
    ]);
    expect(bars[6]?.ratio).toBe(1);
    expect(bars[0]?.ratio).toBe(0.25);
    expect(bestTimePeakBar(bars)?.hour).toBe(6);
  });

  it("has no peak and no NaN ratios when nothing was scheduled", () => {
    const bars = bestTimeHourBars([]);
    expect(bars.every((b) => b.ratio === 0)).toBe(true);
    expect(bars.some((b) => b.peak)).toBe(false);
    expect(bestTimePeakBar(bars)).toBeNull();
  });

  it("carries an exact spoken value beside every compacted column", () => {
    const bars = bestTimeHourBars([{ hour: 9, count: 1 }]);
    expect(bars[9]?.spoken).toBe("09:00 UTC, 1 recipient");
    expect(bars[10]?.spoken).toBe("10:00 UTC, 0 recipients");
  });

  it("survives a malformed payload without throwing", () => {
    expect(bestTimeHourBars(undefined)).toHaveLength(24);
    expect(
      bestTimeHourBars([
        { hour: 2, count: Number.NaN },
        { hour: 2, count: -5 },
      ])[2]?.count,
    ).toBe(0);
  });
});

describe("bestTimeHeadline", () => {
  it("says what will happen, in recipients and days", () => {
    expect(bestTimeHeadline({ scheduled: 3214, within_days: 7 })).toBe(
      "3,214 recipients spread over the next 7 days, each at their own best hour.",
    );
  });

  it("reads zero as an honest empty result, not as a failure", () => {
    const line = bestTimeHeadline({ scheduled: 0, within_days: 7 });
    expect(line).toContain("No recipients could be scheduled");
    expect(line).not.toMatch(/error|failed/i);
  });

  it("prompts rather than asserting before a preview has run", () => {
    expect(bestTimeHeadline(null)).toBe(
      "Preview the schedule before committing it.",
    );
  });
});

describe("bestTimeNotices", () => {
  it("puts the warm-up breach first and says what to do about it", () => {
    const notices = bestTimeNotices({
      warmup_cap_breach: true,
      max_per_day: 1900,
      tier_cap_today: 1500,
      peak_day_utc: "2026-07-28",
      truncated: true,
      hard_cap: 200000,
    });
    expect(notices[0]?.key).toBe("warmup");
    expect(notices[0]?.tone).toBe("danger");
    expect(notices[0]?.message).toContain("1,900");
    expect(notices[0]?.message).toContain("1,500");
    expect(notices[0]?.message).toContain("2026-07-28");
    expect(notices[1]?.key).toBe("truncated");
  });

  it("stays silent about a breach the gateway could not compute", () => {
    // tier_cap_today is 0 when the warmup reader is unwired; claiming a breach
    // against an unknown cap would be inventing the number.
    expect(
      bestTimeNotices({
        warmup_cap_breach: true,
        max_per_day: 1900,
        tier_cap_today: 0,
      }),
    ).toEqual([]);
  });

  it("warns about a burst only above the pool-deferral threshold", () => {
    expect(
      bestTimeNotices({ max_per_minute: BURST_WARN_PER_MINUTE - 1 }),
    ).toEqual([]);
    const notices = bestTimeNotices({ max_per_minute: BURST_WARN_PER_MINUTE });
    expect(notices[0]?.key).toBe("burst");
  });

  it("returns nothing for a clean preview and for no preview at all", () => {
    expect(bestTimeNotices({ scheduled: 10, truncated: false })).toEqual([]);
    expect(bestTimeNotices(null)).toEqual([]);
  });
});

describe("bestTimeCommitMessage", () => {
  it("quotes the COMMIT's own count, which can differ from the dry run", () => {
    expect(
      bestTimeCommitMessage({ scheduled: 3210, within_days: 3 }),
    ).toBe(
      "Scheduled 3,210 recipients at their own best hour over the next 3 days.",
    );
  });

  it("does not claim a success it did not have", () => {
    expect(bestTimeCommitMessage({ scheduled: 0 })).toBe(
      "No recipients matched, so nothing was scheduled.",
    );
  });
});

describe("bestTimeUnavailableMessage", () => {
  it("reads a missing endpoint as a capability boundary, not an error", () => {
    for (const status of [404, 405, 501]) {
      const message = bestTimeUnavailableMessage(status, "not found");
      expect(message).toContain("isn't available on this workspace yet");
      expect(message).not.toContain("not found");
    }
  });

  it("names a permission failure as a permission failure", () => {
    expect(bestTimeUnavailableMessage(403, "forbidden")).toContain(
      "permission",
    );
  });

  it("keeps a real server message visible for anything else", () => {
    expect(bestTimeUnavailableMessage(500, "upstream exploded")).toContain(
      "upstream exploded",
    );
    expect(bestTimeUnavailableMessage(0, "   ")).toBe(
      "Couldn't preview the best-time schedule.",
    );
  });
});
