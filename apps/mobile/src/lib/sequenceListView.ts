/**
 * sequenceListView — the pure derivation behind the sequences index.
 *
 * Three problems this module exists to solve, all of them in one screen:
 *
 *  1. The list endpoint (`GET /api/v1/voice/sequences`) takes no page/size
 *     params and applies no limit — it returns EVERY row for the tenant. The
 *     desktop defends itself with an explicit SEQUENCE_LIBRARY_ROW_LIMIT of
 *     500; the phone, with the least memory and the slowest JS thread, had no
 *     ceiling at all and re-derived three full passes over the array on every
 *     render.
 *  2. Three status chips are not a way to find one sequence in three hundred.
 *  3. Filter/search/sort logic inside a .tsx cannot be unit tested.
 *
 * Kept free of ALL runtime imports (react-native is reachable from the api
 * modules via the SDK transport) so the node-environment suite can cover the
 * edge cases directly. Rows are accepted structurally.
 */

/** Mirrors apps/desktop/src/pages/Sequences.tsx:66 so both clients agree. */
export const SEQUENCE_LIBRARY_ROW_LIMIT = 500;

/** The slice of a sequence list row this module reads. */
export interface SequenceRowLike {
  id?: string;
  name?: string;
  status?: string;
  updated_at?: string;
  steps?: number | readonly unknown[];
  emails?: readonly unknown[];
}

/** Matches the canvas codec's ceiling; a hostile payload must not spin the JS
 *  thread while a list of several hundred rows is being derived. */
const ROW_BRANCH_DEPTH_LIMIT = 8;

/**
 * Count wire steps INCLUDING both arms of every condition.
 *
 * `GET /api/v1/voice/sequences` returns whole `generation.Sequence` rows, so
 * `steps` is the nested step ARRAY — never a precomputed number. `.length`
 * therefore counted only the top level, and a journey whose whole body lives
 * inside one condition rendered as "1 step" in the list while the detail
 * header (which recurses) said 13. Two screens disagreeing about the size of
 * the same object is worse than either number alone.
 *
 * Accepts both the nested v0.3 shape (`step.condition.yes_branch`) and the
 * legacy flat one (`step.yes_branch`), structurally — this module deliberately
 * imports nothing.
 */
function countWireSteps(steps: unknown, depth = 0): number {
  if (!Array.isArray(steps) || depth > ROW_BRANCH_DEPTH_LIMIT) return 0;
  let total = 0;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    total += 1;
    const node = step as {
      condition?: { yes_branch?: unknown; no_branch?: unknown } | null;
      yes_branch?: unknown;
      no_branch?: unknown;
    };
    total += countWireSteps(
      node.condition?.yes_branch ?? node.yes_branch,
      depth + 1,
    );
    total += countWireSteps(
      node.condition?.no_branch ?? node.no_branch,
      depth + 1,
    );
  }
  return total;
}

/**
 * Row step count.
 *
 * A numeric `steps` (should a gateway ever project one) is taken as the
 * authoritative total; otherwise the nested array is counted in full.
 */
export function sequenceRowStepCount(item: SequenceRowLike): number {
  if (typeof item.steps === "number" && Number.isFinite(item.steps)) {
    return Math.max(0, item.steps);
  }
  if (Array.isArray(item.steps)) return countWireSteps(item.steps);
  return Array.isArray(item.emails) ? item.emails.length : 0;
}

export type SequenceFilter = "all" | "drafts" | "read_only";
export type SequenceSort = "updated" | "name" | "steps";

/** A type alias (not an interface) so it satisfies the
 *  `Record<string, string>` constraint on useListPreferences. */
export type SequenceListPrefs = {
  filter: SequenceFilter;
  sort: SequenceSort;
};

export const DEFAULT_SEQUENCE_LIST_PREFS: SequenceListPrefs = {
  filter: "all",
  sort: "updated",
};

/** Only confirmed drafts belong on an authoring surface. Every historical or
 *  unknown status is shown as read-only while the runtime is unavailable. */
export function isDraftSequence(s: SequenceRowLike): boolean {
  return (s.status ?? "").trim().toLowerCase() === "draft";
}

/**
 * Fold case AND diacritics so "Café" matches "cafe".
 * `normalize("NFD")` splits accented characters into base + combining mark;
 * stripping the marks then leaves a comparable ASCII-ish form. Guarded because
 * Hermes has historically shipped without full `String.prototype.normalize`.
 */
export function foldForSearch(value: string): string {
  const lower = value.toLowerCase();
  if (typeof lower.normalize !== "function") return lower;
  try {
    return lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
  } catch {
    return lower;
  }
}

function updatedAtMs(s: SequenceRowLike): number {
  const ms = Date.parse(s.updated_at ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

export interface SequenceListView<T extends SequenceRowLike = SequenceRowLike> {
  /** Every normalized row, before filter/search/sort. */
  total: number;
  draftCount: number;
  readOnlyCount: number;
  /** Rows matching the current filter + query, sorted, then capped. */
  rows: T[];
  /** Rows that matched before the ceiling was applied. */
  matched: number;
  /** True when the ceiling hid rows the user asked for. */
  truncated: boolean;
}

/**
 * Derive everything the list screen renders in ONE pass-set, so the screen can
 * memoise a single call instead of recomputing three filters per render.
 */
export function deriveSequenceListView<T extends SequenceRowLike>(
  items: readonly T[],
  { filter, sort }: SequenceListPrefs,
  query: string,
  limit: number = SEQUENCE_LIBRARY_ROW_LIMIT,
): SequenceListView<T> {
  let draftCount = 0;
  const filtered: T[] = [];
  const needle = foldForSearch(query.trim());

  for (const item of items) {
    const draft = isDraftSequence(item);
    if (draft) draftCount += 1;
    if (filter === "drafts" && !draft) continue;
    if (filter === "read_only" && draft) continue;
    if (needle) {
      const haystack = foldForSearch(`${item.name ?? ""} ${item.status ?? ""}`);
      if (!haystack.includes(needle)) continue;
    }
    filtered.push(item);
  }

  filtered.sort((a, b) => {
    if (sort === "name") {
      return (a.name ?? "").localeCompare(b.name ?? "", undefined, {
        sensitivity: "base",
      });
    }
    if (sort === "steps") {
      return sequenceRowStepCount(b) - sequenceRowStepCount(a);
    }
    return updatedAtMs(b) - updatedAtMs(a);
  });

  const ceiling = Math.max(0, limit);
  return {
    total: items.length,
    draftCount,
    readOnlyCount: items.length - draftCount,
    rows: filtered.length > ceiling ? filtered.slice(0, ceiling) : filtered,
    matched: filtered.length,
    truncated: filtered.length > ceiling,
  };
}

/** Copy for the "we did not show you everything" footer. Never silent. */
export function truncationNotice(view: SequenceListView): string | null {
  if (!view.truncated) return null;
  return `Showing the first ${view.rows.length} of ${view.matched} matches — narrow with search.`;
}
