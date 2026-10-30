// Tests for the email-step A/B variants editor logic
// (components/sequence/variants.ts). The rules mirror the server's
// ValidateVariants in services/voice/internal/generation/variants.go:
// 2..4 arms, unique keys, subject + body per arm, weight_bp >= 1,
// weights summing to exactly 10000 bp.

import { describe, expect, it } from "vitest";

import type { SequenceEmailVariant } from "../../lib/api-client";
import {
  VARIANT_MAX,
  VARIANT_MIN,
  VARIANT_WEIGHT_TOTAL_BP,
  type VariantDraft,
  addVariantDraft,
  bpToPctString,
  draftsToVariants,
  evenWeightsBp,
  pctStringToBp,
  removeVariantDraft,
  seedVariantDrafts,
  validateVariantDrafts,
  variantsAreValid,
  variantsToDrafts,
  weightsSumBp,
} from "../../components/sequence/variants";

function draft(overrides: Partial<VariantDraft> = {}): VariantDraft {
  return {
    key: "A",
    subject: "Hello",
    body: "Body copy",
    weight_pct: "50",
    ...overrides,
  };
}

/** A valid 2-arm split used as the baseline in several tests. */
function validPair(): VariantDraft[] {
  return [
    draft({ key: "A", weight_pct: "50" }),
    draft({ key: "B", weight_pct: "50" }),
  ];
}

/* ---------------------------------------------------------------- */
/* weight conversions                                                */
/* ---------------------------------------------------------------- */

describe("variant weight conversions", () => {
  it("bpToPctString trims trailing zeros", () => {
    expect(bpToPctString(5000)).toBe("50");
    expect(bpToPctString(3334)).toBe("33.34");
    expect(bpToPctString(2510)).toBe("25.1");
    expect(bpToPctString(1)).toBe("0.01");
  });

  it("pctStringToBp parses and rounds to basis points", () => {
    expect(pctStringToBp("50")).toBe(5000);
    expect(pctStringToBp("33.34")).toBe(3334);
    expect(pctStringToBp("  25 ")).toBe(2500);
    expect(pctStringToBp("0.01")).toBe(1);
  });

  it("pctStringToBp rejects blank and non-numeric input", () => {
    expect(pctStringToBp("")).toBeNull();
    expect(pctStringToBp("   ")).toBeNull();
    expect(pctStringToBp("abc")).toBeNull();
    expect(pctStringToBp("Infinity")).toBeNull();
  });

  it("round-trips through pct strings without losing basis points", () => {
    for (const bp of [1, 2500, 3333, 3334, 5000, 10000]) {
      expect(pctStringToBp(bpToPctString(bp))).toBe(bp);
    }
  });
});

