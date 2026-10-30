/**
 * engagement-score-helpers — pure logic for the Subscribers page
 * engagement-score section (R2: subscriberscore HTTP surface).
 *
 * The wire gives us:
 *   - distribution() → {buckets: [{range, min, max, count}]} — NTILE(10)
 *     deciles over scored subscribers only (unscored rows are excluded
 *     server-side, and tenants with < 10 scored rows get fewer buckets).
 *   - subscribers({min,max,page,perPage}) → {items, total, page, per_page}.
 *
 * SEGMENT-CREATION DECISION (honest-UI): a score range can NOT be
 * turned into a real saved segment. The segment compiler
 * (apps/api/internal/segments/compile.go → compileField) has no
 * `engagement_score` field — unknown fields silently fall back to
 * `subscribers.custom_fields->>'engagement_score'`, a text comparison
 * against a custom field that does not exist. A "Create segment from
 * range" button would therefore save a segment that always evaluates
 * to zero members while claiming to capture the range. We offer the
 * browse table only and say so in the UI (see SCORE_SEGMENT_NOTE).
 */

import type { EngagementScoreBucket } from "../../lib/api-client";

/** Rendered under the browse table so the missing affordance is
 * explained instead of silently absent. */
export const SCORE_SEGMENT_NOTE =
  "Score ranges can't be saved as segments yet — the segment engine " +
  "has no engagement-score field, so a saved segment would silently " +
  "match nothing. Browse and act on the list directly.";

export interface DistributionSlice {
  /** Server-provided label, e.g. "12–34". */
  range: string;
  min: number;
  max: number;
  count: number;
  /** Share of all scored subscribers, 0..1 (0 when the total is 0). */
  share: number;
}

export interface DistributionView {
  slices: DistributionSlice[];
  /** Total scored subscribers across all buckets. */
  total: number;
}

/**
 * Normalise the decile buckets into renderable slices. Buckets arrive
 * ordered by decile (ascending score); we keep that order so the strip
 * reads low → high left to right. Buckets with a non-finite or
 * negative count are dropped (defensive — never observed on the wire).
 */
export function buildDistributionView(
  buckets: EngagementScoreBucket[],
): DistributionView {
  const clean = buckets.filter(
    (b) => Number.isFinite(b.count) && b.count > 0,
  );
  const total = clean.reduce((acc, b) => acc + b.count, 0);
  return {
    slices: clean.map((b) => ({
      range: b.range,
      min: b.min,
      max: b.max,
      count: b.count,
      share: total > 0 ? b.count / total : 0,
    })),
    total,
  };
}

export type ScoreRangeParse =
  | { ok: true; min?: number; max?: number }
  | { ok: false; error: string };

/**
 * Parse the browse-range inputs. Either bound may be blank
 * (unbounded — mirrors the server's nullable min/max). Mirrors the
 * server's 400 vocabulary: bad_min / bad_max / bad_range.
 */
export function parseScoreRange(
  minRaw: string,
  maxRaw: string,
): ScoreRangeParse {
  const parse = (raw: string, label: string): number | undefined | string => {
    const t = raw.trim();
    if (!t) return undefined;
    // Integers only — the column is an int and the server rejects
    // anything else with bad_min/bad_max.
    if (!/^-?\d+$/.test(t)) return `${label} must be a whole number.`;
    return Number(t);
  };
  const min = parse(minRaw, "Min");
  if (typeof min === "string") return { ok: false, error: min };
  const max = parse(maxRaw, "Max");
  if (typeof max === "string") return { ok: false, error: max };
  if (min !== undefined && max !== undefined && min > max) {
    return { ok: false, error: "Min must be ≤ max." };
  }
  const out: { ok: true; min?: number; max?: number } = { ok: true };
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return out;
}

/** Honest paging caption for the browse table. */
export function browseCaption(
  total: number,
  page: number,
  perPage: number,
  shown: number,
): string {
  if (total === 0) return "No scored subscribers in this range.";
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return `Page ${page} of ${totalPages} · ${shown.toLocaleString()} shown of ${total.toLocaleString()} in range`;
}

export interface ScoreDisplay {
  scored: boolean;
  /** Headline value, e.g. "62" or "Not scored yet". */
  label: string;
  /** Secondary line; null when there's nothing truthful to add. */
  detail: string | null;
}

/**
 * Copy for the per-subscriber score read-out (slideover). `score:null`
 * means the 15-minute scoring worker has never touched this row —
 * that's a data state, not an error, and the copy says so. The score
 * is an open-ended integer (event weights × rules), NOT a 0–100 or
 * 0–1 scale, so we render it bare instead of inventing a denominator.
 */
export function engagementScoreDisplay(
  score: number | null,
  computedAt?: string,
): ScoreDisplay {
  if (score == null) {
    return {
      scored: false,
      label: "Not scored yet",
      detail:
        "The scoring worker hasn't computed a score for this subscriber — it sweeps every 15 minutes over the last 90 days of events.",
    };
  }
  return {
    scored: true,
    label: score.toLocaleString(),
    detail: computedAt ? `computed ${computedAt}` : null,
  };
}
