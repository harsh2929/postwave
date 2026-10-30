/**
 * lib/productEventHealth.ts — "did the nightly thing stop sending?"
 *
 * This is the policy the whole product-events surface exists for. The catalogue
 * is easy to render and easy to render dishonestly, and every rule below exists
 * because the honest reading and the obvious reading disagree.
 *
 * 1. AGE IS MEASURED AGAINST THE SERVER'S CLOCK, NOT THE PHONE'S.
 *    `EventCatalogResponse.AsOf` (track/extras.go:357) is the instant the
 *    server closed its read snapshot, and `lastSeen` is a MAX taken inside that
 *    same snapshot. Subtracting `Date.now()` instead would fold the device's
 *    clock skew, and — far worse — a cached payload rendered offline would age
 *    on the shelf, so an event last seen 10 minutes before the snapshot would
 *    read as "3 days ago" purely because the phone had been in a tunnel. Every
 *    function here takes `measuredAt` explicitly; nothing reads a clock.
 *
 * 2. SILENT IS A DESCRIPTION, NEVER A DIAGNOSIS.
 *    The API has no notion of an expected cadence — nothing in `product_events`
 *    records that `order.placed` should arrive hourly and `plan.renewed`
 *    monthly. So a 12-day gap is a FACT and "broken" is a GUESS. The labels
 *    below state the gap; the tone is `warning` at its loudest and never
 *    `danger`, and the sentence says "no events in 12 days", not "stopped".
 *    Getting this wrong would turn every low-frequency event into a false
 *    alarm, and a monitor that cries wolf is a monitor nobody opens.
 *
 * 3. ABSENCE IS NOT ZERO, AND THIS IS THE SURFACE WHERE THAT BITES HARDEST.
 *    The catalogue is `GROUP BY event_name` inside the window
 *    (extras.go:240-252). An event that stopped arriving BEFORE the window
 *    began has no row at all — it does not appear with a count of 0. So the
 *    list can never be read as "these are my events"; it is "these are the
 *    events seen in the last N days". `catalogNotes` prints that, every time,
 *    rather than leaving the reader to infer it.
 *
 * 4. THE ROW MIXES TWO WINDOWS BY CONSTRUCTION.
 *    `count` covers `periodDays`; `daily` always covers the constant 7
 *    (`catalogDailySeriesPeriodDays`, extras.go:195). A 90-day number beside a
 *    7-day line is fine as long as the reader is told which is which, and a
 *    disaster otherwise.
 *
 * DELIBERATELY free of react-native imports so it runs under node vitest.
 */
import { plural } from "@/lib/format";
import type {
  ProductEventCatalog,
  ProductEventCatalogRow,
} from "@/lib/productEvents";

export type ProductEventFreshness = "live" | "quiet" | "silent" | "unknown";

/** Seen within a day of the snapshot. */
export const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Seen within a week of the snapshot. Beyond this the row reads as silent. */
export const QUIET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProductEventVerdict {
  freshness: ProductEventFreshness;
  /** The pill word. Always accompanied by `description`, never colour alone. */
  label: string;
  /** A full sentence. This is what assistive tech hears. */
  description: string;
  /** Gap between `lastSeen` and the snapshot, in ms. `null` when unknowable. */
  ageMs: number | null;
}