describe("evenWeightsBp", () => {
  it("always sums to exactly 10000 with the remainder up front", () => {
    expect(evenWeightsBp(2)).toEqual([5000, 5000]);
    expect(evenWeightsBp(3)).toEqual([3334, 3333, 3333]);
    expect(evenWeightsBp(4)).toEqual([2500, 2500, 2500, 2500]);
    for (let n = 1; n <= 4; n++) {
      const sum = evenWeightsBp(n).reduce((a, b) => a + b, 0);
      expect(sum).toBe(VARIANT_WEIGHT_TOTAL_BP);
    }
  });

  it("returns empty for n < 1", () => {
    expect(evenWeightsBp(0)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- */
/* seed / add / remove                                               */
/* ---------------------------------------------------------------- */

describe("seedVariantDrafts", () => {
  it("seeds two arms from the step's current content at 50/50", () => {
    const seeded = seedVariantDrafts("Subj", "Body", "<p>Body</p>");
    expect(seeded).toHaveLength(2);
    expect(seeded[0]).toMatchObject({
      key: "A",
      subject: "Subj",
      body: "Body",
      body_html: "<p>Body</p>",
      weight_pct: "50",
    });
    expect(seeded[1].key).toBe("B");
    expect(validateVariantDrafts(seeded)).toBeNull();
  });
});

describe("addVariantDraft / removeVariantDraft", () => {
  it("add appends the next positional key and re-evens weights", () => {
    const three = addVariantDraft(validPair());
    expect(three.map((d) => d.key)).toEqual(["A", "B", "C"]);
    expect(weightsSumBp(three)).toBe(VARIANT_WEIGHT_TOTAL_BP);
    const four = addVariantDraft(three.map((d) => ({ ...d, subject: "s", body: "b" })));
    expect(four.map((d) => d.key)).toEqual(["A", "B", "C", "D"]);
    expect(weightsSumBp(four)).toBe(VARIANT_WEIGHT_TOTAL_BP);
  });

  it("add is a no-op at the 4-arm cap", () => {
    let drafts = validPair();
    drafts = addVariantDraft(addVariantDraft(drafts));
    expect(drafts).toHaveLength(VARIANT_MAX);
    expect(addVariantDraft(drafts)).toBe(drafts);
  });

  it("remove relabels the remaining arms and re-evens weights", () => {
    const three = addVariantDraft(validPair());
    const after = removeVariantDraft(three, 0);
    expect(after.map((d) => d.key)).toEqual(["A", "B"]);
    expect(weightsSumBp(after)).toBe(VARIANT_WEIGHT_TOTAL_BP);
  });

  it("remove is a no-op at the 2-arm floor and for bad indexes", () => {
    const pair = validPair();
    expect(removeVariantDraft(pair, 0)).toBe(pair);
    const three = addVariantDraft(pair);
    expect(removeVariantDraft(three, 9)).toBe(three);
    expect(removeVariantDraft(three, -1)).toBe(three);
  });
});

/* ---------------------------------------------------------------- */
/* validation (mirrors the server's ValidateVariants)                */
/* ---------------------------------------------------------------- */

describe("validateVariantDrafts", () => {
  it("accepts a valid 2-arm 50/50 split", () => {
    expect(validateVariantDrafts(validPair())).toBeNull();
  });

  it("rejects fewer than 2 arms", () => {
    expect(validateVariantDrafts([draft()])).toMatch(
      new RegExp(`at least ${VARIANT_MIN}`),
    );
  });

  it("rejects more than 4 arms", () => {
    const five = ["A", "B", "C", "D", "E"].map((k) =>
      draft({ key: k, weight_pct: "20" }),
    );
    expect(validateVariantDrafts(five)).toMatch(
      new RegExp(`At most ${VARIANT_MAX}`),
    );
  });

  it("requires a subject on every arm", () => {
    const drafts = validPair();
    drafts[1] = { ...drafts[1], subject: "   " };
    expect(validateVariantDrafts(drafts)).toBe("Variant B: subject is required.");
  });

  it("requires a body (plain OR carried-through html) on every arm", () => {
    const drafts = validPair();
    drafts[0] = { ...drafts[0], body: "" };
    expect(validateVariantDrafts(drafts)).toBe("Variant A: body is required.");
    // body_html alone satisfies the server's body-or-body_html rule.
    drafts[0] = { ...drafts[0], body_html: "<p>html</p>" };
    expect(validateVariantDrafts(drafts)).toBeNull();
  });

  it("rejects unparsable and sub-1bp weights", () => {
    const blank = validPair();
    blank[0] = { ...blank[0], weight_pct: "" };
    expect(validateVariantDrafts(blank)).toBe("Variant A: weight must be a number.");
    const zero = validPair();
    zero[0] = { ...zero[0], weight_pct: "0" };
    expect(validateVariantDrafts(zero)).toBe(
      "Variant A: weight must be at least 0.01%.",
    );
  });

  it("rejects weights that don't total exactly 100%", () => {
    const drafts = [
      draft({ key: "A", weight_pct: "60" }),
      draft({ key: "B", weight_pct: "50" }),
    ];
    expect(validateVariantDrafts(drafts)).toBe(
      "Variant weights must total 100% (currently 110%).",
    );
  });
});

/* ---------------------------------------------------------------- */
/* wire conversions                                                  */
/* ---------------------------------------------------------------- */

describe("draftsToVariants / variantsToDrafts", () => {
  it("converts valid drafts to basis-point wire variants", () => {
    const out = draftsToVariants(validPair());
    expect(out).toEqual([
      { key: "A", subject: "Hello", body: "Body copy", weight_bp: 5000 },
      { key: "B", subject: "Hello", body: "Body copy", weight_bp: 5000 },
    ]);
  });

  it("returns null for invalid drafts instead of a partial split", () => {
    const drafts = validPair();
    drafts[0] = { ...drafts[0], weight_pct: "99" };
    expect(draftsToVariants(drafts)).toBeNull();
  });

  it("omits body_html on the wire when blank, keeps it when set", () => {
    const withHtml = validPair().map((d) => ({ ...d, body_html: "<p>x</p>" }));
    expect(draftsToVariants(withHtml)?.[0].body_html).toBe("<p>x</p>");
    const blankHtml = validPair().map((d) => ({ ...d, body_html: "  " }));
    expect(draftsToVariants(blankHtml)?.[0]).not.toHaveProperty("body_html");
  });

  it("round-trips stored variants through the editor draft shape", () => {
    const stored: SequenceEmailVariant[] = [
      { key: "A", subject: "S1", body: "B1", weight_bp: 3334 },
      { key: "B", subject: "S2", body: "B2", weight_bp: 3333 },
      { key: "C", subject: "S3", body: "B3", weight_bp: 3333 },
    ];
    expect(draftsToVariants(variantsToDrafts(stored))).toEqual(stored);
  });
});

/* ---------------------------------------------------------------- */
/* stored-variant validity gate (canvas persist guard)               */
/* ---------------------------------------------------------------- */

describe("variantsAreValid", () => {
  const valid: SequenceEmailVariant[] = [
    { key: "A", subject: "S", body: "B", weight_bp: 5000 },
    { key: "B", subject: "S", body: "B", weight_bp: 5000 },
  ];

  it("treats absent / empty variants as valid (no A/B test)", () => {
    expect(variantsAreValid(undefined)).toBe(true);
    expect(variantsAreValid([])).toBe(true);
  });

  it("accepts a server-valid split", () => {
    expect(variantsAreValid(valid)).toBe(true);
  });

  it("rejects splits outside 2..4 arms", () => {
    expect(variantsAreValid([valid[0]])).toBe(false);
    const five = ["A", "B", "C", "D", "E"].map((k) => ({
      key: k,
      subject: "S",
      body: "B",
      weight_bp: 2000,
    }));
    expect(variantsAreValid(five)).toBe(false);
  });

  it("rejects duplicate keys case-insensitively (server rule)", () => {
    expect(
      variantsAreValid([
        { key: "A", subject: "S", body: "B", weight_bp: 5000 },
        { key: "a", subject: "S", body: "B", weight_bp: 5000 },
      ]),
    ).toBe(false);
  });

  it("rejects missing subject/body, non-integer or sub-1 weights, and bad sums", () => {
    expect(
      variantsAreValid([{ ...valid[0], subject: " " }, valid[1]]),
    ).toBe(false);
    expect(
      variantsAreValid([{ ...valid[0], body: "" }, valid[1]]),
    ).toBe(false);
    expect(
      variantsAreValid([{ ...valid[0], weight_bp: 0.5 }, valid[1]]),
    ).toBe(false);
    expect(
      variantsAreValid([{ ...valid[0], weight_bp: 4999 }, valid[1]]),
    ).toBe(false);
  });

  it("accepts body_html-only arms (body may be empty)", () => {
    expect(
      variantsAreValid([
        { key: "A", subject: "S", body: "", body_html: "<p>x</p>", weight_bp: 5000 },
        valid[1],
      ]),
    ).toBe(true);
  });
});
