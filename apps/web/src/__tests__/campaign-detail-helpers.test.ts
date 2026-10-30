import { describe, expect, it } from "vitest";

import {
  asCSV,
  asNumber,
  asString,
  blockSummary,
  blocksOf,
  CAMPAIGN_TYPES,
  defaultBlock,
  EDITOR_MODES,
  isTruthy,
  labelize,
  variantsOf,
} from "../app/(dashboard)/app/campaigns/[id]/campaign-detail-helpers";

describe("campaign detail helpers", () => {
  it("keeps campaign type and editor mode option lists in the expected order", () => {
    expect(CAMPAIGN_TYPES).toEqual([
      "regular",
      "plain_text",
      "ab_test",
      "rss",
      "automated",
      "transactional",
    ]);
    expect(EDITOR_MODES).toEqual(["blocks", "html", "plain_text", "mjml"]);
  });

  it("creates sensible default blocks with caller patches applied last", () => {
    expect(defaultBlock("heading")).toEqual({
      type: "heading",
      content: "New headline",
    });
    expect(defaultBlock("button", { label: "Shop", url: "/sale" })).toEqual({
      type: "button",
      label: "Shop",
      url: "/sale",
    });
    for (const type of ["button", "product", "discount_code", "survey", "rss"]) {
      expect(JSON.stringify(defaultBlock(type))).not.toContain("example.com");
    }
    expect(defaultBlock("unknown")).toEqual({
      type: "text",
      content: "Write your campaign copy.",
    });
  });

  it("coerces loose campaign-editor values without throwing", () => {
    expect(asString(null, "fallback")).toBe("fallback");
    expect(asString(42)).toBe("42");
    expect(asNumber("12.5", 0)).toBe(12.5);
    expect(asNumber("not-a-number", 7)).toBe(7);
    expect(asCSV(["A", 2, null], "fallback")).toBe("A, 2, ");
    expect(asCSV(undefined, "fallback")).toBe("fallback");
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy("true")).toBe(true);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy("1")).toBe(false);
    expect(labelize("product_recommendations")).toBe("Product Recommendations");
  });

  it("reads optional blocks, variants, and reusable-section summaries defensively", () => {
    expect(
      blocksOf({
        content_blocks: [{ type: "text" }],
      } as unknown as Parameters<typeof blocksOf>[0]),
    ).toEqual([{ type: "text" }]);
    expect(
      variantsOf({
        variants: [{ name: "A" }],
      } as unknown as Parameters<typeof variantsOf>[0]),
    ).toEqual([{ name: "A" }]);
    expect(
      blockSummary([
        { content: "Hero" },
        { heading: "Fallback heading" },
        { content: "" },
      ] as Parameters<typeof blockSummary>[0]),
    ).toBe("Hero\nFallback heading");
  });
});
