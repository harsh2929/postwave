/**
 * lib/campaignEngagementInsights.ts — the two per-campaign analytics readings
 * the phone report never had:
 *
 *   GET /campaigns/{id}/timeseries     → hourly opens/clicks/unsubs after the send
 *     (apps/api/internal/analytics/campaign_timeseries.go:202 handler,
 *      :36 CampaignTimeseriesResult)
 *   GET /campaigns/{id}/locale-report  → per-locale sent/opens/clicks
 *     (apps/api/internal/campaign_translations/campaign_translations.go:134)
 *
 * The contract facts every function here is built around, because getting any
 * one of them wrong ships a lie:
 *
 *  - THE HOURLY SERIES IS GAP-FILLED AND CAPPED AT THE NEWEST 720 BUCKETS.
 *    The handler sets `from = to − 719h` and only then flags `truncated`
 *    (campaign_timeseries.go:112-118), so a truncated series is the MOST RECENT
 *    30 days — never the first 30. Copy that says "first" points a reader at
 *    the opposite end of their own send.
 *  - THE BUCKET COUNTS ARE EVENTS, NOT PEOPLE. `opens` counts 'opened' rows,
 *    so an hourly total is not a count of openers and must not be phrased as
 *    one. The same is true of the locale report's opens/clicks, which is why
 *    the per-locale figure is called an open RATE and not "% of people".
 *  - LOCALE ROWS ARRIVE ORDERED BY SENT DESC and `"unknown"` is a real value
 *    the SQL emits — COALESCE(NULLIF(s.locale, ''), 'unknown') — for a
 *    recipient with no recorded locale, not a client-side placeholder.
 *  - A TRUTHY PAYLOAD THIS READER CANNOT MAP IS NOT AN EMPTY CAMPAIGN. Both
 *    readings report `unreadable` separately from "nothing recorded", so the
 *    card says which of the two happened instead of presenting response-shape
 *    drift as a confident "no engagement" — the failure class the 2026-07
 *    mobile logic audit found on screen after screen.
 *
 * Pure and import-light (lib/format only), so every rule above is node-tested.
 */
import { num, percent } from "@/lib/format";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/* --------------------------------------------------------- hourly series */

export interface HourlyEngagementReading {
  labels: string[];
  opens: (number | null)[];
  clicks: (number | null)[];
  unsubs: (number | null)[];
  totalOpens: number;
  totalClicks: number;
  totalUnsubs: number;
  /** The server cut the series to its newest 720 hours. */
  truncated: boolean;
  /** True when the endpoint answered but recorded no engagement at all. */
  empty: boolean;
  /** True when a non-null payload was not a series this reader can map. */
  unreadable: boolean;
}

/**
 * Month abbreviations for the UTC axis, indexed by `getUTCMonth()`.
 *
 * WHY A TABLE AND NOT `lib/format`. Every other date in the app renders in the
 * reader's own zone and goes through `lib/format`, which is right for a
 * timestamp. These are not timestamps: they are the server's UTC hour BUCKETS,
 * and the hour printed beside the month (`getUTCHours()`) is UTC too. Shifting
 * only the month name into the device zone would put "Sep 1 23:00" next to an
 * hour that belongs to August — the two halves of one tick disagreeing. So the
 * whole tick is read off the UTC clock, and this is the last piece of it that
 * still needed a calendar name. `lib/format` owns no zone-pinned helper (its
 * cached formatters are all device-zone by design), which is why this stays a
 * lookup rather than a second formatter competing with it.
 */
const UTC_MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Aug 21 14:00" from an RFC3339 hour bucket; falls back to the raw string. */
function hourLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = UTC_MONTH_ABBR[d.getUTCMonth()] ?? "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${month} ${d.getUTCDate()} ${hh}:00`;
}

export function readHourlyEngagement(raw: unknown): HourlyEngagementReading {
  const row = record(raw);
  // `null` is "the payload carried no buckets ARRAY" — distinct from an empty
  // one, which is a real answer for a campaign with no recorded events.
  const wire = row && Array.isArray(row.buckets) ? row.buckets : null;
  const buckets = Array.isArray(wire) ? wire : [];
  const labels: string[] = [];
  const opens: (number | null)[] = [];
  const clicks: (number | null)[] = [];
  const unsubs: (number | null)[] = [];
  let totalOpens = 0;
  let totalClicks = 0;
  let totalUnsubs = 0;
  for (const entry of buckets) {
    const bucket = record(entry);
    if (!bucket || typeof bucket.hour !== "string") continue;
    labels.push(hourLabel(bucket.hour));
    const o = count(bucket.opens);
    const c = count(bucket.clicks);
    const u = count(bucket.unsubs);
    opens.push(o);
    clicks.push(c);
    unsubs.push(u);
    totalOpens += o;
    totalClicks += c;
    totalUnsubs += u;
  }
  return {
    labels,
    opens,
    clicks,
    unsubs,
    totalOpens,
    totalClicks,
    totalUnsubs,
    truncated: row?.truncated === true,
    empty:
      labels.length === 0 ||
      (totalOpens === 0 && totalClicks === 0 && totalUnsubs === 0),
    unreadable: raw != null && wire === null,
  };
}

