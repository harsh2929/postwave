/**
 * suppressionWindowScope — the footer's scope sentence once the TIME WINDOW
 * can narrow the list too.
 *
 * `suppressionPageScopeNote` (lib/suppressionSearch.ts) predates the window
 * chips and names exactly one client-side narrowing: "The reason filter
 * narrows only what's loaded…". With the window chips in place, an operator
 * who picked "24 hours" and left the reason on "All" read a sentence blaming
 * a filter they had not touched — and went looking for it. This keeps the
 * base sentence (one author for the numbers, the load-more pointer and the
 * search fallback) and swaps in the honest subject only when the window is
 * part of why the count is smaller than the total.
 *
 * Node-testable: no react-native import.
 */
import { suppressionPageScopeNote } from "@/lib/suppressionSearch";

const REASON_SUBJECT = "The reason filter narrows";

export function suppressionScopeNoteWithWindow(input: {
  shown: number;
  total: number | null | undefined;
  /** The reason chip, or a sub-3-character query the server never filtered. */
  reasonFiltered: boolean;
  /** A time-window chip other than "Any time". */
  windowFiltered: boolean;
  /** True when a "Load more" control is on screen and would fetch more. */
  canLoadMore: boolean;
}): string {
  const base = suppressionPageScopeNote({
    shown: input.shown,
    total: input.total,
    clientFiltered: input.reasonFiltered || input.windowFiltered,
    canLoadMore: input.canLoadMore,
  });
  if (!input.windowFiltered || !base.includes(REASON_SUBJECT)) return base;
  const subject = input.reasonFiltered
    ? "The reason filter and time window narrow"
    : "The time window narrows";
  return base.replace(REASON_SUBJECT, subject);
}
