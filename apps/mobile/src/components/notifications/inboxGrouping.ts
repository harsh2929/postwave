/**
 * inboxGrouping — the inbox's day buckets.
 *
 * The feed is a flat, reverse-chronological list where every row carries a
 * relative timestamp. Answering "what happened today" therefore means reading
 * every row's "3h ago" and doing the arithmetic yourself, and the boundary
 * between today and last Tuesday is invisible.
 *
 * These are the rules behind the SectionList headers:
 *
 *  - ORDER IS PRESERVED, NEVER RE-SORTED. The server decides the order; this
 *    only inserts boundaries where the local calendar day changes. Re-sorting
 *    here would silently disagree with the server's own paging.
 *  - A ROW IS NEVER DROPPED. An unparseable `created_at` lands in a trailing
 *    "Earlier" bucket rather than vanishing — a notification you cannot see is
 *    strictly worse than one with a vague heading.
 *  - THE HEADING IS ABSOLUTE. "Today"/"Yesterday" for the two days a reader
 *    holds in their head, a weekday name inside the last week, then a real
 *    date. Relative day counts ("6d ago") are the thing this replaces.
 *
 * DELIBERATELY IMPORT-FREE — no react-native, no theme — so it runs in the
 * node vitest environment like approvalPolicy/feedbackPolicy/typeScale.
 */
import { calendarDate } from "@/lib/format";


export interface InboxSection<T> {
  /** Stable SectionList key: the local calendar day, or "undated". */
  readonly key: string;
  /** Rendered heading. */
  readonly title: string;
  readonly data: readonly T[];
}

export const UNDATED_SECTION_KEY = "undated";
export const UNDATED_SECTION_TITLE = "Earlier";

/** Local calendar day as `YYYY-MM-DD`. Local, not UTC: a notification at
 *  23:30 must read "Today" to the person who is awake at 23:30. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Whole calendar days between two instants, by local midnight. */
export function dayDistance(ms: number, now: number): number {
  const a = new Date(ms);
  const b = new Date(now);
  const midnightA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const midnightB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  // Divide by a whole day AFTER snapping both ends to midnight, so a DST
  // transition inside the span cannot round the answer to the wrong day.
  return Math.round((midnightB - midnightA) / 86_400_000);
}

/**
 * The heading for a day.
 *
 * A FUTURE timestamp (clock skew between the device and the server is real,
 * and a scheduled notification can legitimately be stamped ahead) reads
 * "Upcoming" rather than "in -1 days".
 */
export function dayTitle(ms: number, now: number): string {
  const distance = dayDistance(ms, now);
  if (distance < 0) return "Upcoming";
  if (distance === 0) return "Today";
  if (distance === 1) return "Yesterday";
  const d = new Date(ms);
  if (distance < 7) {
    return calendarDate(d, { weekday: "long", dayMonth: false });
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return calendarDate(d, { withYear: !sameYear });
}

/**
 * Bucket rows into consecutive day sections, preserving input order.
 *
 * `at` pulls the timestamp off a row so this stays usable by any
 * chronological feed, not only the notification inbox.
 */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => string | number | null | undefined,
  now: number = Date.now(),
): InboxSection<T>[] {
  const sections: { key: string; title: string; data: T[] }[] = [];
  const undated: T[] = [];

  for (const item of items) {
    const raw = at(item);
    const ms =
      typeof raw === "number" ? raw : raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(ms)) {
      undated.push(item);
      continue;
    }
    const key = localDayKey(ms);
    const last = sections[sections.length - 1];
    // Append to the OPEN section only. A feed that returns out-of-order rows
    // gets a second section with the same day rather than a silent re-sort —
    // visible, and honest about what the server sent.
    if (last && last.key === key) last.data.push(item);
    else sections.push({ key, title: dayTitle(ms, now), data: [item] });
  }

  const out: InboxSection<T>[] = sections.map((section, index) => ({
    // Repeated days (out-of-order feeds) must still have unique keys.
    key: index === 0 ? section.key : `${section.key}#${index}`,
    title: section.title,
    data: section.data,
  }));
  if (undated.length > 0) {
    out.push({
      key: UNDATED_SECTION_KEY,
      title: UNDATED_SECTION_TITLE,
      data: undated,
    });
  }
  return out;
}