/**
 * The caption naming the window and, when the server cut it, WHICH end it
 * kept. The cap drops the OLDEST hours, so a truncated series is the tail of
 * the send, not its opening.
 */
export function hourlyWindowCaption(r: HourlyEngagementReading): string {
  const base = `Hour by hour after the send, UTC · ${num(r.totalOpens)} opens, ${num(r.totalClicks)} clicks, ${num(r.totalUnsubs)} unsubscribes.`;
  return r.truncated
    ? `${base} The server keeps 30 days of hourly buckets, so these are the most recent 30 days — earlier hours of this send are not shown.`
    : base;
}

/**
 * What the collapsed card says when there is nothing to draw. The two cases
 * must not share a sentence: "no engagement was recorded" is a finding about
 * the campaign, and stating it over a payload this app failed to read reports
 * a parsing failure as a business fact.
 */
export function hourlyEmptyMessage(r: HourlyEngagementReading): string {
  return r.unreadable
    ? "The hourly series answered in a shape this app can't read, so nothing is shown rather than a guess."
    : "No hourly engagement has been recorded for this campaign.";
}

/* ---------------------------------------------------------- locale report */

export interface LocaleStatRow {
  key: string;
  label: string;
  value: string;
  spoken: string;
  /** 0..1 share of the largest locale's SENT count, for the inline bar. */
  share: number;
}

/**
 * True when a non-null locale-report payload is not a shape this reader can
 * map — kept apart from "no locales recorded" so the card never reports drift
 * as an answer. (A predicate rather than a field on the row list: the rows are
 * consumed by the shared InsightRankedList, whose row contract is fixed.)
 */
export function localeReportUnreadable(raw: unknown): boolean {
  if (raw == null) return false;
  const row = record(raw);
  return row === null || !Array.isArray(row.locales);
}

/** The locale card's half of the same distinction. */
export function localeEmptyMessage(raw: unknown): string {
  return localeReportUnreadable(raw)
    ? "The per-locale report answered in a shape this app can't read, so nothing is shown rather than a guess."
    : "No per-locale stats have been recorded for this campaign.";
}

export function localeReportRows(raw: unknown, limit = 8): LocaleStatRow[] {
  const row = record(raw);
  const locales = row && Array.isArray(row.locales) ? row.locales : [];
  const parsed: {
    locale: string;
    sent: number;
    opens: number;
    clicks: number;
  }[] = [];
  for (const entry of locales) {
    const stat = record(entry);
    if (!stat) continue;
    const locale =
      typeof stat.locale === "string" && stat.locale.trim()
        ? stat.locale.trim()
        : "unknown";
    parsed.push({
      locale,
      sent: count(stat.sent),
      opens: count(stat.opens),
      clicks: count(stat.clicks),
    });
  }
  // The server already orders by sent DESC; re-sorting costs nothing and means
  // the truncated top-8 is the top 8 even if that ORDER BY ever changes.
  parsed.sort((a, b) => b.sent - a.sent || a.locale.localeCompare(b.locale));
  const maxSent = parsed.reduce((m, r) => Math.max(m, r.sent), 0);
  return parsed.slice(0, limit).map((r, i) => {
    const label = r.locale === "unknown" ? "No locale recorded" : r.locale;
    // Open rate per locale is the comparison the card exists for; it is only
    // a rate when there is a denominator.
    const rate = r.sent > 0 ? percent(r.opens / r.sent, { digits: 0 }) : null;
    return {
      key: `${r.locale}-${i}`,
      label,
      value: rate
        ? `${num(r.sent)} sent · ${rate} open rate`
        : `${num(r.sent)} sent`,
      spoken: `${label}: ${num(r.sent)} sent, ${num(r.opens)} opens, ${num(r.clicks)} clicks`,
      share: maxSent > 0 ? r.sent / maxSent : 0,
    };
  });
}
