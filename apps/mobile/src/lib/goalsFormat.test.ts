import { describe, expect, it } from "vitest";

import { formatGoalPosition, formatGoalValue } from "./goalsFormat";

describe("formatGoalValue", () => {
  it("renders an open-rate target as a percentage, not a 2,400% ratio", () => {
    // The server returns open_rate in PERCENT units (0..100). Feeding 24 to a
    // ratio formatter is the single most likely way to get this wrong, and it
    // does not look like a bug — it looks like a confident number.
    expect(formatGoalValue("open_rate", 24)).toBe("24.0%");
    expect(formatGoalValue("open_rate", 100)).toBe("100.0%");
  });

  it("converts revenue from cents and never hardcodes a dollar", () => {
    expect(formatGoalValue("revenue_cents", 250_000)).toBe("$2,500");
    expect(formatGoalValue("revenue_cents", 250_000, { currency: "EUR" })).toBe(
      "€2,500",
    );
  });

  it("renders counts as grouped integers", () => {
    expect(formatGoalValue("subscribers", 12_481)).toBe("12,481");
    expect(formatGoalValue("list_growth", 148.6)).toBe("149");
  });
});

describe("formatGoalPosition", () => {
  it("states both sides in the metric's own unit", () => {
    expect(formatGoalPosition("subscribers", 812, 1000)).toBe("812 of 1,000");
    expect(formatGoalPosition("open_rate", 24, 30)).toBe("24.0% of 30.0%");
    expect(formatGoalPosition("revenue_cents", 125_000, 500_000)).toBe(
      "$1,250 of $5,000",
    );
  });
});
