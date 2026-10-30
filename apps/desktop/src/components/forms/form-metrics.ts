/**
 * form-metrics — pure aggregation logic behind FormsStatStrip and
 * SubmissionsAnalytics. Lives in a .ts module (not the .tsx
 * components) so the node-environment vitest suite can import it
 * without a JSX transform (same pattern as suppressions/trend-series).
 */

import type { FormSummary, FormVisitPoint } from "../../lib/api-client";

/* ---------- aggregate conversion (FormsStatStrip) -------------------- */

/**
 * Visit-weighted mode needs visits on at least this share of forms —
 * below that, "sum submissions / sum visits" silently drops most of
 * the tenant's forms and the headline would lie about coverage.
 */
const WEIGHTED_MIN_COVERAGE = 0.5;

export type AggregateConversion =
  | {
      /** True visit-weighted aggregate: Σ submissions ÷ Σ visits over
       *  the forms that report visits30d. */
      mode: "weighted";
      /** 0..100 */
      rate: number;
      submissions: number;
      visits: number;
      /** Forms included in the weighted sums. */
      covered: number;
      total: number;
    }
  | {
      /** Fallback: unweighted per-form mean of conversionRate. */
      mode: "unweighted";
      /** 0..100 */
      rate: number;
      total: number;
    }
  | { mode: "empty" };

/**
 * Compute the strip's aggregate conversion KPI.
 *
 * Weighted mode requires (a) visits30d present on at least half the
 * forms and (b) a non-zero visit total — otherwise we fall back to the
 * labeled unweighted per-form mean (the pre-visits behaviour). The
 * old "weight by submissions" approach weighted each rate by its own
 * numerator and systematically inflated the KPI; never do that.
 */
export function computeAggregateConversion(
  rows: FormSummary[],
): AggregateConversion {
  if (rows.length === 0) return { mode: "empty" };

  const withVisits = rows.filter((r) => typeof r.visits30d === "number");
  const visits = withVisits.reduce((sum, r) => sum + (r.visits30d ?? 0), 0);
  const submissions = withVisits.reduce(
    (sum, r) => sum + (r.submissions30d ?? 0),
    0,
  );
  const enoughCoverage =
    withVisits.length / rows.length >= WEIGHTED_MIN_COVERAGE;
  const comparableSources = withVisits.every(
    (row) => (row.submissions30d ?? 0) <= (row.visits30d ?? 0),
  );

  // Hosted-page visits do not include every embed path. When submissions
  // exceed the reported visit denominator, the two sources are not
  // comparable and a weighted percentage would exceed 100%. Fall back to
  // the API's bounded per-form rates rather than display an impossible KPI.
  if (
    enoughCoverage &&
    comparableSources &&
    visits > 0 &&
    submissions <= visits
  ) {
    return {
      mode: "weighted",
      rate: (submissions / visits) * 100,
      submissions,
      visits,
      covered: withVisits.length,
      total: rows.length,
    };
  }

  const mean =
    rows.reduce(
      (sum, r) => sum + Math.min(100, Math.max(0, r.conversionRate ?? 0)),
      0,
    ) / rows.length;
  return { mode: "unweighted", rate: mean, total: rows.length };
}

/* ---------- visit series alignment (SubmissionsAnalytics) ------------ */

/**
 * Align the visits endpoint's `[{date, count}]` rows to an ordered list
 * of bucket dates (YYYY-MM-DD UTC). Missing days become 0 — the server
 * zero-fills, but alignment must not depend on it. Date strings with a
 * time component are matched on their calendar-day prefix.
 */
export function alignVisitCounts(
  visits: FormVisitPoint[],
  isoDates: string[],
): number[] {
  const byDay = new Map<string, number>();
  for (const v of visits) {
    const day = v.date.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + v.count);
  }
  return isoDates.map((d) => byDay.get(d.slice(0, 10)) ?? 0);
}

/**
 * Window conversion: submissions in the window ÷ visits in the window,
 * as a 0..100 percentage. Returns null when there are no visits — a
 * 0-visit "conversion" is undefined, not 0%, and rendering 0% would
 * read as "nobody converts" rather than "nobody visited".
 */
export function windowConversion(
  submissions: number,
  visits: number,
): number | null {
  if (visits <= 0) return null;
  if (submissions < 0 || submissions > visits) return null;
  return (submissions / visits) * 100;
}
