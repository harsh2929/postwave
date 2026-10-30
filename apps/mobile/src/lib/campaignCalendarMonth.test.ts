import { describe, expect, it } from "vitest";

import type { AgendaRow } from "./campaignAgenda";
import {
  addMonths,
  buildCampaignMonth,
  inAnchorMonth,
  monthAnchor,
  scheduledRowsOnDay,
} from "./campaignCalendarMonth";

/**
 * Fixtures are built from LOCAL calendar parts (`new Date(y, m, d, h)`), never
 * from ISO literals, so every assertion holds in whatever zone CI runs in —
 * the module's whole contract is "day boundaries are local".
 */
const AUG = 7; // August (0-based), chosen because 2026-08-01 is a Saturday:
// the grid must pad with late-July days, giving scheduledInMonth
// something real to exclude.
const anchor = new Date(2026, AUG, 1).getTime();

function scheduled(y: number, m: number, d: number, h = 9): AgendaRow {
  return {
    id: `${y}-${m}-${d}-${h}`,
    status: "scheduled",
    scheduled_at: new Date(y, m, d, h).toISOString(),
  };
}

describe("monthAnchor / addMonths / inAnchorMonth", () => {
  it("anchors any instant to local midnight of the 1st", () => {
    const anchored = monthAnchor(new Date(2026, AUG, 21, 17, 45).getTime());
    expect(anchored).toBe(anchor);
    const d = new Date(anchored);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([1, 0, 0]);
  });

  it("pages across a year boundary by calendar parts", () => {
    const dec = new Date(2026, 11, 1).getTime();
    expect(addMonths(dec, 1)).toBe(new Date(2027, 0, 1).getTime());
    expect(addMonths(new Date(2026, 0, 1).getTime(), -1)).toBe(
      new Date(2025, 11, 1).getTime(),
    );
  });

  it("keeps month membership exact at both edges", () => {
    expect(inAnchorMonth(new Date(2026, AUG, 1, 0, 0).getTime(), anchor)).toBe(
      true,
    );
    expect(
      inAnchorMonth(new Date(2026, AUG, 31, 23, 59).getTime(), anchor),
    ).toBe(true);
    expect(inAnchorMonth(new Date(2026, 6, 31, 23, 59).getTime(), anchor)).toBe(
      false,
    );
  });
});

describe("buildCampaignMonth", () => {
  it("always yields six Sunday-aligned weeks", () => {
    const month = buildCampaignMonth([], anchor, anchor);
    expect(month.cells).toHaveLength(42);
    expect(new Date(month.cells[0]!.dayStart).getDay()).toBe(0);
    // 2026-08-01 is a Saturday, so the first cell is Sunday July 26.
    expect(new Date(month.cells[0]!.dayStart).getDate()).toBe(26);
    expect(month.cells[0]!.inMonth).toBe(false);
    expect(month.cells[6]!.inMonth).toBe(true); // Sat Aug 1
  });

  it("counts only scheduled rows, on their local day", () => {
    const rows: AgendaRow[] = [
      scheduled(2026, AUG, 21, 8),
      scheduled(2026, AUG, 21, 22),
      // A sent campaign has a scheduled_at in its past and is not "going out".
      { ...scheduled(2026, AUG, 21, 12), status: "sent" },
      { id: "no-date", status: "scheduled", scheduled_at: "not-a-date" },
      { id: "null-date", status: "scheduled", scheduled_at: null },
    ];
    const month = buildCampaignMonth(rows, anchor, anchor);
    const day21 = month.cells.find(
      (c) => c.inMonth && new Date(c.dayStart).getDate() === 21,
    );
    expect(day21?.count).toBe(2);
    expect(month.scheduledInMonth).toBe(2);
  });

  it("shows padding-day sends in their cell but keeps them out of the month total", () => {
    const rows = [scheduled(2026, 6, 30), scheduled(2026, AUG, 3)];
    const month = buildCampaignMonth(rows, anchor, anchor);
    const july30 = month.cells.find(
      (c) => !c.inMonth && new Date(c.dayStart).getDate() === 30,
    );
    expect(july30?.count).toBe(1);
    expect(month.scheduledInMonth).toBe(1);
  });

  it("tolerates status casing and surrounding whitespace", () => {
    const row: AgendaRow = {
      id: "x",
      status: " Scheduled ",
      scheduled_at: new Date(2026, AUG, 5, 9).toISOString(),
    };
    expect(buildCampaignMonth([row], anchor, anchor).scheduledInMonth).toBe(1);
  });

  it("marks exactly the one cell holding `now` as today", () => {
    const now = new Date(2026, AUG, 14, 16, 30).getTime();
    const month = buildCampaignMonth([], anchor, now);
    const todays = month.cells.filter((c) => c.today);
    expect(todays).toHaveLength(1);
    expect(new Date(todays[0]!.dayStart).getDate()).toBe(14);
  });
});

describe("scheduledRowsOnDay", () => {
  it("applies the identical local-day boundary the grid counted with", () => {
    const dayStart = new Date(2026, AUG, 21).getTime();
    const rows: AgendaRow[] = [
      scheduled(2026, AUG, 21, 0), // midnight, inclusive
      scheduled(2026, AUG, 21, 23),
      scheduled(2026, AUG, 22, 0), // next local day
      { ...scheduled(2026, AUG, 21, 12), status: "draft" },
    ];
    const onDay = scheduledRowsOnDay(rows, dayStart);
    expect(onDay.map((r) => r.id)).toEqual([
      rows[0]!.id,
      rows[1]!.id,
    ]);
  });
});
