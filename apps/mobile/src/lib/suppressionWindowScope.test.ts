/**
 * The footer's scope sentence once the TIME WINDOW can narrow the list, and
 * the window rule's edges — the phone's translation of desktop's local
 * from/to date range (Suppressions.tsx:1233; filterSuppressionRows :239 keeps
 * it a client-side view over fetched rows, and so does mobile).
 */
import { describe, expect, it } from "vitest";

import {
  filterSuppressionRows,
  rowInDateWindow,
  suppressionDateWindowByKey,
  SUPPRESSION_DATE_WINDOWS,
} from "@/lib/suppressionListRows";
import type { SuppressionRow } from "@/lib/suppressionPage";
import {
  suppressionPageScopeNote,
  type ClassifiedQuery,
} from "@/lib/suppressionSearch";
import { suppressionScopeNoteWithWindow } from "@/lib/suppressionWindowScope";

const NONE: ClassifiedQuery = { mode: "none", value: "" };
// Fixed clock so every boundary below is exact, not flaky.
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const HOUR = 3_600_000;

function row(over: Partial<SuppressionRow>): SuppressionRow {
  return { id: "id", email: "a@example.com", ...over };
}

describe("suppressionScopeNoteWithWindow — the sentence names what narrowed", () => {
  const base = { shown: 3, total: 1200 };

  it("blames the TIME WINDOW, not a reason filter the operator never touched", () => {
    const note = suppressionScopeNoteWithWindow({
      ...base,
      reasonFiltered: false,
      windowFiltered: true,
      canLoadMore: true,
    });
    expect(note).toBe(
      "Showing 3 of 1,200 suppressed addresses, newest first within what's loaded. " +
        "The time window narrows only what's loaded — load more, or search by address.",
    );
    expect(note).not.toMatch(/reason filter/u);
  });

  it("keeps the search fallback when paging is exhausted", () => {
    const note = suppressionScopeNoteWithWindow({
      ...base,
      reasonFiltered: false,
      windowFiltered: true,
      canLoadMore: false,
    });
    expect(note).toMatch(
      /^Showing 3 of 1,200 .* The time window narrows only what's loaded — search by address to reach the rest\.$/u,
    );
  });

  it("names both when the reason chip and the window are set", () => {
    const note = suppressionScopeNoteWithWindow({
      ...base,
      reasonFiltered: true,
      windowFiltered: true,
      canLoadMore: true,
    });
    expect(note).toContain(
      "The reason filter and time window narrow only what's loaded",
    );
  });

  it("is byte-identical to the base sentence while the window is Any time", () => {
    for (const reasonFiltered of [true, false]) {
      for (const canLoadMore of [true, false]) {
        expect(
          suppressionScopeNoteWithWindow({
            ...base,
            reasonFiltered,
            windowFiltered: false,
            canLoadMore,
          }),
        ).toBe(
          suppressionPageScopeNote({
            ...base,
            clientFiltered: reasonFiltered,
            canLoadMore,
          }),
        );
      }
    }
  });

  it("says nothing when every record is already on screen", () => {
    expect(
      suppressionScopeNoteWithWindow({
        shown: 3,
        total: 3,
        reasonFiltered: false,
        windowFiltered: true,
        canLoadMore: false,
      }),
    ).toBe("");
    expect(
      suppressionScopeNoteWithWindow({
        shown: 3,
        total: undefined,
        reasonFiltered: false,
        windowFiltered: true,
        canLoadMore: false,
      }),
    ).toBe("");
  });
});

describe("date window — parsing and validation at the edges", () => {
  it("7 and 30 days are exact to the second at the boundary", () => {
    for (const [key, hours] of [
      ["7d", 7 * 24],
      ["30d", 30 * 24],
    ] as const) {
      const edge = new Date(NOW - hours * HOUR).toISOString();
      const past = new Date(NOW - hours * HOUR - 1000).toISOString();
      expect(rowInDateWindow(edge, key, NOW)).toBe(true);
      expect(rowInDateWindow(past, key, NOW)).toBe(false);
    }
  });

  it("reads a date-only stamp as UTC midnight and an offset stamp as its instant", () => {
    // 2026-08-28 → 00:00Z, twelve hours before NOW: inside 24h.
    expect(rowInDateWindow("2026-08-28", "24h", NOW)).toBe(true);
    // 13:00+02:00 is 11:00Z — one hour ago, not "in the future".
    expect(rowInDateWindow("2026-08-28T13:00:00+02:00", "24h", NOW)).toBe(true);
    // 2026-08-27 → 00:00Z, 36 hours before NOW: outside 24h, inside 7d.
    expect(rowInDateWindow("2026-08-27", "24h", NOW)).toBe(false);
    expect(rowInDateWindow("2026-08-27", "7d", NOW)).toBe(true);
  });

  it("keeps a row stamped slightly in the future (server clock ahead) inside every window", () => {
    // "Suppressed in the last 24 hours" is a claim about age; a row that is
    // not older than the window belongs in it even when a clock skew makes
    // it look five minutes young.
    const ahead = new Date(NOW + 5 * 60_000).toISOString();
    for (const w of SUPPRESSION_DATE_WINDOWS) {
      expect(rowInDateWindow(ahead, w.key, NOW)).toBe(true);
    }
  });

  it("guards the persisted key strictly: case, whitespace and empty all fall back to Any time", () => {
    for (const w of SUPPRESSION_DATE_WINDOWS) {
      expect(suppressionDateWindowByKey(w.key)).toBe(w.key);
    }
    expect(suppressionDateWindowByKey("24H")).toBe("all");
    expect(suppressionDateWindowByKey(" 24h")).toBe("all");
    expect(suppressionDateWindowByKey("")).toBe("all");
  });

  it("the table is well-formed: unique keys, Any time is the only unbounded window, durations ascend", () => {
    const keys = SUPPRESSION_DATE_WINDOWS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    const bounded = SUPPRESSION_DATE_WINDOWS.filter((w) => w.hours !== null);
    expect(SUPPRESSION_DATE_WINDOWS.length - bounded.length).toBe(1);
    expect(SUPPRESSION_DATE_WINDOWS.find((w) => w.hours === null)?.key).toBe(
      "all",
    );
    const hours = bounded.map((w) => w.hours as number);
    expect(hours.every((h) => Number.isInteger(h) && h > 0)).toBe(true);
    expect([...hours].sort((a, b) => a - b)).toEqual(hours);
    for (const w of SUPPRESSION_DATE_WINDOWS) {
      expect(w.label.trim()).not.toBe("");
      expect(w.accessibilityLabel).toMatch(/^Show suppressions from/u);
    }
  });

  it("narrows the page without reordering it: newest first survives the window", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "older", created_at: new Date(NOW - 20 * HOUR).toISOString() }),
        row({ id: "newer", created_at: new Date(NOW - 2 * HOUR).toISOString() }),
        row({ id: "out", created_at: new Date(NOW - 30 * HOUR).toISOString() }),
      ],
      "all",
      NONE,
      "24h",
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["newer", "older"]);
  });
});
