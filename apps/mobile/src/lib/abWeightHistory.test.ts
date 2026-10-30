import { describe, expect, it } from "vitest";

import {
  EMPTY_WEIGHT_HISTORY,
  readWeightHistory,
  weightDriftSummary,
  weightsLookFractional,
} from "./abWeightHistory";

const T0 = "2026-07-01T09:00:00Z";
const T1 = "2026-07-01T10:00:00Z";
const T2 = "2026-07-01T11:00:00Z";

describe("readWeightHistory", () => {
  it("returns the empty reading for absent / malformed payloads", () => {
    expect(readWeightHistory(null)).toEqual(EMPTY_WEIGHT_HISTORY);
    expect(readWeightHistory(undefined)).toEqual(EMPTY_WEIGHT_HISTORY);
    expect(readWeightHistory({})).toEqual(EMPTY_WEIGHT_HISTORY);
    expect(readWeightHistory({ series: "nope" })).toEqual(
      EMPTY_WEIGHT_HISTORY,
    );
    expect(readWeightHistory({ series: [] })).toEqual(EMPTY_WEIGHT_HISTORY);
  });

  it("scales fractional weights to percent once, for every arm", () => {
    const r = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 0.5 },
            { at: T1, weight: 0.3 },
          ],
        },
        {
          variant_id: "b",
          label: "B",
          points: [
            { at: T0, weight: 0.5 },
            { at: T1, weight: 0.7 },
          ],
        },
      ],
    });
    expect(r.scaledFromFraction).toBe(true);
    expect(r.series[0]?.values).toEqual([50, 30]);
    expect(r.series[1]?.values).toEqual([50, 70]);
  });

  it("leaves percentage weights alone", () => {
    const r = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 50 },
            { at: T1, weight: 30 },
          ],
        },
      ],
    });
    expect(r.scaledFromFraction).toBe(false);
    expect(r.series[0]?.values).toEqual([50, 30]);
  });

  it("builds one shared axis and holds a ragged arm's gap as null", () => {
    // The bug this guards: zipping by INDEX would put arm B's T2 weight at
    // the T1 tick, inventing a crossover that never happened.
    const r = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 60 },
            { at: T1, weight: 55 },
            { at: T2, weight: 40 },
          ],
        },
        {
          variant_id: "b",
          label: "B",
          points: [
            { at: T0, weight: 40 },
            { at: T2, weight: 60 },
          ],
        },
      ],
    });
    expect(r.ticks).toHaveLength(3);
    expect(r.ticks).toEqual([...r.ticks].sort((x, y) => x - y));
    expect(r.series[0]?.values).toEqual([60, 55, 40]);
    expect(r.series[1]?.values).toEqual([40, null, 60]);
  });

  it("drops unusable points instead of poisoning the scale", () => {
    const r = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 60 },
            { at: "not-a-date", weight: 10 },
            { at: T1, weight: null },
            { at: T2, weight: -5 },
            { at: T1, weight: 40 },
          ],
        },
      ],
    });
    expect(r.ticks).toHaveLength(2);
    expect(r.series[0]?.values).toEqual([60, 40]);
  });

  it("labels an unlabelled arm rather than rendering an empty legend", () => {
    const r = readWeightHistory({
      series: [
        { variant_id: "a", label: "  ", points: [{ at: T0, weight: 100 }] },
        { points: [{ at: T0, weight: 100 }] },
      ],
    });
    expect(r.series[0]?.label).toBe("Variant 1");
    expect(r.series[1]?.label).toBe("Variant 2");
    expect(r.series[1]?.id).toBe("arm-1");
  });

  it("only reports drift once an arm has two recorded points", () => {
    const single = readWeightHistory({
      series: [
        { variant_id: "a", label: "A", points: [{ at: T0, weight: 50 }] },
        { variant_id: "b", label: "B", points: [{ at: T0, weight: 50 }] },
      ],
    });
    expect(single.drifted).toBe(false);

    const moved = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 50 },
            { at: T1, weight: 20 },
          ],
        },
      ],
    });
    expect(moved.drifted).toBe(true);
  });
});

describe("weightsLookFractional", () => {
  it("is false for an empty set and for anything above 1", () => {
    expect(weightsLookFractional([])).toBe(false);
    expect(weightsLookFractional([0.5, 1.2])).toBe(false);
    expect(weightsLookFractional([50, 50])).toBe(false);
  });
  it("is true when nothing exceeds 1", () => {
    expect(weightsLookFractional([0.5, 0.5])).toBe(true);
    expect(weightsLookFractional([1, 0])).toBe(true);
  });
});

describe("weightDriftSummary", () => {
  it("is null when there is no drift to describe", () => {
    expect(weightDriftSummary(EMPTY_WEIGHT_HISTORY)).toBeNull();
  });

  it("reads the LAST recorded value per arm, skipping trailing gaps", () => {
    const r = readWeightHistory({
      series: [
        {
          variant_id: "a",
          label: "A",
          points: [
            { at: T0, weight: 50 },
            { at: T1, weight: 29 },
          ],
        },
        {
          variant_id: "b",
          label: "B",
          points: [
            { at: T0, weight: 50 },
            { at: T2, weight: 71 },
          ],
        },
      ],
    });
    const summary = weightDriftSummary(r);
    expect(summary).toContain("B 71%");
    expect(summary).toContain("A 29%");
    // Ranked, so the sentence names the arm actually taking the traffic.
    expect(summary).toContain("B is taking the largest share");
  });
});
