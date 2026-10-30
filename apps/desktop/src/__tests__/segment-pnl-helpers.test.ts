// Tests for the pure logic behind the Segment P&L panel + compare view
// (feature #4). These guard the honest-UI contract: a null lift / null
// AOV / null CLV ratio / null net contribution must format to an
// explicit "not configured" / "not available" / null — never a
// fabricated 0% or $0 that would read as a real measurement. The compare
// ranking must be deterministic (ties + nulls) so the "winner" badge is
// reproducible.

import { describe, expect, it } from "vitest";

import {
  colourForNetContribution,
  compareRank,
  fmtCLVRatio,
  fmtLift,
  fmtMoneyCents,
  fmtNetContribution,
} from "../lib/segment-pnl-helpers";

describe("fmtMoneyCents", () => {
  it("formats a known ISO currency", () => {
    expect(fmtMoneyCents(1250, "USD")).toBe("$12.50");
  });
  it("falls back to plain code form for blank/unknown currency", () => {
    expect(fmtMoneyCents(1250, "")).toBe("12.50");
    expect(fmtMoneyCents(1250, "ZZZ")).toBe("ZZZ 12.50");
  });
  it("renders an em dash for null/non-finite", () => {
    expect(fmtMoneyCents(null, "USD")).toBe("—");
    expect(fmtMoneyCents(Number.NaN, "USD")).toBe("—");
  });
});

describe("fmtNetContribution", () => {
  it("prefixes + on positive and a real minus on negative", () => {
    expect(fmtNetContribution(1250, "USD")).toBe("+$12.50/member");
    expect(fmtNetContribution(-300, "USD")).toBe("−$3.00/member");
  });
  it("never prefixes + on zero", () => {
    expect(fmtNetContribution(0, "USD")).toBe("$0.00/member");
  });
  it("null → honest 'not available' (no fabricated $0)", () => {
    expect(fmtNetContribution(null, "USD")).toBe("not available");
    expect(fmtNetContribution(undefined, "USD")).toBe("not available");
  });
});

describe("colourForNetContribution", () => {
  it("maps positive→success, negative→danger", () => {
    expect(colourForNetContribution(50)).toBe("var(--pw-success)");
    expect(colourForNetContribution(-50)).toBe("var(--pw-danger)");
  });
  it("null / zero → muted (never colour a figure we don't have)", () => {
    expect(colourForNetContribution(null)).toBe("var(--pw-fg-muted)");
    expect(colourForNetContribution(0)).toBe("var(--pw-fg-muted)");
    expect(colourForNetContribution(Number.NaN)).toBe("var(--pw-fg-muted)");
  });
});

describe("fmtLift", () => {
  it("formats a positive lift", () => {
    expect(fmtLift({ lift_percent: 8.34 })).toEqual({
      label: "↑ 8.3% incremental lift",
      direction: "up",
    });
  });
  it("formats a negative lift honestly", () => {
    const out = fmtLift({ lift_percent: -4.2 });
    expect(out.direction).toBe("down");
    expect(out.label).toContain("4.2%");
    expect(out.label).toContain("negative");
  });
  it("zero lift → 'no incremental lift detected'", () => {
    expect(fmtLift({ lift_percent: 0 })).toEqual({
      label: "no incremental lift detected",
      direction: "flat",
    });
  });
  it("missing lift → 'holdout not configured'", () => {
    expect(fmtLift(null)).toEqual({
      label: "holdout not configured",
      direction: "none",
    });
  });
  it("too-large skip reason is surfaced honestly", () => {
    expect(fmtLift(null, "segment_too_large_for_in_process_lift")).toEqual({
      label: "segment too large for in-process lift",
      direction: "none",
    });
  });
});

describe("fmtCLVRatio", () => {
  it("null predicted → null (caller renders 'no data')", () => {
    expect(fmtCLVRatio(null)).toBeNull();
    expect(fmtCLVRatio(undefined)).toBeNull();
    expect(fmtCLVRatio(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it("ratio >= 1 → 'realised X% of predicted'", () => {
    expect(fmtCLVRatio(1.2)).toBe("realised 120% of predicted");
    expect(fmtCLVRatio(1)).toBe("realised 100% of predicted");
  });
  it("ratio < 1 → marks (under)", () => {
    expect(fmtCLVRatio(0.6)).toBe("realised 60% of predicted (under)");
  });
});

describe("compareRank", () => {
  it("sorts by net/member desc and assigns 1..N rank", () => {
    const out = compareRank([
      { segment_id: "a", member_count: 10, net_contribution_per_member_cents: 100 },
      { segment_id: "b", member_count: 20, net_contribution_per_member_cents: 300 },
      { segment_id: "c", member_count: 30, net_contribution_per_member_cents: 200 },
    ]);
    expect(out.map((r) => r.segment_id)).toEqual(["b", "c", "a"]);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(out.find((r) => r.segment_id === "b")?.isWinner).toBe(true);
    expect(out.filter((r) => r.isWinner)).toHaveLength(1);
  });
  it("breaks ties deterministically by segment_id ascending", () => {
    const out = compareRank([
      { segment_id: "z", member_count: 1, net_contribution_per_member_cents: 50 },
      { segment_id: "a", member_count: 1, net_contribution_per_member_cents: 50 },
    ]);
    expect(out.map((r) => r.segment_id)).toEqual(["a", "z"]);
    expect(out[0].isWinner).toBe(true);
  });
  it("sorts null net contribution last and never crowns a null winner", () => {
    const out = compareRank([
      { segment_id: "a", member_count: 1, net_contribution_per_member_cents: null },
      { segment_id: "b", member_count: 1, net_contribution_per_member_cents: null },
    ]);
    // Deterministic order even when all null.
    expect(out.map((r) => r.segment_id)).toEqual(["a", "b"]);
    expect(out.some((r) => r.isWinner)).toBe(false);
  });
  it("a real figure outranks a null one", () => {
    const out = compareRank([
      { segment_id: "a", member_count: 1, net_contribution_per_member_cents: null },
      { segment_id: "b", member_count: 1, net_contribution_per_member_cents: -10 },
    ]);
    expect(out[0].segment_id).toBe("b");
    expect(out[0].isWinner).toBe(true);
    expect(out[1].segment_id).toBe("a");
  });
  it("handles a single segment", () => {
    const out = compareRank([
      { segment_id: "only", member_count: 5, net_contribution_per_member_cents: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rank).toBe(1);
    expect(out[0].isWinner).toBe(true); // zero is a real figure
  });
});
