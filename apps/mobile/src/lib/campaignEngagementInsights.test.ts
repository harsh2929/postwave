/**
 * The two campaign-report readings this module owns, pinned against the Go
 * handlers they read:
 *
 *   GET /campaigns/{id}/timeseries    apps/api/internal/analytics/campaign_timeseries.go
 *   GET /campaigns/{id}/locale-report apps/api/internal/campaign_translations/campaign_translations.go:134
 *
 * The assertions that matter are the ones about CLAIMS, not shapes: which end
 * of a truncated series the reader is looking at, what a locale percentage is
 * a percentage OF, and the difference between "nothing happened" and "the
 * payload was unreadable".
 *
 * Node-run: this module imports lib/format only.
 */
import { describe, expect, it } from "vitest";

import {
  hourlyEmptyMessage,
  hourlyWindowCaption,
  localeEmptyMessage,
  localeReportRows,
  localeReportUnreadable,
  readHourlyEngagement,
} from "./campaignEngagementInsights";

/** A response shaped exactly like CampaignTimeseriesResult (:36). */
const SERIES = {
  campaign_id: "c1",
  buckets: [
    { hour: "2026-08-21T13:00:00Z", opens: 12, clicks: 3, unsubs: 0 },
    // The server gap-fills, so a quiet hour arrives as real zeros.
    { hour: "2026-08-21T14:00:00Z", opens: 0, clicks: 0, unsubs: 0 },
    { hour: "2026-08-21T15:00:00Z", opens: 40, clicks: 9, unsubs: 2 },
  ],
  from: "2026-08-21T13:00:00Z",
  to: "2026-08-21T15:00:00Z",
  as_of: "2026-08-21T15:30:00Z",
  timezone: "UTC",
  granularity: "hour",
  truncated: false,
};

describe("readHourlyEngagement — the send's shape over time", () => {
  it("maps every bucket to a UTC-labelled point and totals each series", () => {
    const r = readHourlyEngagement(SERIES);
    expect(r.labels).toEqual(["Aug 21 13:00", "Aug 21 14:00", "Aug 21 15:00"]);
    expect(r.opens).toEqual([12, 0, 40]);
    expect(r.clicks).toEqual([3, 0, 9]);
    expect(r.unsubs).toEqual([0, 0, 2]);
    expect(r.totalOpens).toBe(52);
    expect(r.totalClicks).toBe(12);
    expect(r.totalUnsubs).toBe(2);
    expect(r.empty).toBe(false);
    expect(r.unreadable).toBe(false);
  });

  it("keeps a gap-filled zero as a ZERO, never as a break in the line", () => {
    // The server zero-fills (zeroFillHourlyBetween), so a null here would draw
    // a gap where the truth is a measured hour of no engagement.
    const r = readHourlyEngagement(SERIES);
    expect(r.opens[1]).toBe(0);
    expect(r.opens[1]).not.toBeNull();
  });

  it("reads unsubscribes, which the endpoint reports and the desktop plots", () => {
    const r = readHourlyEngagement(SERIES);
    expect(r.unsubs).toEqual([0, 0, 2]);
    expect(hourlyWindowCaption(r)).toContain("2 unsubscribes");
  });

  it("skips a bucket with no hour instead of shifting the series", () => {
    const r = readHourlyEngagement({
      buckets: [
        { hour: "2026-08-21T13:00:00Z", opens: 5, clicks: 1, unsubs: 0 },
        { opens: 999, clicks: 999, unsubs: 999 },
      ],
    });
    expect(r.labels).toHaveLength(1);
    expect(r.totalOpens).toBe(5);
  });

  it("floors garbled counts at zero rather than charting NaN or a negative", () => {
    const r = readHourlyEngagement({
      buckets: [
        { hour: "2026-08-21T13:00:00Z", opens: -4, clicks: "9", unsubs: null },
      ],
    });
    expect(r.opens).toEqual([0]);
    expect(r.clicks).toEqual([0]);
    expect(r.unsubs).toEqual([0]);
  });

  it("falls back to the raw string when an hour will not parse", () => {
    const r = readHourlyEngagement({
      buckets: [{ hour: "not-a-time", opens: 1, clicks: 0, unsubs: 0 }],
    });
    expect(r.labels).toEqual(["not-a-time"]);
  });

  it("is empty — not unreadable — when the campaign recorded nothing", () => {
    const r = readHourlyEngagement({ campaign_id: "c1", buckets: [] });
    expect(r.empty).toBe(true);
    expect(r.unreadable).toBe(false);
  });

  it("is empty when every bucket is zero: gap-fill alone is not engagement", () => {
    const r = readHourlyEngagement({
      buckets: [{ hour: "2026-08-21T13:00:00Z", opens: 0, clicks: 0, unsubs: 0 }],
    });
    expect(r.empty).toBe(true);
  });

  it("is NOT empty when the only signal in the window is an unsubscribe", () => {
    const r = readHourlyEngagement({
      buckets: [{ hour: "2026-08-21T13:00:00Z", opens: 0, clicks: 0, unsubs: 1 }],
    });
    expect(r.empty).toBe(false);
  });

  it("calls a truthy payload it cannot map UNREADABLE, not empty-and-fine", () => {
    // Response-shape drift: an envelope, a bare array, a missing list.
    expect(readHourlyEngagement([SERIES]).unreadable).toBe(true);
    expect(readHourlyEngagement({ data: SERIES }).unreadable).toBe(true);
    expect(readHourlyEngagement({ buckets: {} }).unreadable).toBe(true);
    expect(readHourlyEngagement("<html>").unreadable).toBe(true);
  });

  it("treats an absent endpoint (null) as absent, not as drift", () => {
    const r = readHourlyEngagement(null);
    expect(r.unreadable).toBe(false);
    expect(r.empty).toBe(true);
    expect(r.labels).toEqual([]);
  });
});

