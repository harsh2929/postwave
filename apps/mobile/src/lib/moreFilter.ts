/**
 * lib/moreFilter.ts — filtering the More menu's destination list.
 *
 * More is the app's REAL navigation surface: 24 of the 29 screens live behind
 * it, spread over six sections in manifest order. Favourites and Recents took
 * the top off that scroll for destinations you already know you want, but there
 * was still no way to answer "where is DMARC?" other than reading six section
 * lists — while the Search tab, one tap away, has had fuzzy ranking over the
 * same manifest all along.
 *
 * This module is the pure half of the filter so it can be unit-tested in the
 * node vitest environment (no react-native import, directly or transitively).
 * It reuses `rankFuzzy` from lib/paletteItems rather than inventing a second
 * matching rule: a query that ranks one way in the palette must rank the same
 * way here, or the two surfaces disagree about what "dmar" means.
 *
 * Deliberately NOT capped. The palette caps at 8 because it sits above a
 * keyboard on a screen whose whole job is "pick one thing fast"; More is a
 * scrolling menu, and hiding the 9th match behind no affordance at all would
 * be a worse failure than a long list.
 */
import { rankFuzzy } from "@/lib/paletteItems";

/** The shape every More row already has. */
export interface MoreFilterable {
  key: string;
  label: string;
  hint?: string | undefined;
}

/** Offsets keep a title hit ahead of an equally-good hint or key hit. */
const HINT_OFFSET = 50;
const KEY_OFFSET = 100;

function rankField(query: string, target: string | undefined, offset: number) {
  if (!target) return Number.POSITIVE_INFINITY;
  const score = rankFuzzy(query, target);
  return score < 0 ? Number.POSITIVE_INFINITY : score + offset;
}

/**
 * Best score for a row against a query; `Infinity` when it does not match.
 *
 * The route KEY is matched too (with its separators spaced out, so `audit
 * sinks` finds `audit-sinks`) because keys are what deep links, the desktop
 * URL bar and support conversations actually use.
 */
export function scoreMoreRow(row: MoreFilterable, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  return Math.min(
    rankField(q, row.label, 0),
    rankField(q, row.hint, HINT_OFFSET),
    rankField(q, row.key.replace(/[-_]/gu, " "), KEY_OFFSET),
  );
}

/**
 * Rank rows for a query, best first, dropping non-matches.
 *
 * An empty query returns the input UNCHANGED (same array identity is not
 * promised, but order and membership are), so the caller can render its normal
 * sectioned list without a special case.
 */
export function filterMoreRows<T extends MoreFilterable>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return [...rows];
  return rows
    .map((row, order) => ({ row, score: scoreMoreRow(row, q), order }))
    .filter((entry) => entry.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.row);
}

/**
 * Heading for the filtered section.
 *
 * Exact counts only — the list is at most ~30 rows, so there is never a reason
 * to compact, and "0 matches" is a real answer that must not be dressed up as
 * an empty section that reads like a loading state.
 */
export function moreFilterHeading(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}