function instant(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function wholeDays(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Classify one catalogue row's last-seen against the snapshot instant.
 *
 * `unknown` is a real answer, not a fallback to `live`: a row whose `lastSeen`
 * we cannot parse is a row whose freshness we do not know, and claiming it is
 * healthy would hide exactly the failure this screen exists to catch.
 *
 * A `lastSeen` AFTER the snapshot cannot happen through the catalogue query
 * (it bounds `occurred_at <= asOf`, extras.go:250) but is clamped to zero
 * anyway, because ingest accepts `occurred_at` up to five minutes ahead
 * (`trackOccurredAtFutureSkewAllowance`, handlers.go:31) and a negative age
 * would render as "in 3 minutes".
 */
export function classifyProductEvent(
  lastSeen: string,
  measuredAt: string,
): ProductEventVerdict {
  const seen = instant(lastSeen);
  const now = instant(measuredAt);
  if (seen === null || now === null) {
    return {
      freshness: "unknown",
      label: "Unknown",
      description:
        "The server didn't report when this event was last seen, so its freshness is unknown.",
      ageMs: null,
    };
  }
  const ageMs = Math.max(0, now - seen);
  if (ageMs < LIVE_WINDOW_MS) {
    return {
      freshness: "live",
      label: "Live",
      description: "Seen in the last 24 hours.",
      ageMs,
    };
  }
  const days = wholeDays(ageMs);
  if (ageMs < QUIET_WINDOW_MS) {
    return {
      freshness: "quiet",
      label: "Quiet",
      description: `No events for ${plural(days, "day")}.`,
      ageMs,
    };
  }
  return {
    freshness: "silent",
    // Not "Broken", and not "Stopped": nothing in the API records how often
    // this event is SUPPOSED to arrive, so the gap is all we can assert.
    label: "Silent",
    description: `No events for ${plural(days, "day")}. If that isn't its normal rhythm, whatever sends it has stopped.`,
    ageMs,
  };
}

/**
 * Attention order first, because the failure this surface exists to catch is a
 * row nobody would scroll to. Silent rows lead, then rows whose freshness the
 * payload didn't let us determine, then quiet, then live; ties break on volume
 * so the biggest silent event is the first thing on screen rather than the
 * alphabetically luckiest one.
 */
const ATTENTION_RANK: Record<ProductEventFreshness, number> = {
  silent: 0,
  unknown: 1,
  quiet: 2,
  live: 3,
};

export type ProductEventOrder = "attention" | "volume";

export function orderProductEvents(
  rows: readonly ProductEventCatalogRow[],
  measuredAt: string,
  order: ProductEventOrder,
): ProductEventCatalogRow[] {
  const copy = [...rows];
  if (order === "volume") {
    // The server already returns `ORDER BY total DESC, event_name`
    // (extras.go:251); re-sorting is cheap and makes the screen independent of
    // that, so a server-side ordering change cannot silently mislabel the mode.
    copy.sort((a, b) => b.count - a.count || a.eventName.localeCompare(b.eventName));
    return copy;
  }
  const rank = new Map<string, number>();
  for (const row of rows) {
    rank.set(
      row.eventName,
      ATTENTION_RANK[classifyProductEvent(row.lastSeen, measuredAt).freshness],
    );
  }
  copy.sort(
    (a, b) =>
      (rank.get(a.eventName) ?? 0) - (rank.get(b.eventName) ?? 0) ||
      b.count - a.count ||
      a.eventName.localeCompare(b.eventName),
  );
  return copy;
}

/** Case-insensitive substring match on the event name. Empty query → all rows. */
export function filterProductEvents(
  rows: readonly ProductEventCatalogRow[],
  query: string,
): ProductEventCatalogRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => row.eventName.toLowerCase().includes(needle));
}

/** How many rows are silent at the snapshot instant. */
export function silentEventCount(
  rows: readonly ProductEventCatalogRow[],
  measuredAt: string,
): number {
  return rows.filter(
    (row) => classifyProductEvent(row.lastSeen, measuredAt).freshness === "silent",
  ).length;
}

/**
 * The one-line verdict above the list.
 *
 * Never a bare count: "2 silent" with no denominator reads as an absolute, and
 * the denominator is the whole point of a catalogue that only covers a window.
 */
export function catalogHeadline(
  rows: readonly ProductEventCatalogRow[],
  measuredAt: string,
): string {
  if (rows.length === 0) return "";
  const silent = silentEventCount(rows, measuredAt);
  if (silent === 0) {
    // Derived from the threshold rather than hardcoded, so moving
    // QUIET_WINDOW_MS can never leave this sentence claiming a window the
    // classifier no longer uses.
    return `Every one of ${plural(rows.length, "event")} has arrived in the last ${plural(
      QUIET_WINDOW_MS / (24 * 60 * 60 * 1000),
      "day",
    )}.`;
  }
  return `${silent} of ${plural(rows.length, "event")} ${silent === 1 ? "has" : "have"} sent nothing for a week or more.`;
}

/**
 * The disclosures that must travel with the list. Returned as separate lines
 * so the screen renders them without deciding anything, and so each one is
 * unit-testable on its own.
 */
export function catalogNotes(catalog: ProductEventCatalog): string[] {
  const notes: string[] = [];
  if (catalog.periodDays > 0) {
    notes.push(
      `Only events seen in the last ${plural(catalog.periodDays, "day")} appear here. One that stopped before that is missing from this list, not zero — widen the window to find it.`,
    );
  }
  if (catalog.totalDistinctEventNames > catalog.items.length) {
    notes.push(
      `Showing the ${catalog.items.length} busiest of ${plural(catalog.totalDistinctEventNames, "event name")}. The rest are on the web admin.`,
    );
  }
  if (
    catalog.dailySeriesPeriodDays > 0 &&
    catalog.periodDays > 0 &&
    catalog.dailySeriesPeriodDays !== catalog.periodDays
  ) {
    notes.push(
      `Each row's totals cover ${plural(catalog.periodDays, "day")}; its trend line always covers the last ${plural(catalog.dailySeriesPeriodDays, "day")}.`,
    );
  }
  if (catalog.eventBoundsScope === "period") {
    notes.push(
      "First and last seen are bounded by this window, so an older event's first-seen is the window's start rather than the day it began.",
    );
  }
  return notes;
}

/** Label for a row's first-seen, honest about whether it is a lifetime bound. */
export function firstSeenLabel(eventBoundsScope: string): string {
  return eventBoundsScope === "period" ? "First in window" : "First seen";
}
