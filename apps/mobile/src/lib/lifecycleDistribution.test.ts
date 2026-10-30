/**
 * lifecycleDistribution — parse guards + the catalog merge.
 *
 * The merge rules are the card's contract: zero stages still render (in
 * catalog order) and unknown stages are appended, never dropped — the card
 * must account for every subscriber the server counted.
 */
import { describe, expect, it } from "vitest";

import {
  buildLifecycleView,
  lifecycleRowSpokenLabel,
  lifecycleStageLabel,
  parseLifecycleDistribution,
  parseLifecycleStages,
} from "./lifecycleDistribution";

describe("parseLifecycleDistribution", () => {
  it("reads the {items} body the Go handler writes", () => {
    expect(
      parseLifecycleDistribution({
        items: [
          { stage: "lead", count: 3 },
          { stage: "customer", count: 7 },
        ],
      }),
    ).toEqual([
      { stage: "lead", count: 3 },
      { stage: "customer", count: 7 },
    ]);
  });

  it("degrades malformed bodies to an empty histogram", () => {
    expect(parseLifecycleDistribution(null)).toEqual([]);
    expect(parseLifecycleDistribution([])).toEqual([]);
    expect(parseLifecycleDistribution({ items: "nope" })).toEqual([]);
    expect(parseLifecycleDistribution({})).toEqual([]);
  });

  it("drops rows whose count is not a usable number", () => {
    expect(
      parseLifecycleDistribution({
        items: [
          { stage: "lead", count: Number.NaN },
          { stage: "mql", count: -2 },
          { stage: "sql", count: "9" },
          { stage: "customer", count: 4.9 },
        ],
      }),
    ).toEqual([{ stage: "customer", count: 4 }]);
  });
});

describe("parseLifecycleStages", () => {
  it("reads the {stages} catalog and drops non-strings", () => {
    expect(
      parseLifecycleStages({ stages: ["lead", "", 7, "customer"] }),
    ).toEqual(["lead", "customer"]);
    expect(parseLifecycleStages(undefined)).toEqual([]);
    expect(parseLifecycleStages({ stages: {} })).toEqual([]);
  });
});

describe("lifecycleStageLabel", () => {
  it("matches desktop's presentation rules", () => {
    expect(lifecycleStageLabel("")).toBe("—");
    expect(lifecycleStageLabel("mql")).toBe("MQL");
    expect(lifecycleStageLabel("sql")).toBe("SQL");
    expect(lifecycleStageLabel("lead")).toBe("Lead");
    expect(lifecycleStageLabel("customer")).toBe("Customer");
    expect(lifecycleStageLabel("some_odd_stage")).toBe("Some Odd Stage");
  });
});

describe("buildLifecycleView", () => {
  it("zero-fills catalog stages and keeps catalog order", () => {
    const view = buildLifecycleView(
      [{ stage: "customer", count: 5 }],
      ["subscriber", "lead", "customer"],
    );
    expect(view.total).toBe(5);
    expect(view.rows.map((r) => [r.stage, r.count])).toEqual([
      ["subscriber", 0],
      ["lead", 0],
      ["customer", 5],
    ]);
  });

  it("appends a distribution stage the catalog does not know", () => {
    const view = buildLifecycleView(
      [{ stage: "vip", count: 2 }],
      ["subscriber"],
    );
    expect(view.rows.map((r) => r.stage)).toEqual(["subscriber", "vip"]);
    expect(view.total).toBe(2);
  });

  it("computes pct against the total, and 0 with no subscribers", () => {
    const view = buildLifecycleView(
      [
        { stage: "lead", count: 1 },
        { stage: "customer", count: 3 },
      ],
      [],
    );
    expect(view.rows.find((r) => r.stage === "customer")?.pct).toBe(75);
    const empty = buildLifecycleView([], ["lead"]);
    expect(empty.rows[0]?.pct).toBe(0);
    expect(empty.total).toBe(0);
  });
});

describe("lifecycleRowSpokenLabel", () => {
  it("speaks label, count and rounded share", () => {
    expect(
      lifecycleRowSpokenLabel({
        stage: "customer",
        label: "Customer",
        count: 3,
        pct: 75,
      }),
    ).toBe("Customer: 3 subscribers, 75 percent");
    expect(
      lifecycleRowSpokenLabel({ stage: "lead", label: "Lead", count: 1, pct: 0 }),
    ).toBe("Lead: 1 subscriber");
  });
});
