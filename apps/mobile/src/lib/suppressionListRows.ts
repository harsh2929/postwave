/**
 * suppressionListRows — the PURE half of what the suppressions screen decides
 * about the rows it was handed.
 *
 * WHAT LIVES HERE vs THE SCREEN. app/(tabs)/suppressions/index.tsx renders;
 * it imports react-native, expo-router and the query hooks, so nothing inside
 * it can be exercised in the node vitest environment. Two things it does are
 * decisions rather than rendering — which of the loaded rows survive the
 * reason chip and the sub-3-character query, and what the empty state says —
 * and they live here so a node test can call them directly.
 *
 * Split out when the screen's paging footer pushed its component function past
 * the 300-line function budget; same idiom as lib/suppressionPage.ts, which
 * already owns the paging rule for the same screen.
 */
import type { SuppressionRow } from "@/lib/suppressionPage";
import {
  needsClientFilter,
  reasonMatchesFilter,
  type ClassifiedQuery,
  type SuppressionFilter,
} from "@/lib/suppressionSearch";

/**
 * A row's timestamp as a sortable number, with unparseable and missing dates
 * sorting last rather than poisoning the comparator with NaN.
 */
export function sortTime(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The rows the screen actually renders: newest first, narrowed by whatever the
 * server could NOT narrow.
 *
 * Server-side filtering is already applied for a query of >=3 characters, so
 * only a 1-2 character query (`needsClientFilter`) and the reason chip — which
 * has no server parameter at all — narrow anything here. Filtering a second
 * time on a query the server already applied would be harmless but is not the
 * contract; asking `classified` keeps the two halves in step.
 */
export function filterSuppressionRows(
  items: readonly SuppressionRow[] | undefined,
  filter: SuppressionFilter,
  classified: ClassifiedQuery,
  window: SuppressionDateWindow = "all",
  now: number = Date.now(),
): SuppressionRow[] {
  const needle = needsClientFilter(classified) ? classified.value : "";
  return (items ?? [])
    .filter((row) => {
      if (!reasonMatchesFilter(row.reason, filter)) return false;
      if (!rowInDateWindow(row.created_at, window, now)) return false;
      if (!needle) return true;
      return (row.email ?? "").toLowerCase().includes(needle);
    })
    .sort((a, b) => sortTime(b.created_at) - sortTime(a.created_at));
}

/**
 * The time-window chips — mobile's translation of desktop's from/to
 * DateRangePopover (Suppressions.tsx:1233). Desktop keeps the range a LOCAL
 * VIEW over fetched rows (filterSuppressionRows, Suppressions.tsx:239) and so
 * does this: the question the control answers on a phone is "what got
 * suppressed after last night's send?", which is a relative window, not a
 * calendar pair. Windows are pure durations so the rule is node-testable.
 */
export const SUPPRESSION_DATE_WINDOWS = [
  { key: "all", label: "Any time", hours: null, accessibilityLabel: "Show suppressions from any time" },
  { key: "24h", label: "24 hours", hours: 24, accessibilityLabel: "Show suppressions from the last 24 hours" },
  { key: "7d", label: "7 days", hours: 7 * 24, accessibilityLabel: "Show suppressions from the last 7 days" },
  { key: "30d", label: "30 days", hours: 30 * 24, accessibilityLabel: "Show suppressions from the last 30 days" },
] as const;

export type SuppressionDateWindow =
  (typeof SUPPRESSION_DATE_WINDOWS)[number]["key"];

/** Guard a persisted preference an older build may have written. */
export function suppressionDateWindowByKey(
  key: string | undefined,
): SuppressionDateWindow {
  return SUPPRESSION_DATE_WINDOWS.some((w) => w.key === key)
    ? (key as SuppressionDateWindow)
    : "all";
}

/**
 * Whether a row's timestamp falls inside the window.
 *
 * A row with a MISSING or unparseable date is excluded from every narrowed
 * window: "suppressed in the last 24 hours" is a positive claim, and a row
 * whose time is unknown cannot support it (it still shows under "Any time").
 */
export function rowInDateWindow(
  createdAt: string | undefined,
  window: SuppressionDateWindow,
  now: number,
): boolean {
  if (window === "all") return true;
  const def = SUPPRESSION_DATE_WINDOWS.find((w) => w.key === window);
  if (!def || def.hours === null) return true;
  const at = sortTime(createdAt);
  if (at === 0) return false;
  return now - at <= def.hours * 3_600_000;
}

/**
 * The empty state's words.
 *
 * "Nothing matches" and "No suppressions" are different facts about the
 * workspace, and the filtered copy has to say that search reaches the whole
 * archive — an operator who reads "try a different address" while looking at a
 * page of 50 would reasonably conclude the search only covered that page.
 */
export function suppressionEmptyCopy(filtered: boolean): {
  title: string;
  description: string;
} {
  return filtered
    ? {
        title: "Nothing matches",
        description:
          "Search covers every suppressed address, not just this page — try a different address or reason.",
      }
    : {
        title: "No suppressions",
        description: "When recipients bounce or complain they show up here.",
      };
}
