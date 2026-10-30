// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression: the A/B editor named a new arm by POSITION —
// `LABELS[variants.length]` — instead of by what was still free. Removing a
// middle variant leaves a gap, so the next add collides:
//
//   [A, B, C] → remove B → [A, C] (length 2) → add → LABELS[2] === "C"
//   → [A, C, C]
//
// Two arms then share `variant_label`, which is identity-bearing downstream:
// ab-results-helpers resolves a pairwise operand with
// `variants.find(v => v.variant_label.toLowerCase() === operand)`, so the
// FIRST match wins and the second arm's results are reported under the first
// arm's name. The editor's own `key={idx}` hid the duplicate on screen.
//
// Duplicate had the same rule, so cloning after a removal collided too.
import { describe, expect, it } from "vitest";

import { nextVariantLabel } from "@/components/campaigns/ab-variants-editor";
import type { Variant } from "@/lib/abtests-types";

const v = (variant_label: string): Variant => ({
  variant_label,
  subject: "",
  from_name: "",
  from_email: "",
  body_mjml: "",
  weight: 50,
});

describe("nextVariantLabel", () => {
  it("appends the next letter for a contiguous set", () => {
    expect(nextVariantLabel([v("A"), v("B")])).toBe("C");
    expect(nextVariantLabel([v("A")])).toBe("B");
  });

  it("fills the gap left by removing a middle variant", () => {
    // The bug: position-based naming returned "C", colliding with the C that
    // is still present.
    expect(nextVariantLabel([v("A"), v("C")])).toBe("B");
  });

  it("never returns a label already in use", () => {
    const cases: Variant[][] = [
      [v("A"), v("C")],
      [v("B"), v("D")],
      [v("A"), v("B"), v("D")],
      [v("C")],
    ];
    for (const list of cases) {
      const next = nextVariantLabel(list);
      expect(list.map((x) => x.variant_label)).not.toContain(next);
    }
  });

  it("stays past the fixed alphabet instead of returning undefined", () => {
    const full = [v("A"), v("B"), v("C"), v("D")];
    const next = nextVariantLabel(full);
    expect(next).toBeTruthy();
    expect(full.map((x) => x.variant_label)).not.toContain(next);
  });

  it("is case-insensitive about what counts as taken", () => {
    expect(nextVariantLabel([v("a"), v("b")])).toBe("C");
  });
});
