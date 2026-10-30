// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure filter/sort/paginate helpers for the segments list. Kept side-effect-
// free so the list table can search/sort/paginate client-side (the backend
// returns the whole set) and the logic is unit-tested in
// __tests__/segments-list-helpers.test.ts.

import type { Segment } from "@/lib/segments-api";

export const SEGMENT_SORT_KEYS = ["name", "count", "evaluated"] as const;
export type SegmentSortKey = (typeof SEGMENT_SORT_KEYS)[number];
export type SortOrder = "asc" | "desc";

/** Sentinel folder-filter values (SEG-038). */
export const FOLDER_ALL = "all";
export const FOLDER_UNFILED = "unfiled";

/**
 * Filter by folder (SEG-038). "all" is a pass-through; "unfiled" keeps only
 * segments with no folder; any other value keeps segments filed under that
 * exact folder id. A null/undefined folderId counts as unfiled.
 */
export function filterByFolder(segments: Segment[], folder: string): Segment[] {
  if (!folder || folder === FOLDER_ALL) return segments;
  if (folder === FOLDER_UNFILED) {
    return segments.filter((s) => !s.folderId);
  }
  return segments.filter((s) => s.folderId === folder);
}

/** Case-insensitive substring match over name + description. */
export function filterSegments(segments: Segment[], query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return segments;
  return segments.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q),
  );
}

function evaluatedMs(s: Segment): number | null {
  if (!s.lastEvaluatedAt) return null;
  const t = new Date(s.lastEvaluatedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Stable sort. Nullish counts / timestamps always sink to the bottom
 * regardless of direction so "never evaluated" rows don't masquerade as the
 * smallest/oldest.
 */
export function sortSegments(
  segments: Segment[],
  sort: SegmentSortKey,
  order: SortOrder,
): Segment[] {
  const dir = order === "asc" ? 1 : -1;
  const withIndex = segments.map((s, i) => ({ s, i }));
  withIndex.sort((a, b) => {
    let cmp = 0;
    if (sort === "name") {
      cmp = a.s.name.localeCompare(b.s.name, undefined, {
        sensitivity: "base",
      });
    } else if (sort === "count") {
      cmp = compareNullable(a.s.lastCount ?? null, b.s.lastCount ?? null, dir);
    } else {
      cmp = compareNullable(evaluatedMs(a.s), evaluatedMs(b.s), dir);
    }
    if (cmp !== 0) return cmp * (sort === "name" ? dir : 1);
    return a.i - b.i; // stable tiebreak
  });
  return withIndex.map((x) => x.s);
}

/**
 * Compare two nullable numbers so nulls always sort LAST (not as -Infinity).
 * Returns a value already oriented to `dir` for the non-null case.
 */
function compareNullable(
  a: number | null,
  b: number | null,
  dir: number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // a sinks
  if (b === null) return -1; // b sinks
  return (a - b) * dir;
}

/**
 * Stable partition that floats pinned segments to the top while preserving the
 * incoming (already-sorted) order within each partition (SEG-052).
 */
export function pinnedFirst(
  segments: Segment[],
  pinned: ReadonlySet<string>,
): Segment[] {
  if (pinned.size === 0) return segments;
  const top: Segment[] = [];
  const rest: Segment[] = [];
  for (const s of segments) (pinned.has(s.id) ? top : rest).push(s);
  return [...top, ...rest];
}

export function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

export function totalPages(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}
