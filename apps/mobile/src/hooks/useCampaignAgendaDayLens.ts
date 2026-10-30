/**
 * hooks/useCampaignAgendaDayLens — the month grid's day lens over the
 * scheduled agenda, plus the one entry shape both view modes share.
 *
 * THE LENS. While the Scheduled bucket is open, CampaignScheduleOutlook lets
 * the operator tap a day to narrow the agenda to it. The lens is cleared when
 * the bucket changes, and when a refetch empties the picked day — a held
 * narrowing over rows that no longer exist would render the agenda's empty
 * state while the grid's chip still claimed there were sends. `rows` is what
 * is ACTUALLY on screen: everything that claims to describe "the visible
 * list" — the entries, the selection layer, the shown count — must read it,
 * so a bulk verb can never fire at a row the lens hides.
 *
 * THE ENTRIES. One entry shape for both modes, so the screen's FlatList keeps
 * its ref-bound scroll restoration, tab-tap scroll-to-top, pagination and
 * perf props. A SectionList would have cost all four to gain day headers.
 *
 * Extracted from app/(tabs)/campaigns/index.tsx as a sibling (the screen
 * function was at its source budget); the day arithmetic itself lives in
 * lib/campaignCalendarMonth, node-tested.
 */
import { useEffect, useMemo, useState } from "react";

import {
  campaignAgendaEntries,
  type AgendaEntry,
  type AgendaRow,
} from "@/lib/campaignAgenda";
import { scheduledRowsOnDay } from "@/lib/campaignCalendarMonth";

export interface CampaignAgendaDayLens<T> {
  /** Local midnight of the day the agenda is narrowed to, or null. */
  day: number | null;
  setDay: (dayStart: number | null) => void;
  /** The visible list: `items`, narrowed to `day` while the lens is held. */
  rows: T[];
  /** The FlatList's data — agenda sections or plain rows, one shape. */
  entries: AgendaEntry<T>[];
}

export function useCampaignAgendaDayLens<T extends AgendaRow>(
  agenda: boolean,
  items: readonly T[],
): CampaignAgendaDayLens<T> {
  const [day, setDay] = useState<number | null>(null);
  useEffect(() => {
    if (!agenda) setDay(null);
  }, [agenda]);
  useEffect(() => {
    if (day !== null && scheduledRowsOnDay(items, day).length === 0) {
      setDay(null);
    }
  }, [items, day]);

  const rows = useMemo(
    () =>
      agenda && day !== null ? scheduledRowsOnDay(items, day) : [...items],
    [agenda, day, items],
  );

  const entries = useMemo<AgendaEntry<T>[]>(
    () =>
      agenda
        ? campaignAgendaEntries(rows, Date.now())
        : rows.map((c) => ({
            kind: "row" as const,
            key: String(c.id),
            campaign: c,
          })),
    [agenda, rows],
  );

  return { day, setDay, rows, entries };
}
