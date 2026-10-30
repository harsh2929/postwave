/**
 * formMetrics — pure aggregation behind the mobile forms surface.
 *
 * Ported from apps/desktop/src/components/forms/form-metrics.ts so the
 * visit-weighted rule does NOT diverge between clients. Two ways a headline
 * conversion number lies, both of which the desktop already learned the hard
 * way and both of which are preserved here:
 *
 *  - Weighting each per-form rate by its own numerator (submissions)
 *    systematically inflates the aggregate. Never do that.
 *  - "Σ submissions ÷ Σ visits" silently drops every form that reports no
 *    visits, so it is only honest when most forms carry a denominator AND the
 *    two sources are comparable. Otherwise we fall back to a LABELLED
 *    unweighted mean rather than publishing an impossible number.
 *
 * No react-native import is reachable from here, so the node suite covers it.
 */

/** Visit-weighted mode needs visits on at least this share of forms. */
export const WEIGHTED_MIN_COVERAGE = 0.5;

export interface FormMetricRow {
  status?: string;
  submissions30d?: number;
  visits30d?: number;
  /** 0..100, server-computed per form. */
  conversionRate?: number;
}

export type AggregateConversion =
  | {
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
      mode: "unweighted";
      /** 0..100 */
      rate: number;
      total: number;
    }
  | { mode: "empty" };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computeAggregateConversion(
  rows: readonly FormMetricRow[],
): AggregateConversion {
  if (rows.length === 0) return { mode: "empty" };

  const withVisits = rows.filter((r) => finite(r.visits30d) !== null);
  const visits = withVisits.reduce((sum, r) => sum + (finite(r.visits30d) ?? 0), 0);
  const submissions = withVisits.reduce(
    (sum, r) => sum + (finite(r.submissions30d) ?? 0),
    0,
  );
  const enoughCoverage =
    withVisits.length / rows.length >= WEIGHTED_MIN_COVERAGE;
  // Hosted-page visits do not include every embed path. When submissions
  // exceed the reported visit denominator, the two sources are not comparable
  // and a weighted percentage would exceed 100%.
  const comparableSources = withVisits.every(
    (row) => (finite(row.submissions30d) ?? 0) <= (finite(row.visits30d) ?? 0),
  );

  if (enoughCoverage && comparableSources && visits > 0 && submissions <= visits) {
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
      (sum, r) => sum + Math.min(100, Math.max(0, finite(r.conversionRate) ?? 0)),
      0,
    ) / rows.length;
  return { mode: "unweighted", rate: mean, total: rows.length };
}

export interface FormsKpis {
  total: number;
  draft: number;
  published: number;
  archived: number;
  submissions30d: number;
  conversion: AggregateConversion;
}

/** The four headline KPIs, all derived from the list response alone. */
export function computeFormsKpis(rows: readonly FormMetricRow[]): FormsKpis {
  let draft = 0;
  let published = 0;
  let archived = 0;
  let submissions30d = 0;
  for (const row of rows) {
    const status = (row.status ?? "draft").trim().toLowerCase();
    if (status === "published") published += 1;
    else if (status === "archived") archived += 1;
    else draft += 1;
    submissions30d += finite(row.submissions30d) ?? 0;
  }
  return {
    total: rows.length,
    draft,
    published,
    archived,
    submissions30d,
    conversion: computeAggregateConversion(rows),
  };
}

/**
 * How the conversion KPI must be captioned. The mode is not an implementation
 * detail: "visit-weighted across 12 forms" and "unweighted mean" are different
 * claims and a reader is entitled to know which one they are looking at.
 */
export function conversionCaption(conv: AggregateConversion): string {
  if (conv.mode === "empty") return "No forms yet";
  if (conv.mode === "weighted") {
    return `Visit-weighted · ${conv.covered} of ${conv.total} forms report visits`;
  }
  return `Unweighted mean of ${conv.total} per-form rates`;
}

export interface FormVisitLike {
  date: string;
  count: number;
}

/**
 * Align `[{date, count}]` to an ordered list of YYYY-MM-DD buckets. The server
 * zero-fills, but alignment must not depend on it. Rows with a time component
 * are matched on the calendar-day prefix; malformed counts contribute 0.
 */
export function alignVisitCounts(
  visits: readonly FormVisitLike[] | undefined,
  isoDates: readonly string[],
): number[] {
  const byDay = new Map<string, number>();
  if (Array.isArray(visits)) {
    for (const v of visits) {
      if (!v || typeof v.date !== "string") continue;
      const day = v.date.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (finite(v.count) ?? 0));
    }
  }
  return isoDates.map((d) => byDay.get(d.slice(0, 10)) ?? 0);
}

/**
 * Window conversion as 0..100. Returns null when there are no visits — a
 * 0-visit "conversion" is undefined, not 0%, and rendering 0% would read as
 * "nobody converts" rather than "nobody visited".
 */
export function windowConversion(
  submissions: number,
  visits: number,
): number | null {
  if (!Number.isFinite(submissions) || !Number.isFinite(visits)) return null;
  if (visits <= 0) return null;
  if (submissions < 0 || submissions > visits) return null;
  return (submissions / visits) * 100;
}

/**
 * Structure elements that are NOT questions the visitor answers.
 *
 * `stepCount` on the wire is `len(steps)` — the number of multi-step PAGES,
 * not fields (apps/api/internal/forms/repo.go). Rendering it under a "Fields"
 * label told the operator a number about their form that was simply not the
 * number, and a single-step form (steps === []) reported "0 fields" while
 * happily collecting an email address. The field list lives in
 * `structure.fields`; headings, submit buttons and the honeypot are chrome.
 */
const NON_INPUT_FIELD_KINDS = new Set([
  "heading",
  "paragraph",
  "divider",
  "image",
  "html",
  "submit",
  "honeypot",
  "hidden",
]);

/**
 * Count the input fields declared by a form's structure, or null when the
 * payload carries no readable field list — in which case the caller must NOT
 * substitute another number and call it a field count.
 */
export function formFieldCount(structure: unknown): number | null {
  if (!structure || typeof structure !== "object") return null;
  const fields = (structure as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  let count = 0;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const raw = (field as { kind?: unknown }).kind;
    const kind = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!kind || NON_INPUT_FIELD_KINDS.has(kind)) continue;
    count += 1;
  }
  return count;
}

/**
 * Page count for a form. An empty `steps` list means single-step (the Go
 * comment on Form.Steps says so), so 0 is reported as the 1 page that exists.
 */
export function formStepCount(stepCount: unknown): number {
  const n = finite(stepCount) ?? 0;
  return n >= 1 ? Math.floor(n) : 1;
}

/** Ordered YYYY-MM-DD buckets ending today (UTC), oldest first. */
export function utcDayBuckets(days: number, now = Date.now()): string[] {
  const count = Math.min(90, Math.max(1, Math.floor(days)));
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
