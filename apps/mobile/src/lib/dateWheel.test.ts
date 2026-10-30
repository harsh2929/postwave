import { describe, expect, it } from "vitest";

import {
  DATE_WHEEL_BASE_HEIGHT,
  DATE_WHEEL_DAYS,
  dateWheelHeight,
  startOfDay,
  wheelDateOptions,
  wheelMinuteOptions,
  wheelScrollOffset,
} from "./dateWheel";

const TODAY = new Date(2026, 6, 26, 14, 30, 0, 0);

describe("wheelDateOptions", () => {
  it("reaches six months out instead of the old 31-day window", () => {
    const options = wheelDateOptions(TODAY, TODAY);
    expect(options).toHaveLength(DATE_WHEEL_DAYS);
    expect(options[0]?.getTime()).toBe(startOfDay(TODAY).getTime());
  });

  it("always contains the selected day, even beyond the window", () => {
    const far = new Date(2027, 5, 1, 9, 0, 0, 0);
    const options = wheelDateOptions(TODAY, far);
    // Without this, opening the sheet on a campaign scheduled a year out
    // snapped it into the window — and Save wrote the snapped date.
    expect(
      options.some((d) => d.getTime() === startOfDay(far).getTime()),
    ).toBe(true);
    expect(options.at(-1)?.getTime()).toBe(startOfDay(far).getTime());
  });

  it("keeps a past selection at the START, so the list stays chronological", () => {
    const past = new Date(2026, 5, 1, 9, 0, 0, 0);
    const options = wheelDateOptions(TODAY, past);
    expect(options[0]?.getTime()).toBe(startOfDay(past).getTime());
    expect(options[1]?.getTime()).toBe(startOfDay(TODAY).getTime());
  });

  it("does not duplicate a selection already inside the window", () => {
    const soon = new Date(2026, 6, 30, 8, 0, 0, 0);
    const options = wheelDateOptions(TODAY, soon);
    expect(options).toHaveLength(DATE_WHEEL_DAYS);
    expect(
      options.filter((d) => d.getTime() === startOfDay(soon).getTime()),
    ).toHaveLength(1);
  });

  it("stays chronological across the whole list", () => {
    const options = wheelDateOptions(TODAY, new Date(2028, 0, 1), 10);
    for (let i = 1; i < options.length; i++) {
      expect(options[i]!.getTime()).toBeGreaterThan(options[i - 1]!.getTime());
    }
  });
});

describe("wheelMinuteOptions", () => {
  it("offers the tappable 5-minute grid", () => {
    expect(wheelMinuteOptions(0)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it("inserts an off-grid minute so a desktop-set time survives a round trip", () => {
    const options = wheelMinuteOptions(7);
    expect(options).toContain(7);
    expect(options.indexOf(7)).toBe(2); // between 5 and 10
  });

  it("ignores an impossible minute rather than corrupting the column", () => {
    expect(wheelMinuteOptions(60)).toHaveLength(12);
    expect(wheelMinuteOptions(-1)).toHaveLength(12);
    expect(wheelMinuteOptions(Number.NaN)).toHaveLength(12);
  });
});

describe("wheelScrollOffset", () => {
  it("centres the selected row in the viewport", () => {
    // row 10 of 46pt in a 200pt viewport: 460 - (200-46)/2 = 383
    expect(wheelScrollOffset(10, 46, 200, 24)).toBe(383);
  });

  it("never scrolls above the top or past the end of the content", () => {
    expect(wheelScrollOffset(0, 46, 200, 24)).toBe(0);
    expect(wheelScrollOffset(1, 46, 200, 24)).toBe(0);
    const last = wheelScrollOffset(23, 46, 200, 24);
    expect(last).toBe(24 * 46 - 200);
  });

  it("returns 0 rather than NaN before the rows have been measured", () => {
    expect(wheelScrollOffset(5, 0, 200, 24)).toBe(0);
    expect(wheelScrollOffset(Number.NaN, 46, 200, 24)).toBe(0);
    expect(wheelScrollOffset(5, Number.NaN, 200, 24)).toBe(0);
  });
});

describe("dateWheelHeight", () => {
  it("keeps the default height at the default text size", () => {
    expect(dateWheelHeight(1)).toBe(DATE_WHEEL_BASE_HEIGHT);
    expect(dateWheelHeight(undefined)).toBe(DATE_WHEEL_BASE_HEIGHT);
  });

  it("grows with the OS text size so rows are not clipped", () => {
    expect(dateWheelHeight(1.3)).toBe(260);
  });

  it("stops growing before the picker outgrows the sheet", () => {
    expect(dateWheelHeight(3)).toBe(320);
  });

  it("never shrinks below the base for a sub-1 scale", () => {
    expect(dateWheelHeight(0.8)).toBe(DATE_WHEEL_BASE_HEIGHT);
  });
});
