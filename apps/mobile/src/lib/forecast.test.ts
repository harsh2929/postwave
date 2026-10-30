import { describe, expect, it } from "vitest";

import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  MIN_FORECAST_POINTS,
  forecastNextMilestone,
  nextRoundMilestone,
} from "./forecast";

const TODAY = new Date("2026-07-01T00:00:00.000Z");

describe("nextRoundMilestone", () => {
  it("returns the next rung strictly above the current total", () => {
    expect(nextRoundMilestone(0)).toBe(100);
    expect(nextRoundMilestone(100)).toBe(250);
    expect(nextRoundMilestone(999)).toBe(1_000);
    expect(nextRoundMilestone(1_000)).toBe(2_500);
  });

  it("runs out rather than inventing a rung", () => {
    expect(nextRoundMilestone(10_000_000)).toBeNull();
    expect(nextRoundMilestone(Number.NaN)).toBeNull();
  });
});

describe("forecastNextMilestone", () => {
  it("projects the crossing date from a steady positive trend", () => {
    // 10 adds/day, 950 subscribers → 50 to go → ~5 days.
    const forecast = forecastNextMilestone(
      Array.from({ length: 14 }, () => 10),
      950,
      TODAY,
    );
    expect(forecast).not.toBeNull();
    expect(forecast?.target).toBe(1_000);
    expect(forecast?.daysAway).toBe(5);
    expect(forecast?.crossesAt.toISOString().slice(0, 10)).toBe("2026-07-06");
  });

  it("refuses a series too short to be a trend", () => {
    // The single most important gate: six days through a launch spike
    // extrapolates to a million subscribers by Christmas.
    expect(MIN_FORECAST_POINTS).toBe(7);
    expect(
      forecastNextMilestone(
        Array.from({ length: MIN_FORECAST_POINTS - 1 }, () => 40),
        950,
        TODAY,
      ),
    ).toBeNull();
  });

  it("does not forecast shrinkage", () => {
    // A declining workspace gets NO strip rather than a date it will cross a
    // milestone it is moving away from.
    const declining = [30, 25, 20, 15, 10, 5, 2, 1, 0, 0];
    expect(forecastNextMilestone(declining, 950, TODAY)).toBeNull();
    expect(
      forecastNextMilestone(Array.from({ length: 10 }, () => 0), 950, TODAY),
    ).toBeNull();
  });

  it("stays silent past the horizon instead of naming a date years out", () => {
    // 1 add/day against a 5,000-subscriber gap is ~14 years.
    expect(
      forecastNextMilestone(
        Array.from({ length: 30 }, () => 1),
        5_000,
        TODAY,
      ),
    ).toBeNull();
    expect(DEFAULT_FORECAST_HORIZON_DAYS).toBe(180);
  });

  it("returns null rather than NaN on a corrupt series", () => {
    const corrupt = [5, 5, 5, Number.NaN, 5, 5, 5, 5];
    expect(forecastNextMilestone(corrupt, 950, TODAY)).toBeNull();
    expect(
      forecastNextMilestone(Array.from({ length: 10 }, () => 5), Number.NaN),
    ).toBeNull();
  });

  it("has nothing to project once the ladder is exhausted", () => {
    expect(
      forecastNextMilestone(
        Array.from({ length: 10 }, () => 500),
        10_000_000,
        TODAY,
      ),
    ).toBeNull();
  });
});
