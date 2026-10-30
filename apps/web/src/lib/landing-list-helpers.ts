// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, dependency-free helpers for the Landing Pages list surface: text/status
// filtering, sortable-column config, sort toggling, and per-page metric
// derivation. Kept out of the page component so the ordering/format/metric
// logic is unit-tested synchronously (LAND-006, LAND-023). Generic count/
// pagination helpers are reused from `forms-list-helpers` rather than forked.

import type { LandingPage, LandingPageStatus } from "./landing-pages-api";

export { formatCount, paginate, totalPages } from "./forms-list-helpers";

export const LANDING_STATUS_FILTERS = [
  "all",
  "draft",
  "published",
  "archived",
] as const;
export type LandingStatusFilter = (typeof LANDING_STATUS_FILTERS)[number];

export const LANDING_SORT_KEYS = [
  "name",
  "views",
  "conversions",
  "conversionRate",
  "status",
  "updatedAt",
  "createdAt",
] as const;
export type LandingSortKey = (typeof LANDING_SORT_KEYS)[number];

export type SortOrder = "asc" | "desc";

/** Columns whose natural default direction is descending (numbers, recency). */
const NUMERIC_SORT_KEYS = new Set<LandingSortKey>([
  "views",
  "conversions",
  "conversionRate",
  "updatedAt",
  "createdAt",
]);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface LandingMetrics {
  /** Recorded page views, or null when the backend has not surfaced a count. */
  views: number | null;
  /** Recorded conversions (signups), or null when unknown. */
  conversions: number | null;
  /** Conversion rate as a whole-number percentage (0–100), or null when it
   *  cannot be computed (views unknown). Zero views yields 0. */
  conversionRate: number | null;
}

function numeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Derive per-page views/conversions/conversion-rate from the row's `metrics`
 * JSON. The metrics shape is tolerant of aliases so the UI reconciles with
 * whatever the backend aggregation writes; when a count is absent the field is
 * null so the UI can render an honest "—" rather than a misleading 0.
 */
export function landingMetrics(page: Pick<LandingPage, "metrics">): LandingMetrics {
  const m = page.metrics ?? {};
  const views = numeric(m, ["views", "view", "total_views", "visits"]);
  const conversions = numeric(m, [
    "conversions",
    "conversion",
    "total_conversions",
    "signups",
  ]);
  let conversionRate: number | null = null;
  // Prefer an explicit rate if the backend supplies one (already a percentage).
  const explicit = numeric(m, ["conversion_rate", "conversionRate"]);
  if (explicit !== null) {
    conversionRate = Math.round(explicit <= 1 ? explicit * 100 : explicit);
  } else if (views !== null && conversions !== null) {
    conversionRate = views > 0 ? Math.round((conversions / views) * 100) : 0;
  }
  return { views, conversions, conversionRate };
}

// ---------------------------------------------------------------------------
// Filter / sort
// ---------------------------------------------------------------------------

/** Filter by free-text (name or slug, case-insensitive) and status. */
export function filterLandingPages(
  pages: readonly LandingPage[],
  opts: { q?: string; status?: LandingStatusFilter },
): LandingPage[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const status = opts.status ?? "all";
  return pages.filter((p) => {
    if (status !== "all" && p.status !== (status as LandingPageStatus))
      return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)
    );
  });
}

/** Stable sort by a column + direction. Never mutates the input. */
export function sortLandingPages(
  pages: readonly LandingPage[],
  sort: LandingSortKey,
  order: SortOrder,
): LandingPage[] {
  const dir = order === "asc" ? 1 : -1;
  return [...pages].sort((a, b) => {
    const cmp = compareByKey(a, b, sort);
    // Tie-break on name so equal values keep a deterministic order.
    return cmp !== 0 ? cmp * dir : a.name.localeCompare(b.name);
  });
}

function compareByKey(a: LandingPage, b: LandingPage, key: LandingSortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "status":
      return a.status.localeCompare(b.status);
    case "updatedAt":
      return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    case "createdAt":
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    case "views":
      return (landingMetrics(a).views ?? 0) - (landingMetrics(b).views ?? 0);
    case "conversions":
      return (
        (landingMetrics(a).conversions ?? 0) -
        (landingMetrics(b).conversions ?? 0)
      );
    case "conversionRate":
      return (
        (landingMetrics(a).conversionRate ?? 0) -
        (landingMetrics(b).conversionRate ?? 0)
      );
  }
}

/**
 * Compute the next {sort, order} when a header is clicked: a new column resets
 * to that column's natural default direction; re-clicking flips direction.
 */
export function nextSort(
  current: { sort: LandingSortKey; order: SortOrder },
  key: LandingSortKey,
): { sort: LandingSortKey; order: SortOrder } {
  if (current.sort === key) {
    return { sort: key, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { sort: key, order: NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc" };
}

/** Human-readable label for a machine status. */
export function statusLabel(status: LandingPageStatus): string {
  switch (status) {
    case "published":
      return "Published";
    case "archived":
      return "Archived";
    default:
      return "Draft";
  }
}
