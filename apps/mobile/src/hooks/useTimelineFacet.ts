/**
 * useTimelineFacet — the subscriber timeline's type filter, as one value.
 *
 * The rules are pure and tested in src/lib/timelineFilter.ts; this is only the
 * state plus the memos. It exists as a hook rather than four `useState` /
 * `useMemo` lines in the detail screen for a concrete reason: that screen's
 * function sits against its complexity ceiling, and every branch inlined there
 * is one the whole 300-line component has to carry.
 *
 * No react-native import, deliberately — the screen mocks its data hooks in
 * the jest route test, and this one stays cheap to evaluate for real.
 */
import { useMemo, useState } from "react";

import {
  emptyFacetMessage,
  facetCounts,
  filterTimeline,
  type TimelineFacet,
  type TimelineFacetable,
} from "@/lib/timelineFilter";

export interface TimelineFacetState<T extends TimelineFacetable> {
  facet: TimelineFacet;
  setFacet: (next: TimelineFacet) => void;
  /** Events matching the active facet, in the order they arrived. */
  rows: T[];
  /** Events the loaded pages contained, before filtering. */
  loaded: number;
  /** Loaded events whose type the facet map does not recognise. */
  unclassified: number;
  counts: Record<TimelineFacet, number>;
  /**
   * The scope-honest sentence for "this facet matched nothing", or undefined
   * under All — where an empty list is genuinely an empty record and the
   * feed's own empty state is the right one.
   */
  emptyMessage: string | undefined;
}

export function useTimelineFacet<T extends TimelineFacetable>(
  events: readonly T[],
  hasMore: boolean,
): TimelineFacetState<T> {
  const [facet, setFacet] = useState<TimelineFacet>("all");
  const filtered = useMemo(() => filterTimeline(events, facet), [events, facet]);
  const counts = useMemo(() => facetCounts(events), [events]);
  const emptyMessage =
    facet === "all" ? undefined : emptyFacetMessage(facet, hasMore);
  return {
    facet,
    setFacet,
    rows: filtered.rows,
    loaded: filtered.loaded,
    unclassified: filtered.unclassified,
    counts,
    emptyMessage,
  };
}