describe("hourlyWindowCaption — which 30 days the reader is looking at", () => {
  it("states the totals and the timezone, with no window claim, when whole", () => {
    const caption = hourlyWindowCaption(readHourlyEngagement(SERIES));
    expect(caption).toBe(
      "Hour by hour after the send, UTC · 52 opens, 12 clicks, 2 unsubscribes.",
    );
    expect(caption).not.toMatch(/30 days/u);
  });

  it("says the MOST RECENT 30 days when the server truncated — never the first", () => {
    // campaign_timeseries.go:112-118 sets from = to − 719h and only then flags
    // `truncated`, so the hours that were dropped are the OLDEST. Copy saying
    // "the first 30 days" would point the reader at the opposite end of the
    // send and quietly invert every conclusion drawn from the curve.
    const caption = hourlyWindowCaption(
      readHourlyEngagement({ ...SERIES, truncated: true }),
    );
    expect(caption).toContain("most recent 30 days");
    expect(caption).toContain("earlier hours of this send are not shown");
    expect(caption).not.toMatch(/first 30 days/u);
  });
});

describe("the empty-state copy — a finding vs a parsing failure", () => {
  it("reports an empty campaign as an empty campaign", () => {
    expect(hourlyEmptyMessage(readHourlyEngagement({ buckets: [] }))).toBe(
      "No hourly engagement has been recorded for this campaign.",
    );
    expect(localeEmptyMessage({ campaign_id: "c1", locales: [] })).toBe(
      "No per-locale stats have been recorded for this campaign.",
    );
  });

  it("never states drift as a finding about the send", () => {
    const drift = hourlyEmptyMessage(readHourlyEngagement({ buckets: {} }));
    expect(drift).toBe(
      "The hourly series answered in a shape this app can't read, so nothing is shown rather than a guess.",
    );
    expect(drift).not.toMatch(/has been recorded/u);
    const localeDrift = localeEmptyMessage([LOCALES]);
    expect(localeDrift).toBe(
      "The per-locale report answered in a shape this app can't read, so nothing is shown rather than a guess.",
    );
    expect(localeDrift).not.toMatch(/have been recorded/u);
  });
});

