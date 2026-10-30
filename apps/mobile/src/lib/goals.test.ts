import { describe, expect, it } from "vitest";

import {
  goalBarFraction,
  goalMetricLabel,
  goalPaceLabel,
  parseGoalProgress,
} from "./goals";

function row(overrides: Record<string, unknown> = {}) {
  return {
    goal: {
      id: "g-1",
      name: "Q3 subscribers",
      metric: "subscribers",
      target: 1000,
      period: "quarterly",
      ...(overrides.goal as Record<string, unknown> | undefined),
    },
    current: 812,
    target: 1000,
    pct: 0.812,
    pace: "on_track",
    period_end: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

describe("parseGoalProgress", () => {
  it("reads the server envelope", () => {
    const parsed = parseGoalProgress({ progress: [row()], as_of: "now" });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "g-1",
      name: "Q3 subscribers",
      metric: "subscribers",
      current: 812,
      target: 1000,
      pct: 0.812,
      pace: "on_track",
      periodEnd: "2026-09-30T00:00:00Z",
    });
  });

  it("drops a goal it cannot state honestly rather than showing 0% of 0", () => {
    // A goal rendered at "0% of 0" is a fabricated status report about a
    // number the operator is actually being measured on.
    const parsed = parseGoalProgress({
      progress: [
        row({ current: "many" }),
        row({ goal: { id: "g-2", metric: "vibes", target: 10 } }),
        row({ goal: { id: "g-3", metric: "subscribers", target: 0 }, target: 0 }),
        row({ goal: { id: "", metric: "subscribers", target: 10 } }),
        null,
        "nope",
      ],
    });
    expect(parsed).toEqual([]);
  });

  it("falls back to the metric label when the goal is unnamed", () => {
    const parsed = parseGoalProgress({
      progress: [row({ goal: { id: "g-9", metric: "open_rate", target: 30, name: "  " } })],
    });
    expect(parsed[0]?.name).toBe("Open rate");
  });

  it("recomputes pct when the server omitted it, rather than drawing an empty bar", () => {
    const parsed = parseGoalProgress({
      progress: [row({ pct: undefined, current: 250, target: 1000 })],
    });
    expect(parsed[0]?.pct).toBeCloseTo(0.25);
  });

  it("does not invent a pace verdict it was not given", () => {
    const parsed = parseGoalProgress({ progress: [row({ pace: "vibing" })] });
    expect(parsed[0]?.pace).toBe("on_track");
  });

  it("returns an empty list for a shape it does not recognise", () => {
    expect(parseGoalProgress(null)).toEqual([]);
    expect(parseGoalProgress({ progress: "soon" })).toEqual([]);
    expect(parseGoalProgress([row()])).toEqual([]);
  });
});

describe("goalBarFraction", () => {
  it("clamps the BAR at full while the caller keeps the number", () => {
    // A workspace at 140% of target should see a full bar AND "140%".
    expect(goalBarFraction(1.4)).toBe(1);
    expect(goalBarFraction(0.25)).toBe(0.25);
    expect(goalBarFraction(-3)).toBe(0);
    expect(goalBarFraction(Number.NaN)).toBe(0);
  });
});

describe("labels", () => {
  it("names every metric and pace", () => {
    expect(goalMetricLabel("revenue_cents")).toBe("Revenue");
    expect(goalMetricLabel("list_growth")).toBe("List growth");
    expect(goalPaceLabel("behind")).toBe("Behind pace");
    expect(goalPaceLabel("ahead")).toBe("Ahead of pace");
    expect(goalPaceLabel("on_track")).toBe("On track");
  });
});
