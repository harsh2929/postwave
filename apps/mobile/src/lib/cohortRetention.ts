/**
 * lib/cohortRetention.ts — reading `GET /api/v1/analytics/cohorts`, and
 * turning a triangular heatmap into the one sentence it encodes.
 *
 * The desktop draws the grid: signup-month cohorts down the side, weeks since
 * signup across the top, an engagement rate in every cell. That is a desk
 * artifact — twelve rows of twelve colour-coded cells is unreadable at phone
 * width and worse than nothing, because a reader will squint at it and take
 * away an impression rather than a fact.
 *
 * What the grid is FOR, though, is a phone-sized statement: "people who joined
 * in June are engaging less by week four than May's did". So this module makes
 * exactly that comparison and refuses to make it when the data cannot support
 * one.
 *
 * THREE THINGS THE SERVER'S CONTRACT FORCES, each of which is easy to get
 * wrong and each of which would produce a confidently false headline:
 *
 *  1. AN IMMATURE WEEK IS ABSENT, NOT ZERO. `Weeks` is truncated to the
 *     cohort's MATURE week count (analytics/service.go: `make([]float64,
 *     c.matureWeeks)`). July's cohort is two weeks old, so its array has two
 *     entries — not twelve with ten zeros. Comparing June's week 4 against a
 *     week 4 July does not have would read "July collapsed to 0%" when the
 *     truth is "July has not got there yet".
 *  2. SO A COMPARISON MUST BE MADE AT A WEEK BOTH COHORTS HAVE. The deepest
 *     week index present in both is the only honest meeting point.
 *  3. A RATE OVER A TINY COHORT IS NOISE. Eleven subscribers make every rate a
 *     multiple of nine points, and a one-person swing looks like a trend.
 *
 * Pure and import-light on purpose: every rule above is testable without React
 * Native.
 */

export interface CohortRow {
  /** `2026-06`, as the server formats it. */
  label: string;
  size: number;
  /**
   * Engagement rate per week since signup, as a FRACTION (hits ÷ cohort size).
   * Length is the cohort's mature week count — never padded.
   */
  weeks: number[];
}

/**
 * Below this a rate is arithmetic on a handful of people. Chosen so a single
 * subscriber moves the rate by at most ~3 points.
 */
export const MIN_COMPARABLE_COHORT = 30;

function finiteRate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Rates are fractions by construction (hits / size). Clamp defensively: a
  // subscriber can generate several event types, and a >1 rate would render
  // as "140% retained".
  return Math.min(1, Math.max(0, value));
}

export function parseCohorts(raw: unknown): CohortRow[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  const out: CohortRow[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const label = typeof row.cohort_label === "string" ? row.cohort_label : "";
    if (!label) continue;
    const size =
      typeof row.cohort_size === "number" && Number.isFinite(row.cohort_size)
        ? Math.max(0, Math.trunc(row.cohort_size))
        : 0;
    const weeksRaw = Array.isArray(row.weeks) ? row.weeks : [];
    const weeks: number[] = [];
    for (const value of weeksRaw) {
      const rate = finiteRate(value);
      // A non-numeric cell truncates the run rather than being coerced: the
      // array's LENGTH is the maturity claim, so a filled-in placeholder
      // would assert a week that was not measured.
      if (rate === null) break;
      weeks.push(rate);
    }
    out.push({ label, size, weeks });
  }
  // Newest first is what the server returns; make it explicit rather than
  // depending on it, because the comparison below is positional.
  return out.sort((a, b) => b.label.localeCompare(a.label));
}

export interface CohortComparison {
  /** The newer of the two cohorts. */
  recent: CohortRow;
  /** The one before it. */
  prior: CohortRow;
  /** Zero-based week index both cohorts have reached. */
  weekIndex: number;
  recentRate: number;
  priorRate: number;
  /** Percentage POINTS, recent minus prior. Positive means improving. */
  deltaPoints: number;
  direction: "up" | "down" | "flat";
  /** One sentence, ready to render and to speak. */
  headline: string;
}

function monthName(label: string): string {
  // `2026-06` → `June 2026`. Built from a fixed table rather than Date parsing
  // because `new Date("2026-06")` is UTC-midnight and renders as May in any
  // timezone west of Greenwich — the exact off-by-one-month bug that makes a
  // cohort label untrustworthy.
  const match = /^(\d{4})-(\d{2})$/u.exec(label);
  if (!match) return label;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const index = Number(match[2]) - 1;
  const name = months[index];
  return name ? `${name} ${match[1]}` : label;
}

/**
 * The headline comparison, or null when the data cannot support one.
 *
 * Returns null — deliberately, rather than a hedged sentence — when there are
 * fewer than two cohorts, when either is too small to read, or when they have
 * no mature week in common. A card that renders nothing on a young workspace
 * is better than one that renders a number nobody should act on.
 */
export function cohortComparison(
  rows: readonly CohortRow[],
  minSize = MIN_COMPARABLE_COHORT,
): CohortComparison | null {
  const usable = rows.filter(
    (row) => row.size >= minSize && row.weeks.length > 0,
  );
  const recent = usable[0];
  const prior = usable[1];
  if (!recent || !prior) return null;

  // The deepest week BOTH have reached. See rule 2 in the header.
  const weekIndex = Math.min(recent.weeks.length, prior.weeks.length) - 1;
  if (weekIndex < 0) return null;

  const recentRate = recent.weeks[weekIndex] ?? 0;
  const priorRate = prior.weeks[weekIndex] ?? 0;
  const deltaPoints = (recentRate - priorRate) * 100;
  // Under half a point is rounding, not movement: both rates print to one
  // decimal, so anything smaller would show as a change nobody can see.
  const direction =
    Math.abs(deltaPoints) < 0.5 ? "flat" : deltaPoints > 0 ? "up" : "down";

  const week = `week ${weekIndex + 1}`;
  const recentName = monthName(recent.label);
  const priorName = monthName(prior.label);
  const headline =
    direction === "flat"
      ? `${recentName} signups are engaging at the same rate as ${priorName}'s by ${week}.`
      : `${recentName} signups are engaging ${Math.abs(deltaPoints).toFixed(1)} points ${
          direction === "up" ? "more" : "less"
        } than ${priorName}'s by ${week}.`;

  return {
    recent,
    prior,
    weekIndex,
    recentRate,
    priorRate,
    deltaPoints,
    direction,
    headline,
  };
}

/**
 * The bars beside the headline: every cohort's rate at the SAME week index, so
 * the lengths are comparable. Cohorts that have not reached that week are
 * omitted rather than drawn at zero.
 */
export function cohortBarsAt(
  rows: readonly CohortRow[],
  weekIndex: number,
): { id: string; label: string; value: number; hint: string }[] {
  return rows
    .filter((row) => row.weeks.length > weekIndex && row.size > 0)
    .map((row) => ({
      id: row.label,
      label: monthName(row.label),
      // Percentage points, so the bar labels read as rates rather than as
      // fractions of one.
      value: Number((((row.weeks[weekIndex] ?? 0) * 100)).toFixed(1)),
      hint: `${row.size} joined`,
    }));
}

export { monthName as cohortMonthName };
