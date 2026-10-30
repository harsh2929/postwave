import { describe, expect, it } from "vitest";

import {
  GOAL_METRICS,
  clampFraction,
  formatGoalPct,
  formatGoalValue,
  formatPeriodRange,
  goalMetricLabel,
  goalTargetToInput,
  paceBadge,
  parseGoalTargetInput,
} from "../../components/dashboard/goals-helpers";

describe("GOAL_METRICS", () => {
  it("covers exactly the server's metric whitelist", () => {
    expect(GOAL_METRICS.map((m) => m.value)).toEqual([
      "subscribers",
      "open_rate",
      "revenue_cents",
      "list_growth",
    ]);
  });
});

describe("goalMetricLabel", () => {
  it("labels known metrics", () => {
    expect(goalMetricLabel("revenue_cents")).toBe("Revenue");
    expect(goalMetricLabel("open_rate")).toBe("Open rate");
  });
  it("passes unknown metrics through verbatim (honest, no guessing)", () => {
    expect(goalMetricLabel("clicks")).toBe("clicks");
  });
});

describe("formatGoalValue", () => {
  it("counts render as locale integers", () => {
    expect(formatGoalValue("subscribers", 12345)).toBe("12,345");
    expect(formatGoalValue("list_growth", 250.4)).toBe("250");
  });
  it("open_rate is PERCENT units from the server — no re-scaling", () => {
    // progress.go multiplies by 100; 42.5 means 42.5%.
    expect(formatGoalValue("open_rate", 42.5)).toBe("42.5%");
  });
  it("revenue_cents renders as dollars with cents", () => {
    expect(formatGoalValue("revenue_cents", 500000)).toBe("$5,000.00");
    expect(formatGoalValue("revenue_cents", 99)).toBe("$0.99");
  });
  it("non-finite values render an em-dash", () => {
    expect(formatGoalValue("subscribers", NaN)).toBe("—");
  });
});

describe("parseGoalTargetInput", () => {
  it("revenue: dollars in, cents out", () => {
    expect(parseGoalTargetInput("revenue_cents", "5000")).toEqual({
      target: 500000,
    });
    expect(parseGoalTargetInput("revenue_cents", "$1,234.56")).toEqual({
      target: 123456,
    });
    expect(parseGoalTargetInput("revenue_cents", "0.005")).toEqual({
      target: 1,
    });
  });
  it("open_rate: percent number, 0 < x ≤ 100", () => {
    expect(parseGoalTargetInput("open_rate", "45")).toEqual({ target: 45 });
    expect(parseGoalTargetInput("open_rate", "45.5%")).toEqual({
      target: 45.5,
    });
    expect(parseGoalTargetInput("open_rate", "150")).toEqual({
      error: "Open-rate target can't exceed 100%.",
    });
  });
  it("counts must be positive whole numbers", () => {
    expect(parseGoalTargetInput("subscribers", "1,000")).toEqual({
      target: 1000,
    });
    expect(parseGoalTargetInput("subscribers", "10.5")).toEqual({
      error: "Target must be a whole number.",
    });
  });
  it("rejects empty / non-numeric / non-positive input", () => {
    expect(parseGoalTargetInput("subscribers", "  ")).toEqual({
      error: "Enter a target.",
    });
    expect(parseGoalTargetInput("subscribers", "abc")).toEqual({
      error: "Target must be a number.",
    });
    expect(parseGoalTargetInput("subscribers", "-5")).toEqual({
      error: "Target must be greater than zero.",
    });
    expect(parseGoalTargetInput("revenue_cents", "0")).toEqual({
      error: "Target must be greater than zero.",
    });
  });
});

describe("goalTargetToInput (edit-modal prefill, inverse of parse)", () => {
  it("revenue cents → dollars string", () => {
    expect(goalTargetToInput("revenue_cents", 500000)).toBe("5000");
    expect(goalTargetToInput("revenue_cents", 123456)).toBe("1234.56");
  });
  it("other metrics pass through", () => {
    expect(goalTargetToInput("subscribers", 1000)).toBe("1000");
    expect(goalTargetToInput("open_rate", 45.5)).toBe("45.5");
  });
  it("round-trips through parseGoalTargetInput", () => {
    const prefill = goalTargetToInput("revenue_cents", 123456);
    expect(parseGoalTargetInput("revenue_cents", prefill)).toEqual({
      target: 123456,
    });
  });
});

describe("paceBadge", () => {
  it("maps the three server pace values", () => {
    expect(paceBadge("ahead")).toEqual({
      label: "Ahead",
      className: "badge success",
    });
    expect(paceBadge("on_track")).toEqual({
      label: "On track",
      className: "badge",
    });
    expect(paceBadge("behind")).toEqual({
      label: "Behind",
      className: "badge warning",
    });
  });
  it("unknown pace renders verbatim with neutral styling", () => {
    expect(paceBadge("weird")).toEqual({ label: "weird", className: "badge" });
  });
});

describe("formatPeriodRange", () => {
  it("same-year window puts the year once", () => {
    expect(
      formatPeriodRange(
        "2026-06-01T00:00:00Z",
        "2026-06-30T00:00:00Z",
        "en-US",
      ),
    ).toBe("Jun 1 – Jun 30, 2026");
  });
  it("keeps inclusive UTC period endpoints on their server calendar dates", () => {
    expect(
      formatPeriodRange(
        "2026-07-01T00:00:00Z",
        "2026-07-31T23:59:59Z",
        "en-US",
      ),
    ).toBe("Jul 1 – Jul 31, 2026");
  });
  it("cross-year window carries both years", () => {
    const s = formatPeriodRange(
      "2026-12-01T12:00:00Z",
      "2027-01-31T12:00:00Z",
      "en-US",
    );
    expect(s).toContain("2026");
    expect(s).toContain("2027");
  });
  it("invalid dates yield empty string (caller hides the chip)", () => {
    expect(formatPeriodRange("nope", "2026-06-30T00:00:00Z")).toBe("");
  });
});

describe("clampFraction / formatGoalPct", () => {
  it("clamps bar width to 0..1 but pct text overshoots honestly", () => {
    expect(clampFraction(1.2)).toBe(1);
    expect(clampFraction(-0.1)).toBe(0);
    expect(clampFraction(0.42)).toBe(0.42);
    expect(formatGoalPct(1.2)).toBe("120%");
    expect(formatGoalPct(0.426)).toBe("43%");
    expect(formatGoalPct(NaN)).toBe("0%");
  });
});
