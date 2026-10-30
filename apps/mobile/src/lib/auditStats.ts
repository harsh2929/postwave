/**
 * lib/auditStats.ts — "is activity normal today?", answered before the log is.
 *
 * A phone glance at governance should answer whether anything is UNUSUAL before
 * it answers what the last hundred events were, and GET /api/v1/audit/stats
 * already computes exactly that: a total, an actor mix, the top actions and a
 * per-day bucket series. Mobile discarded all four and rendered only the feed.
 *
 * The one judgement this module makes — and the reason it is a module rather
 * than three lines in a component — is the BASELINE. "412 events today" means
 * nothing on its own. Compared against the MEDIAN of the preceding complete
 * days it becomes "roughly normal" or "3.4x the usual", which is the sentence
 * an on-call reader actually needs.
 *
 * Median, not mean: a single incident day in the window would drag a mean up
 * far enough to make the incident itself look normal, which is precisely
 * backwards for an anomaly signal.
 *
 * Import-free apart from lib/format, so every threshold below is asserted in
 * the node test environment.
 */
import { num, plural } from "./format";

/** Mirrors handlers.AuditCount (Go). */
export interface AuditCount {
  label: string;
  count: number;
}

/** Mirrors handlers.AuditDailyBucket (Go). `date` is a YYYY-MM-DD string. */
export interface AuditDailyBucket {
  date: string;
  count: number;
}

/** Mirrors handlers.AuditStatsResponse (Go). */
export interface AuditStats {
  totalEvents: number;
  byActorType: AuditCount[];
  topActions: AuditCount[];
  daily: AuditDailyBucket[];
}

/**
 * How far above the baseline counts as elevated.
 *
 * Deliberately generous. An audit log is bursty by nature — one bulk import or
 * one admin doing housekeeping doubles a quiet day — so a 1.5x trigger would
 * cry wolf until the banner is ignored, which is worse than no banner.
 */
export const AUDIT_ELEVATED_RATIO = 2.5;

/** Fewest complete prior days needed before a baseline is meaningful at all. */
export const AUDIT_BASELINE_MIN_DAYS = 3;

export type AuditActivityLevel = "quiet" | "normal" | "elevated" | "unknown";

export interface AuditActivitySummary {
  /** Events in the newest bucket. Null when the series is empty. */
  today: number | null;
  /** Median of the preceding COMPLETE days, or null when too few exist. */
  baseline: number | null;
  level: AuditActivityLevel;
  /** The visible sentence. */
  headline: string;
  /** The supporting sentence. Never empty. */
  detail: string;
  /** One spoken string; the sparkline itself is decorative to VoiceOver. */
  spoken: string;
  /** Oldest-first counts for the sparkline. */
  series: number[];
}

/**
 * Normalise the stats payload. Anything drifted degrades to zeroed, empty
 * collections rather than throwing: a compliance screen must not white-screen
 * because an enrichment endpoint changed shape.
 */
export function normalizeAuditStats(res: unknown): AuditStats | null {
  if (!res || typeof res !== "object") return null;
  const raw = res as Partial<AuditStats>;
  const total = Number(raw.totalEvents);
  return {
    totalEvents: Number.isFinite(total) && total >= 0 ? total : 0,
    byActorType: counts(raw.byActorType),
    topActions: counts(raw.topActions),
    daily: Array.isArray(raw.daily)
      ? raw.daily
          .filter(
            (row): row is AuditDailyBucket =>
              Boolean(row) &&
              typeof row === "object" &&
              typeof (row as AuditDailyBucket).date === "string",
          )
          .map((row) => ({
            date: row.date,
            count: Number.isFinite(Number(row.count)) ? Number(row.count) : 0,
          }))
      : [],
  };
}

function counts(value: unknown): AuditCount[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row): row is AuditCount =>
        Boolean(row) && typeof row === "object" && typeof (row as AuditCount).label === "string",
    )
    .map((row) => ({
      label: row.label,
      count: Number.isFinite(Number(row.count)) ? Number(row.count) : 0,
    }));
}

/** Median of a numeric list. Empty input is null, not 0. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The glance. `windowDescription` comes from lib/auditGrouping so the sentence
 * names the same window the filter bar does.
 *
 * The server orders `daily` oldest-first; the NEWEST bucket is the partial
 * current day and is deliberately excluded from the baseline it is compared
 * against — comparing today against itself makes every day look normal.
 */
export function auditActivitySummary(
  stats: AuditStats | null | undefined,
  windowDescription: string,
): AuditActivitySummary {
  const daily = stats?.daily ?? [];
  const series = daily.map((bucket) => bucket.count);
  const today = series.length > 0 ? (series[series.length - 1] as number) : null;
  const prior = series.slice(0, -1);
  const baseline = prior.length >= AUDIT_BASELINE_MIN_DAYS ? median(prior) : null;

  if (!stats || today === null) {
    return {
      today: null,
      baseline: null,
      level: "unknown",
      headline: "Activity unavailable",
      detail: `The per-day breakdown for ${windowDescription} hasn't loaded.`,
      spoken: `Activity unavailable. The per-day breakdown for ${windowDescription} hasn't loaded.`,
      series: [],
    };
  }

  const total = `${num(stats.totalEvents)} ${
    stats.totalEvents === 1 ? "event" : "events"
  } in ${windowDescription}`;

  let level: AuditActivityLevel = "unknown";
  let detail: string;
  if (baseline === null) {
    detail = `${total}. Not enough history yet to say whether today is unusual.`;
  } else if (baseline === 0) {
    // A zero baseline makes every ratio infinite, so it is a separate answer.
    level = today > 0 ? "elevated" : "quiet";
    detail =
      today > 0
        ? `${total}. The preceding days recorded nothing at all.`
        : `${total}. Nothing recorded today or on the preceding days.`;
  } else {
    const ratio = today / baseline;
    level = ratio >= AUDIT_ELEVATED_RATIO ? "elevated" : ratio <= 0.5 ? "quiet" : "normal";
    const rounded = Math.round(ratio * 10) / 10;
    detail =
      level === "elevated"
        ? `${total}. Today is ${rounded}× the usual ${plural(
            Math.round(baseline),
            "event",
          )} a day.`
        : level === "quiet"
          ? `${total}. Today is quieter than the usual ${plural(
              Math.round(baseline),
              "event",
            )} a day.`
          : `${total}. In line with the usual ${plural(
              Math.round(baseline),
              "event",
            )} a day.`;
  }

  const headline =
    level === "elevated"
      ? `Elevated · ${plural(today, "event")} today`
      : level === "quiet"
        ? `Quiet · ${plural(today, "event")} today`
        : level === "normal"
          ? `Normal · ${plural(today, "event")} today`
          : `${plural(today, "event")} today`;

  return {
    today,
    baseline,
    level,
    headline,
    detail,
    spoken: `${headline}. ${detail}`,
    series,
  };
}

/** Pill tone for the level. Always paired with the word, never colour alone. */
export function auditActivityTone(
  level: AuditActivityLevel,
): "warning" | "info" | "neutral" {
  if (level === "elevated") return "warning";
  if (level === "quiet") return "info";
  return "neutral";
}
