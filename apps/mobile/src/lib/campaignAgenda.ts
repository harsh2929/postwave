/**
 * lib/campaignAgenda.ts — "what is going out, and when?", grouped by day.
 *
 * Desktop answers this with a month grid you can drag sends around in
 * (CampaignCalendar). A month grid on a phone is twenty-eight cells the width
 * of a thumbnail, so the mobile-appropriate shape is the one every calendar app
 * falls back to on a narrow screen: an AGENDA — a chronological list, grouped
 * by day, soonest first.
 *
 * WHY THE ORDER IS INVERTED FROM THE REST OF THE LIST. Every other view of this
 * list is newest-first, because for a SENT campaign "most recent" is "most
 * relevant". For a scheduled one it is exactly backwards: the send that matters
 * is the NEXT one, and newest-first buries it under everything scheduled for
 * next month. So an agenda is ascending, and that inversion is the whole reason
 * this cannot just be another entry in `CAMPAIGN_SORTS`.
 *
 * OVERDUE IS ITS OWN SECTION, AND IT LEADS. A campaign still marked `scheduled`
 * whose time has passed is the single most alarming thing this list can
 * contain — the scheduler did not run, or the send failed to leave the queue.
 * Sorting it chronologically would file it under a date in the past, below the
 * fold, which is precisely where nobody looks.
 *
 * A SCHEDULED CAMPAIGN WITH NO TIME gets its own trailing section rather than
 * being dropped. It is a real row in a real workspace and hiding it would make
 * the agenda's count disagree with the chip's.
 *
 * DAY BOUNDARIES ARE LOCAL. "Today" means the operator's today, so the grouping
 * key comes from the device's local calendar rather than from UTC — a send at
 * 23:30 local must not appear under tomorrow because UTC has already rolled.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 * Date PRESENTATION stays with the caller (lib/format), which owns the locale;
 * this module emits a timestamp plus a relative-day hint and formats nothing.
 */

export interface AgendaRow {
  id: string;
  status?: string | undefined;
  scheduled_at?: string | null | undefined;
}

/** "Today" / "Tomorrow" when the day is one of those; otherwise null. */
export type RelativeDay = "today" | "tomorrow" | null;

export interface AgendaSection<T> {
  key: string;
  /** Midnight (local) of the section's day; null for the two special groups. */
  dayStart: number | null;
  relativeDay: RelativeDay;
  /** Set only for the sections that are not a calendar day. */
  specialTitle: "Overdue" | "No send time set" | null;
  rows: T[];
}

/** One flat item, so the agenda can render inside the existing FlatList. */
export type AgendaEntry<T> =
  | {
      kind: "header";
      key: string;
      dayStart: number | null;
      relativeDay: RelativeDay;
      specialTitle: "Overdue" | "No send time set" | null;
      count: number;
    }
  | { kind: "row"; key: string; campaign: T };

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Midnight, in the DEVICE's calendar, of the day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * How many local calendar days separate two instants. Computed on day STARTS,
 * not by dividing the raw difference by 86_400_000 — that arithmetic is wrong
 * across a daylight-saving boundary, where a local day is 23 or 25 hours.
 */
export function localDayOffset(fromMs: number, toMs: number): number {
  const from = localDayStart(fromMs);
  const to = localDayStart(toMs);
  return Math.round((to - from) / 86_400_000);
}

function relativeDayFor(dayStart: number, nowMs: number): RelativeDay {
  const offset = localDayOffset(nowMs, dayStart);
  if (offset === 0) return "today";
  if (offset === 1) return "tomorrow";
  return null;
}

/**
 * Group rows into agenda sections: Overdue, then each future day ascending,
 * then the no-time bucket.
 *
 * Only rows whose status is `scheduled` are agenda material — a sent campaign
 * has a `scheduled_at` in its past and is not "upcoming".
 */
export function buildCampaignAgenda<T extends AgendaRow>(
  rows: readonly T[],
  nowMs: number,
): AgendaSection<T>[] {
  const overdue: T[] = [];
  const untimed: T[] = [];
  const byDay = new Map<number, T[]>();

  for (const row of rows) {
    if ((row.status ?? "").trim().toLowerCase() !== "scheduled") continue;
    const at = parseTime(row.scheduled_at);
    if (at === null) {
      untimed.push(row);
      continue;
    }
    if (at < nowMs) {
      overdue.push(row);
      continue;
    }
    const day = localDayStart(at);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }

  const sections: AgendaSection<T>[] = [];

  if (overdue.length > 0) {
    // Most overdue first: the send that should have gone out longest ago is
    // the one whose failure has been silent the longest.
    overdue.sort((a, b) => order(a, b, "asc"));
    sections.push({
      key: "agenda-overdue",
      dayStart: null,
      relativeDay: null,
      specialTitle: "Overdue",
      rows: overdue,
    });
  }

  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const rowsForDay = byDay.get(day) ?? [];
    rowsForDay.sort((a, b) => order(a, b, "asc"));
    sections.push({
      key: `agenda-day-${day}`,
      dayStart: day,
      relativeDay: relativeDayFor(day, nowMs),
      specialTitle: null,
      rows: rowsForDay,
    });
  }

  if (untimed.length > 0) {
    untimed.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    sections.push({
      key: "agenda-untimed",
      dayStart: null,
      relativeDay: null,
      specialTitle: "No send time set",
      rows: untimed,
    });
  }

  return sections;
}

/** Chronological within a day, with a total order so renders never reshuffle. */
function order<T extends AgendaRow>(a: T, b: T, _dir: "asc"): number {
  const left = parseTime(a.scheduled_at) ?? 0;
  const right = parseTime(b.scheduled_at) ?? 0;
  return left - right || String(a.id).localeCompare(String(b.id));
}

/**
 * Flatten sections into the single array a FlatList renders.
 *
 * Flat rather than a SectionList because the campaigns list already carries
 * scroll restoration, tab-tap scroll-to-top, infinite pagination and the
 * shared perf props — all bound to a FlatList ref. Swapping the container to
 * gain section headers would cost all four.
 */
export function campaignAgendaEntries<T extends AgendaRow>(
  rows: readonly T[],
  nowMs: number,
): AgendaEntry<T>[] {
  const entries: AgendaEntry<T>[] = [];
  for (const section of buildCampaignAgenda(rows, nowMs)) {
    entries.push({
      kind: "header",
      key: section.key,
      dayStart: section.dayStart,
      relativeDay: section.relativeDay,
      specialTitle: section.specialTitle,
      count: section.rows.length,
    });
    for (const row of section.rows) {
      entries.push({ kind: "row", key: `agenda-row-${row.id}`, campaign: row });
    }
  }
  return entries;
}