/** Shaped like the localeReport handler's response (:169). */
const LOCALES = {
  campaign_id: "c1",
  locales: [
    { locale: "en-US", sent: 1200, opens: 480, clicks: 96 },
    { locale: "de-DE", sent: 300, opens: 90, clicks: 12 },
    { locale: "unknown", sent: 60, opens: 6, clicks: 0 },
  ],
};

describe("localeReportRows — which variant actually performed", () => {
  it("ranks by recipients sent and sizes each bar against the biggest", () => {
    const rows = localeReportRows(LOCALES);
    expect(rows.map((r) => r.label)).toEqual([
      "en-US",
      "de-DE",
      "No locale recorded",
    ]);
    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBeCloseTo(0.25, 5);
  });

  it("prints the open RATE, because opens are events and not people", () => {
    const rows = localeReportRows(LOCALES);
    expect(rows[0]?.value).toBe("1,200 sent · 40% open rate");
  });

  it("does not clamp a rate above 100%: repeat opens are real", () => {
    // opens counts 'opened' EVENTS, so a locale can exceed its sent count.
    // Clamping would invent a ceiling the server never claimed.
    const rows = localeReportRows({
      locales: [{ locale: "fr-FR", sent: 100, opens: 180, clicks: 20 }],
    });
    expect(rows[0]?.value).toBe("100 sent · 180% open rate");
  });

  it("omits the rate entirely when there is no denominator", () => {
    const rows = localeReportRows({
      locales: [{ locale: "es-ES", sent: 0, opens: 4, clicks: 1 }],
    });
    expect(rows[0]?.value).toBe("0 sent");
    expect(rows[0]?.share).toBe(0);
  });

  it("names the server's 'unknown' locale in words, not as a code", () => {
    const rows = localeReportRows({
      locales: [{ locale: "unknown", sent: 10, opens: 1, clicks: 0 }],
    });
    expect(rows[0]?.label).toBe("No locale recorded");
  });

  it("treats a blank or absent locale as the same unrecorded case", () => {
    const rows = localeReportRows({
      locales: [
        { locale: "   ", sent: 10, opens: 1, clicks: 0 },
        { sent: 4, opens: 0, clicks: 0 },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual([
      "No locale recorded",
      "No locale recorded",
    ]);
  });

  it("speaks the exact counts the compact value line leaves out", () => {
    const rows = localeReportRows(LOCALES);
    expect(rows[1]?.spoken).toBe("de-DE: 300 sent, 90 opens, 12 clicks");
  });

  it("keeps the TOP rows when it truncates, whatever order the server sent", () => {
    const many = {
      locales: Array.from({ length: 10 }, (_, i) => ({
        locale: `l${i}`,
        sent: i * 10,
        opens: i,
        clicks: 0,
      })),
    };
    const rows = localeReportRows(many);
    expect(rows).toHaveLength(8);
    expect(rows[0]?.label).toBe("l9");
    expect(rows.map((r) => r.label)).not.toContain("l0");
  });

  it("returns nothing for a payload it cannot map, and says which case it is", () => {
    expect(localeReportRows([LOCALES])).toEqual([]);
    expect(localeReportUnreadable([LOCALES])).toBe(true);
    expect(localeReportUnreadable({ locales: {} })).toBe(true);
    expect(localeReportUnreadable("<html>")).toBe(true);
    // A campaign with no recorded locales is an ANSWER, not drift.
    expect(localeReportUnreadable({ campaign_id: "c1", locales: [] })).toBe(
      false,
    );
    expect(localeReportUnreadable(null)).toBe(false);
    expect(localeReportUnreadable(undefined)).toBe(false);
  });

  it("skips a non-object row rather than rendering a blank rank", () => {
    const rows = localeReportRows({
      locales: ["en-US", { locale: "en-US", sent: 5, opens: 1, clicks: 0 }],
    });
    expect(rows).toHaveLength(1);
  });
});
