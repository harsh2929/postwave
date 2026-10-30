import { describe, expect, it } from "vitest";

import {
  UNDATED_SECTION_KEY,
  dayDistance,
  dayTitle,
  groupByDay,
  localDayKey,
} from "./inboxGrouping";

/** Rows shaped like the notification feed's items. */
function row(created_at: string | null | undefined, id = created_at ?? "x") {
  return { id, created_at };
}

const NOW = new Date(2026, 6, 25, 14, 30).getTime(); // 2026-07-25, local

describe("localDayKey", () => {
  it("uses the LOCAL calendar day, not UTC", () => {
    // 23:30 local on the 25th is the 26th in UTC for many zones; the reader
    // who is awake at 23:30 must still see "Today".
    const late = new Date(2026, 6, 25, 23, 30).getTime();
    expect(localDayKey(late)).toBe("2026-07-25");
  });

  it("zero-pads month and day so keys sort lexicographically", () => {
    expect(localDayKey(new Date(2026, 0, 3).getTime())).toBe("2026-01-03");
  });
});

describe("dayDistance", () => {
  it("counts calendar days, not elapsed 24h windows", () => {
    // 23:00 yesterday to 01:00 today is two hours but one calendar day.
    const yesterdayLate = new Date(2026, 6, 24, 23, 0).getTime();
    const todayEarly = new Date(2026, 6, 25, 1, 0).getTime();
    expect(dayDistance(yesterdayLate, todayEarly)).toBe(1);
  });

  it("is negative for a future timestamp", () => {
    expect(dayDistance(new Date(2026, 6, 27).getTime(), NOW)).toBe(-2);
  });
});

describe("dayTitle", () => {
  it("names today and yesterday", () => {
    expect(dayTitle(new Date(2026, 6, 25, 9, 0).getTime(), NOW)).toBe("Today");
    expect(dayTitle(new Date(2026, 6, 24, 9, 0).getTime(), NOW)).toBe(
      "Yesterday",
    );
  });

  it("uses a weekday name inside the last week", () => {
    const title = dayTitle(new Date(2026, 6, 21).getTime(), NOW);
    expect(title).not.toMatch(/ago/);
    expect(title).not.toBe("Today");
    expect(title).not.toBe("Yesterday");
    // A weekday name is a single word with no digits.
    expect(title).toMatch(/^[^\d]+$/);
  });

  it("falls back to an absolute date past a week — never an unbounded day count", () => {
    const title = dayTitle(new Date(2026, 3, 2).getTime(), NOW);
    expect(title).toMatch(/\d/);
    expect(title).not.toMatch(/ago/);
  });

  it("includes the year once the date leaves the current year", () => {
    expect(dayTitle(new Date(2024, 3, 2).getTime(), NOW)).toMatch(/2024/);
  });

  it("does not go negative for a future timestamp", () => {
    expect(dayTitle(new Date(2026, 6, 27).getTime(), NOW)).toBe("Upcoming");
  });
});

describe("groupByDay", () => {
  it("buckets consecutive rows of the same day into one section", () => {
    const items = [
      row(new Date(2026, 6, 25, 12, 0).toISOString(), "a"),
      row(new Date(2026, 6, 25, 9, 0).toISOString(), "b"),
      row(new Date(2026, 6, 24, 18, 0).toISOString(), "c"),
    ];
    const sections = groupByDay(items, (r) => r.created_at, NOW);
    expect(sections.map((s) => s.title)).toEqual(["Today", "Yesterday"]);
    expect(sections[0]?.data.map((r) => r.id)).toEqual(["a", "b"]);
    expect(sections[1]?.data.map((r) => r.id)).toEqual(["c"]);
  });

  it("never drops a row and never re-sorts one", () => {
    const items = [
      row(new Date(2026, 6, 25, 8, 0).toISOString(), "a"),
      row(new Date(2026, 6, 25, 20, 0).toISOString(), "b"), // later, listed second
      row(new Date(2026, 6, 24).toISOString(), "c"),
    ];
    const sections = groupByDay(items, (r) => r.created_at, NOW);
    const flat = sections.flatMap((s) => s.data.map((r) => r.id));
    expect(flat).toEqual(["a", "b", "c"]);
  });

  it("keeps an out-of-order repeat of a day visible with a unique key", () => {
    const items = [
      row(new Date(2026, 6, 25).toISOString(), "a"),
      row(new Date(2026, 6, 24).toISOString(), "b"),
      row(new Date(2026, 6, 25).toISOString(), "c"),
    ];
    const sections = groupByDay(items, (r) => r.created_at, NOW);
    expect(sections).toHaveLength(3);
    expect(new Set(sections.map((s) => s.key)).size).toBe(3);
    expect(sections.flatMap((s) => s.data.map((r) => r.id))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("puts an unparseable or missing timestamp in a trailing bucket rather than dropping it", () => {
    const items = [
      row(new Date(2026, 6, 25).toISOString(), "a"),
      row("not-a-date", "b"),
      row(null, "c"),
    ];
    const sections = groupByDay(items, (r) => r.created_at, NOW);
    const last = sections[sections.length - 1];
    expect(last?.key).toBe(UNDATED_SECTION_KEY);
    expect(last?.data.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("returns no sections for an empty feed", () => {
    expect(groupByDay([], (r: { created_at: string }) => r.created_at, NOW)).toEqual(
      [],
    );
  });

  it("accepts an epoch number as well as an ISO string", () => {
    const sections = groupByDay(
      [{ at: new Date(2026, 6, 25, 10).getTime() }],
      (r) => r.at,
      NOW,
    );
    expect(sections[0]?.title).toBe("Today");
  });
});
