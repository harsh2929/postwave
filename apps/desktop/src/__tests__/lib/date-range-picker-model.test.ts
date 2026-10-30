import { describe, expect, it } from "vitest";

import {
  addMonths,
  buildMonthGrid,
  calendarKeyboardTarget,
  dateRangePopoverPosition,
  fromIsoDate,
  normalizeRange,
  toIsoDate,
} from "../../components/analytics/date-range-picker-model";

describe("date range picker model", () => {
  it("validates local calendar dates and preserves month-end intent", () => {
    expect(fromIsoDate("2026-02-29")).toBeNull();
    expect(fromIsoDate("2024-02-29")).not.toBeNull();
    expect(fromIsoDate("2026-2-09")).toBeNull();
    expect(toIsoDate(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(toIsoDate(addMonths(new Date(2024, 0, 31), 1))).toBe("2024-02-29");
  });

  it("implements the Monday-first calendar keyboard contract", () => {
    const friday = new Date(2026, 6, 10);
    const target = (key: string, shiftKey = false): string | null => {
      const date = calendarKeyboardTarget(friday, key, shiftKey);
      return date ? toIsoDate(date) : null;
    };
    expect(target("ArrowLeft")).toBe("2026-07-09");
    expect(target("ArrowRight")).toBe("2026-07-11");
    expect(target("ArrowUp")).toBe("2026-07-03");
    expect(target("ArrowDown")).toBe("2026-07-17");
    expect(target("Home")).toBe("2026-07-06");
    expect(target("End")).toBe("2026-07-12");
    expect(target("PageUp")).toBe("2026-06-10");
    expect(target("PageDown", true)).toBe("2027-07-10");
    expect(target("Enter")).toBeNull();
  });

  it("keeps each month to one unique set of interactive in-month dates", () => {
    const grid = buildMonthGrid(new Date(2026, 6, 1), new Date(2026, 6, 10));
    const interactive = grid.filter((cell) => cell.inMonth);
    expect(grid).toHaveLength(42);
    expect(interactive).toHaveLength(31);
    expect(new Set(interactive.map((cell) => cell.iso)).size).toBe(31);
    expect(interactive.find((cell) => cell.iso === "2026-07-10")?.isToday).toBe(
      true,
    );
  });

  it("clamps below and above placement within the 440 by 280 proxy", () => {
    const below = dateRangePopoverPosition(
      { bottom: 60, left: 360, right: 420, top: 32 },
      440,
      280,
    );
    expect(below).toEqual({ left: 8, top: 66, width: 424, maxHeight: 206 });
    expect(below.left + below.width).toBeLessThanOrEqual(432);
    expect(below.top + below.maxHeight).toBeLessThanOrEqual(272);

    const above = dateRangePopoverPosition(
      { bottom: 270, left: 360, right: 420, top: 242 },
      440,
      280,
    );
    expect(above.top).toBe(8);
    expect(above.maxHeight).toBe(228);
    expect(above.top + above.maxHeight).toBeLessThan(242);
    expect(normalizeRange("2026-07-20", "2026-07-10")).toEqual({
      from: "2026-07-10",
      to: "2026-07-20",
    });
  });
});
