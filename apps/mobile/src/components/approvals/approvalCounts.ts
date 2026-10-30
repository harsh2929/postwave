/**
 * approvalCounts — the one line that says what the queue is currently showing.
 *
 * WHY THIS IS NOT COSMETIC. The Approvals list changes shape from two
 * different controls: a search box and the Pending/All chips. `SearchField`
 * already publishes a polite live region for the SEARCH count, so a VoiceOver
 * user who types hears "3 approvals". Tapping the "All" chip, however, swapped
 * the entire data set in silence — nothing in the accessibility tree changed
 * text, so the only feedback was the chip's own `selected` state, which
 * VoiceOver announces for the chip and not for the list. The user was left
 * unsure whether the tap registered at all.
 *
 * So the line renders ALWAYS (not only while a search narrows it), it names
 * the active filter, and the screen marks it `accessibilityLiveRegion="polite"`
 * — the same treatment `SubscribersListHeader` uses for exactly this defect.
 *
 * Pure, and free of react-native, so the copy is unit-tested rather than
 * eyeballed. `loaded` is the tab's row count before search narrowing; `shown`
 * is after. When they differ the line has to state both, or "3 requests" over
 * a 48-row queue reads as data loss.
 */
import type { FilterKey } from "./approvalPresentation";
import { num } from "@/lib/format";

export interface ApprovalCountLineInput {
  filter: FilterKey;
  /** Rows rendered right now (after search narrowing). */
  shown: number;
  /** Rows loaded for the active tab (before search narrowing). */
  loaded: number;
  searching: boolean;
}

/** Plural-correct noun for the active chip. */
function noun(filter: FilterKey, count: number): string {
  if (filter === "pending") {
    return count === 1 ? "request awaiting a decision" : "requests awaiting a decision";
  }
  return count === 1 ? "request · all statuses" : "requests · all statuses";
}

/**
 * The count line, or null when there is nothing honest to say.
 *
 * Null when `loaded` is 0: an empty queue already renders an EmptyState with
 * its own copy, and "0 requests awaiting a decision" stacked above "You're
 * caught up" is the same fact twice.
 */
export function approvalCountLine(input: ApprovalCountLineInput): string | null {
  const loaded = Math.max(0, Math.trunc(input.loaded));
  const shown = Math.max(0, Math.min(Math.trunc(input.shown), loaded));
  if (loaded === 0) return null;
  if (input.searching && shown !== loaded) {
    return `${num(shown)} of ${num(loaded)} ${noun(input.filter, loaded)}`;
  }
  return `${num(loaded)} ${noun(input.filter, loaded)}`;
}
