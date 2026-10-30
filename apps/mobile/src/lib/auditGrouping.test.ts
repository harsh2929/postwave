import { describe, expect, it } from "vitest";

import {
  AUDIT_WINDOWS,
  auditDayLabel,
  auditWindowDescription,
  auditWindowSince,
  freshnessSentence,
  groupAuditRowsByDay,
  oldestUpdatedAt,
} from "./auditGrouping";

/** A fixed local-noon anchor, so day boundaries never straddle midnight. */
const NOW = new Date(2026, 6, 25, 12, 0, 0).getTime();

function atLocal(
  year: number,
  month: number,
  day: number,
  hour = 9,
): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("auditWindowSince", () => {
  it("returns undefined for the unbounded window", () => {
    expect(auditWindowSince("all", NOW)).toBeUndefined();
  });

  it("subtracts exactly 24 hours for the 24h window", () => {
    const since = auditWindowSince("24h", NOW);
    expect(since).toBeDefined();
    expect(NOW - Date.parse(since!)).toBe(24 * 60 * 60 * 1000);
  });

  it("subtracts 7 and 30 days for the wider windows", () => {
    expect(NOW - Date.parse(auditWindowSince("7d", NOW)!)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(NOW - Date.parse(auditWindowSince("30d", NOW)!)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("emits an RFC3339/ISO string the server can parse", () => {
    expect(auditWindowSince("24h", NOW)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("degrades to unbounded rather than emitting Invalid Date", () => {
    expect(auditWindowSince("24h", Number.NaN)).toBeUndefined();
  });

  it("describes every window it offers", () => {
    for (const option of AUDIT_WINDOWS) {
      expect(auditWindowDescription(option.value).length).toBeGreaterThan(0);
    }
  });
});

describe("auditDayLabel", () => {
  it("names today and yesterday relatively", () => {
    expect(auditDayLabel("2026-07-25", NOW)).toBe("Today");
    expect(auditDayLabel("2026-07-24", NOW)).toBe("Yesterday");
  });

  it("falls back to an absolute date beyond yesterday", () => {
    const label = auditDayLabel("2026-07-20", NOW);
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label).toContain("20");
  });

  it("returns the raw key when it is not a date", () => {
    expect(auditDayLabel("not-a-day", NOW)).toBe("not-a-day");
  });
});

describe("groupAuditRowsByDay", () => {
  const keyOf = (row: { id: number }) => String(row.id);

  it("emits a header before each new calendar day and counts its rows", () => {
    const rows = [
      { id: 3, at: atLocal(2026, 7, 25, 11) },
      { id: 2, at: atLocal(2026, 7, 25, 9) },
      { id: 1, at: atLocal(2026, 7, 24, 22) },
    ];
    const items = groupAuditRowsByDay(rows, NOW, keyOf);
    expect(items.map((i) => i.kind)).toEqual([
      "day",
      "row",
      "row",
      "day",
      "row",
    ]);
    const headers = items.filter((i) => i.kind === "day");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toMatchObject({ label: "Today", count: 2 });
    expect(headers[1]).toMatchObject({ label: "Yesterday", count: 1 });
  });

  it("preserves the server's newest-first order inside a day", () => {
    const rows = [
      { id: 9, at: atLocal(2026, 7, 25, 11) },
      { id: 8, at: atLocal(2026, 7, 25, 10) },
    ];
    const items = groupAuditRowsByDay(rows, NOW, keyOf);
    const ids = items.flatMap((i) => (i.kind === "row" ? [i.row.id] : []));
    expect(ids).toEqual([9, 8]);
  });

  it("keeps a row with an unparseable timestamp reachable", () => {
    const rows = [{ id: 1, at: "" }];
    const items = groupAuditRowsByDay(rows, NOW, keyOf);
    expect(items[0]).toMatchObject({ kind: "day", label: "Undated", count: 1 });
    expect(items[1]).toMatchObject({ kind: "row" });
  });

  it("produces unique item keys so FlatList never recycles onto the wrong row", () => {
    const rows = [
      { id: 1, at: atLocal(2026, 7, 25, 11) },
      { id: 2, at: atLocal(2026, 7, 24, 11) },
      { id: 3, at: atLocal(2026, 7, 23, 11) },
    ];
    const items = groupAuditRowsByDay(rows, NOW, keyOf);
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns an empty list for no rows", () => {
    expect(groupAuditRowsByDay([], NOW, keyOf)).toEqual([]);
  });
});

describe("oldestUpdatedAt", () => {
  it("reports the STALEST stamp — a screen is only as fresh as its worst query", () => {
    const older = NOW - 2 * 60 * 60 * 1000;
    expect(oldestUpdatedAt([NOW, older])).toBe(older);
    expect(oldestUpdatedAt([older, NOW])).toBe(older);
  });

  it("treats TanStack's never-fetched 0 as absent, not as 1970", () => {
    expect(oldestUpdatedAt([0, NOW])).toBe(NOW);
    expect(oldestUpdatedAt([0, 0])).toBeNull();
  });

  it("ignores undefined, null and non-finite stamps", () => {
    expect(oldestUpdatedAt([undefined, null, Number.NaN, NOW])).toBe(NOW);
    expect(oldestUpdatedAt([])).toBeNull();
  });
});

describe("freshnessSentence", () => {
  it("states the age of what is on screen", () => {
    const line = freshnessSentence("Sink health", NOW - 3 * 60_000, NOW);
    expect(line).toContain("Sink health as of");
    expect(line).toMatch(/3 minutes ago|3m ago/);
  });

  it("returns null when nothing has ever loaded — an age for absent data is a fabrication", () => {
    expect(freshnessSentence("Sink health", null, NOW)).toBeNull();
    expect(freshnessSentence("Sink health", 0, NOW)).toBeNull();
    expect(freshnessSentence("Sink health", undefined, NOW)).toBeNull();
  });
});
