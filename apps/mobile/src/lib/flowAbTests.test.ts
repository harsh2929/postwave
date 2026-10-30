import { describe, expect, it } from "vitest";

import {
  parseFlowAbResults,
  parseFlowAbTest,
  parseFlowAbTestList,
  parseFlowAbWinner,
} from "./flowAbTests";

/**
 * A real `List` item, field for field as `flowabtests.ABTest` marshals it
 * (flowabtests.go:45-54).
 */
const WIRE_TEST = {
  id: "ab-1",
  automation_id: "aut-9",
  node_id: "split-checkout",
  status: "running",
  variants: [
    { id: "v-control", label: "Control", percentage: 50, next: "n2" },
    { id: "v-b", label: "Discount", percentage: 50, next: "n3" },
  ],
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-20T09:00:00Z",
};

describe("parseFlowAbTest", () => {
  it("reads the shape the Go handler actually writes", () => {
    const test = parseFlowAbTest(WIRE_TEST);
    expect(test).not.toBeNull();
    expect(test!.id).toBe("ab-1");
    expect(test!.automationID).toBe("aut-9");
    expect(test!.nodeID).toBe("split-checkout");
    expect(test!.variants.map((v) => v.label)).toEqual(["Control", "Discount"]);
    expect(test!.variants[0]!.percentage).toBe(50);
    expect(test!.winner).toBeNull();
  });

  it("names an unlabelled variant by its id, not by an invented ordinal", () => {
    // `label` is `omitempty`; the id is what the counters key on, so it is the
    // only honest thing to show.
    const test = parseFlowAbTest({
      ...WIRE_TEST,
      variants: [{ id: "v-1" }, { id: "v-2", label: "" }],
    });
    expect(test!.variants.map((v) => v.label)).toEqual(["v-1", "v-2"]);
  });

  it("drops a variant with no id — it can never join to a counter row", () => {
    const test = parseFlowAbTest({
      ...WIRE_TEST,
      variants: [{ label: "Ghost" }, { id: "v-1" }],
    });
    expect(test!.variants).toHaveLength(1);
  });

  it("returns null for a row with no id and for non-objects", () => {
    expect(parseFlowAbTest({ node_id: "x" })).toBeNull();
    expect(parseFlowAbTest(null)).toBeNull();
    expect(parseFlowAbTest([WIRE_TEST])).toBeNull();
  });

  it("passes an unknown status through instead of coercing it", () => {
    expect(parseFlowAbTest({ ...WIRE_TEST, status: "draining" })!.status).toBe(
      "draining",
    );
  });
});

describe("parseFlowAbTestList", () => {
  it("reads the {items} envelope List actually writes", () => {
    expect(parseFlowAbTestList({ items: [WIRE_TEST] })).toHaveLength(1);
  });

  it("answers an empty list for every non-envelope, never throws", () => {
    expect(parseFlowAbTestList({ results: [WIRE_TEST] })).toEqual([]);
    expect(parseFlowAbTestList([WIRE_TEST])).toEqual([]);
    expect(parseFlowAbTestList(null)).toEqual([]);
  });
});

describe("parseFlowAbWinner", () => {
  it("reads a recorded verdict", () => {
    const winner = parseFlowAbWinner({
      variant_id: "v-b",
      conversion_rate: 0.0812,
      p_value: 0.0031,
      significant: true,
      method: "two_proportion_z",
      evaluated_at: "2026-07-19T12:00:00Z",
    });
    expect(winner).toEqual({
      variantID: "v-b",
      conversionRate: 0.0812,
      pValue: 0.0031,
      significant: true,
      inconclusive: false,
      method: "two_proportion_z",
      evaluatedAt: "2026-07-19T12:00:00Z",
    });
  });

  it("is null for an evaluation that names no variant", () => {
    // `evaluateWinner` over zero results returns a verdict whose VariantID is
    // "" — an evaluation that measured nothing is not a verdict.
    expect(
      parseFlowAbWinner({ inconclusive: true, method: "two_proportion_z" }),
    ).toBeNull();
    expect(parseFlowAbWinner(null)).toBeNull();
  });
});

describe("parseFlowAbResults", () => {
  it("reads the {results} envelope and keeps the rate a FRACTION", () => {
    const rows = parseFlowAbResults({
      results: [
        { variant_id: "v-control", assigned: 400, converted: 20, conversion_rate: 0.05 },
      ],
    });
    expect(rows).toHaveLength(1);
    // 0.05 must stay 0.05. Treating it as a percentage renders 5% as 0.05%,
    // and treating a 0.5 as a percent renders half a percent as 50% — the bug
    // components/abtest/ResultsCard.tsx carries a comment about.
    expect(rows[0]!.conversionRate).toBe(0.05);
    expect(rows[0]!.assigned).toBe(400);
  });

  it("answers an empty list when the node has no counters yet", () => {
    // `Results` re-reads the test and aggregates on (automation_id, node_id);
    // a node nobody has entered answers [] rather than an error.
    expect(parseFlowAbResults({ results: [] })).toEqual([]);
    expect(parseFlowAbResults({})).toEqual([]);
    expect(parseFlowAbResults(null)).toEqual([]);
  });

  it("truncates a non-integer count rather than rendering 3.5 assignments", () => {
    const rows = parseFlowAbResults({
      results: [{ variant_id: "v", assigned: 3.9, converted: 1.2 }],
    });
    expect(rows[0]!.assigned).toBe(3);
    expect(rows[0]!.converted).toBe(1);
  });
});
