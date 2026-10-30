// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { ABResultsVariant } from "@/lib/ab-results-api";
import { comparisonLabel } from "../app/(dashboard)/app/campaigns/[id]/ab-results/ab-results-helpers";

const variants: ABResultsVariant[] = [
  {
    id: "var_a",
    variant_index: 0,
    variant_label: "A",
    sent: 100,
    hits: 40,
    rate: 0.4,
    is_control: true,
  },
  {
    id: "var_b",
    variant_index: 1,
    variant_label: "B",
    sent: 100,
    hits: 48,
    rate: 0.48,
    is_control: false,
  },
];

describe("comparisonLabel", () => {
  it("maps a numeric index key to variant labels and flags the control", () => {
    expect(comparisonLabel("1_vs_0", variants)).toBe("B vs A (control)");
  });

  it("maps a label-based key", () => {
    expect(comparisonLabel("B_vs_A", variants)).toBe("B vs A (control)");
  });

  it("maps an id-based key", () => {
    expect(comparisonLabel("var_b:var_a", variants)).toBe("B vs A (control)");
  });

  it("does not append (control) when the right operand is not the control", () => {
    expect(comparisonLabel("0_vs_1", variants)).toBe("A vs B");
  });

  it("falls back to the raw key when it can't be split into two operands", () => {
    expect(comparisonLabel("overall", variants)).toBe("overall");
  });

  it("renders stable Variant N labels for out-of-range numeric operands", () => {
    expect(comparisonLabel("2_vs_0", variants)).toBe("Variant 3 vs A (control)");
  });
});
