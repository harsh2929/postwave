/**
 * subscriberDemographics — SUB-063 presentation honesty.
 *
 * The rules under test: a trait the model never inferred renders as NOTHING
 * (inventing an "unknown" row overstates what the workspace knows), the
 * confidence label always rides with the value, and interests arrays are
 * joined while junk degrades to text/omission.
 */
import { describe, expect, it } from "vitest";

import { parseDemographics } from "./subscriberDemographics";

describe("parseDemographics", () => {
  it("keeps only inferred traits, in canonical order, confidence attached", () => {
    const rows = parseDemographics({
      gender: { value: "female", confidence: 0.62, source: "model_v3" },
      age_group: null, // never inferred → no row
      interests: { value: ["cycling", "jazz"], confidence: 0.4 },
    });
    expect(rows.map((r) => r.key)).toEqual(["gender", "interests"]);
    expect(rows[0]).toEqual({
      key: "gender",
      label: "Gender",
      value: "female",
      confidence: "62% confidence",
      source: "model_v3",
    });
    expect(rows[1]!.value).toBe("cycling, jazz");
  });

  it("omits the confidence label when the model reported none", () => {
    const rows = parseDemographics({
      age_group: { value: "25-34" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confidence).toBe("");
  });

  it("clamps out-of-range confidence into a percentage", () => {
    const rows = parseDemographics({
      gender: { value: "male", confidence: 1.7 },
    });
    expect(rows[0]!.confidence).toBe("100% confidence");
  });

  it("returns [] for junk payloads and traits with empty values", () => {
    expect(parseDemographics(null)).toEqual([]);
    expect(parseDemographics("x")).toEqual([]);
    expect(
      parseDemographics({ gender: { value: "" }, interests: { value: [] } }),
    ).toEqual([]);
  });
});
