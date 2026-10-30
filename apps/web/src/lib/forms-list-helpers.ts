// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, dependency-free helpers for the Forms list surface: text/status
// filtering, sortable-column config, sort toggling, and count formatting.
// Kept out of the page component so the ordering/format logic is unit-tested
// synchronously (FORM-006, FORM-024, FORM-039).

import type { FormListItem, FormStatus } from "./forms-types";

export const FORM_STATUS_FILTERS = [
  "all",
  "draft",
  "published",
  "archived",
] as const;
export type FormStatusFilter = (typeof FORM_STATUS_FILTERS)[number];

export const FORM_SORT_KEYS = [
  "name",
  "submissions30d",
  "visits30d",
  "conversionRate",
  "status",
  "updatedAt",
] as const;
export type FormSortKey = (typeof FORM_SORT_KEYS)[number];

export type SortOrder = "asc" | "desc";

/** Sortable columns whose natural default direction is descending (numbers,
 *  recency) vs. ascending (text). */
const NUMERIC_SORT_KEYS = new Set<FormSortKey>([
  "submissions30d",
  "visits30d",
  "conversionRate",
  "updatedAt",
]);

/** Format an integer count with locale thousands separators (FORM-039). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString() : "0";
}

/** Filter by free-text (name or slug, case-insensitive) and status. */
export function filterForms(
  forms: readonly FormListItem[],
  opts: { q?: string; status?: FormStatusFilter },
): FormListItem[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const status = opts.status ?? "all";
  return forms.filter((f) => {
    if (status !== "all" && f.status !== (status as FormStatus)) return false;
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)
    );
  });
}

/** Stable sort of forms by a column + direction. Never mutates the input. */
export function sortForms(
  forms: readonly FormListItem[],
  sort: FormSortKey,
  order: SortOrder,
): FormListItem[] {
  const dir = order === "asc" ? 1 : -1;
  return [...forms].sort((a, b) => {
    const cmp = compareByKey(a, b, sort);
    // Tie-break on name so equal values keep a deterministic order.
    return cmp !== 0 ? cmp * dir : a.name.localeCompare(b.name);
  });
}

function compareByKey(
  a: FormListItem,
  b: FormListItem,
  key: FormSortKey,
): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "status":
      return a.status.localeCompare(b.status);
    case "updatedAt":
      return (
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
      );
    case "submissions30d":
      return a.submissions30d - b.submissions30d;
    case "visits30d":
      return a.visits30d - b.visits30d;
    case "conversionRate":
      return a.conversionRate - b.conversionRate;
  }
}

/**
 * Compute the next {sort, order} when a header is clicked: selecting a new
 * column resets to that column's natural default direction; re-clicking the
 * active column flips direction.
 */
export function nextSort(
  current: { sort: FormSortKey; order: SortOrder },
  key: FormSortKey,
): { sort: FormSortKey; order: SortOrder } {
  if (current.sort === key) {
    return { sort: key, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { sort: key, order: NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc" };
}

/** Slice `items` to one page (1-indexed). */
export function paginate<T>(
  items: readonly T[],
  page: number,
  perPage: number,
): T[] {
  const start = Math.max(0, (page - 1) * perPage);
  return items.slice(start, start + perPage);
}

export function totalPages(count: number, perPage: number): number {
  return Math.max(1, Math.ceil(count / perPage));
}
