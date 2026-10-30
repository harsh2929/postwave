/**
 * lib/campaignCalendarMonth.ts — the month-at-a-glance density view of the
 * send calendar.
 *
 * Desktop answers "what is going out this month?" with a six-week grid you can
 * drag sends around in (CampaignCalendar.tsx). The DENSITY half of that view
 * is what a phone was missing: the agenda answers "what is next?" but cannot
 * show that the 14th is empty while the 21st has five sends stacked on it.
 * The DRAG half is deliberately not translated — desktop's own drag is dead
 * behind `CAMPAIGN_SCHEDULING_AVAILABLE = false`
 * (apps/desktop/src/lib/campaign-operational-availability.ts:7), and mobile's
 * live reschedule path is CampaignScheduleModal on the campaign detail screen,
 * one tap from any agenda row. So the month grid here is a lens: tap a day to
 * narrow the agenda to it, tap again to widen back out.
 *
 * ONLY `scheduled` ROWS COUNT — the same rule as lib/campaignAgenda, for the
 * same reason: a sent campaign has a `scheduled_at` in its past and is not
 * "going out". Density and agenda must agree or a day showing "3" would open
 * into a list of two.
 *
 * DAY BOUNDARIES ARE LOCAL, and all day arithmetic is delegated to
 * lib/campaignAgenda's `localDayStart` so the two views cannot disagree across
 * a daylight-saving boundary.
 *
 * Import-free beyond that sibling, so the whole module runs in the node
 * vitest environment. Date PRESENTATION (month titles, weekday names in the
 * operator's locale) stays with the component, which owns the locale.
 */

import {
  localDayStart,
  type AgendaRow,
} from "@/lib/campaignAgenda";

/** One cell of the six-week grid. */
export interface MonthCell {
  /** Midnight (local) of the cell's day. */
  dayStart: number;
  /** False for the leading/trailing days that pad the grid to full weeks. */
  inMonth: boolean;
  today: boolean;
  /** Scheduled sends on this local day. */
  count: number;
}

export interface CampaignMonth {
  /** Midnight (local) of the 1st of the anchor month. */
  anchorMs: number;
  /** 42 cells — six weeks starting on the Sunday on/before the 1st. */
  cells: MonthCell[];
  /** Scheduled sends across the anchor month itself (padding days excluded). */
  scheduledInMonth: number;
}

/** Midnight (local) of the first day of the month containing `ms`. */
export function monthAnchor(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * The anchor `delta` months away. Built from year/month parts rather than by
 * adding 30 days, so January 31 → February can never land in March and a DST
 * shift can never move the anchor off midnight.
 */
export function addMonths(anchorMs: number, delta: number): number {
  const d = new Date(anchorMs);
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
}

/** Is `ms` inside the month that `anchorMs` anchors? */
export function inAnchorMonth(ms: number, anchorMs: number): boolean {
  const a = new Date(anchorMs);
  const d = new Date(ms);
  return (
    d.getFullYear() === a.getFullYear() && d.getMonth() === a.getMonth()
  );
}

/**
 * Scheduled rows falling on the local day starting at `dayStart`. The lens the
 * grid applies to the agenda when a day is picked — computed on day STARTS so
 * it uses the identical boundary the grid counted with.
 */
export function scheduledRowsOnDay<T extends AgendaRow>(
  rows: readonly T[],
  dayStart: number,
): T[] {
  return rows.filter((row) => {
    if ((row.status ?? "").trim().toLowerCase() !== "scheduled") return false;
    const ms = row.scheduled_at ? Date.parse(row.scheduled_at) : Number.NaN;
    return Number.isFinite(ms) && localDayStart(ms) === dayStart;
  });
}

/**
 * Build the six-week grid for the month anchored at `anchorMs`.
 *
 * Six weeks always — the desktop grid does the same (CampaignCalendar
 * `for i < 42`) — so paging months never changes the panel's height under the
 * operator's thumb.
 */
export function buildCampaignMonth(
  rows: readonly AgendaRow[],
  anchorMs: number,
  nowMs: number,
): CampaignMonth {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if ((row.status ?? "").trim().toLowerCase() !== "scheduled") continue;
    const ms = row.scheduled_at ? Date.parse(row.scheduled_at) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    const day = localDayStart(ms);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const first = new Date(anchorMs);
  // Back to the Sunday on/before the 1st — the same alignment desktop uses.
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - first.getDay(),
  );
  const today = localDayStart(nowMs);

  const cells: MonthCell[] = [];
  let scheduledInMonth = 0;
  for (let i = 0; i < 42; i += 1) {
    // Constructed per-cell from calendar parts, not by adding 86_400_000:
    // a 23-hour DST day would otherwise shift every later cell by an hour.
    const day = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    const dayStart = day.getTime();
    const inMonth = inAnchorMonth(dayStart, anchorMs);
    const count = counts.get(dayStart) ?? 0;
    if (inMonth) scheduledInMonth += count;
    cells.push({ dayStart, inMonth, today: dayStart === today, count });
  }

  return { anchorMs, cells, scheduledInMonth };
}
