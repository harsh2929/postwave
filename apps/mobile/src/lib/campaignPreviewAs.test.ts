import { describe, expect, it } from "vitest";

import {
  campaignPreviewAsProblem,
  campaignPreviewAsReading,
  campaignRegionRows,
  campaignRegionsSummary,
} from "./campaignPreviewAs";

describe("campaignRegionRows", () => {
  it("flattens nested regions in document order, keeping depth", () => {
    const rows = campaignRegionRows({
      regions: [
        {
          key: "IS_VIP",
          true_branch: "<p>Thanks for being a VIP</p>",
          has_else: true,
          children: [{ key: "HAS_ORDER", true_branch: "<p>Your order</p>" }],
        },
        { key: "IN_EU", true_branch: "<p>EU terms</p>" },
      ],
    });

    expect(rows.map((r) => [r.key, r.depth])).toEqual([
      ["IS_VIP", 0],
      ["HAS_ORDER", 1],
      ["IN_EU", 0],
    ]);
  });

  it("gives nested regions distinct ids even when they share a key", () => {
    const rows = campaignRegionRows({
      regions: [
        { key: "IS_VIP", children: [{ key: "IS_VIP" }] },
        { key: "IS_VIP" },
      ],
    });
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it("renders a one-line plain-text sample of the true branch", () => {
    const rows = campaignRegionRows({
      regions: [
        {
          key: "IS_VIP",
          true_branch: "<div><h1>Welcome back</h1><p>Second line</p></div>",
        },
      ],
    });
    expect(rows[0]?.sample).toBe("Welcome back");
  });

  it("drops keyless regions rather than rendering an anonymous row", () => {
    expect(campaignRegionRows({ regions: [{ key: "  " }, {}] })).toEqual([]);
  });

  it("is bounded, so a generated body cannot produce an unbounded list", () => {
    const regions = Array.from({ length: 100 }, (_, i) => ({ key: `K${i}` }));
    expect(campaignRegionRows({ regions }, 10)).toHaveLength(10);
  });

  it("survives a missing or malformed response", () => {
    expect(campaignRegionRows(null)).toEqual([]);
    expect(campaignRegionRows({})).toEqual([]);
  });
});

describe("campaignRegionsSummary", () => {
  it("says plainly when there is nothing conditional", () => {
    expect(campaignRegionsSummary([])).toContain(
      "every recipient receives the same body",
    );
  });

  it("names the count and points at the resolution path", () => {
    const summary = campaignRegionsSummary([
      { id: "a", key: "A", depth: 0, hasElse: false, sample: "" },
    ]);
    expect(summary).toContain("1 conditional region.");
    expect(summary).toContain("merges every branch");
  });
});

describe("campaignPreviewAsReading", () => {
  it("renders the resolved body as readable plain text", () => {
    const reading = campaignPreviewAsReading({
      subscriber_email: "ada@example.com",
      body_html: "<p>Hi Ada</p><p>Your order shipped</p>",
    });
    expect(reading.email).toBe("ada@example.com");
    expect(reading.text).toBe("Hi Ada\nYour order shipped");
    expect(reading.caveat).toBeNull();
  });

  it("names every region that fell back to the default branch", () => {
    const reading = campaignPreviewAsReading({
      subscriber_email: "ada@example.com",
      body_html: "<p>Hi</p>",
      unresolved_regions: ["IS_VIP", "IN_SEGMENT"],
    });
    // Without this the preview silently claims to be what the subscriber
    // receives, when two of its branches were guessed.
    expect(reading.caveat).toContain("2 regions");
    expect(reading.caveat).toContain("IS_VIP, IN_SEGMENT");
    expect(reading.caveat).toContain("may differ");
  });

  it("ignores empty entries in unresolved_regions", () => {
    expect(
      campaignPreviewAsReading({
        body_html: "<p>Hi</p>",
        unresolved_regions: ["", "   "],
      }).caveat,
    ).toBeNull();
  });

  it("degrades to empty rather than throwing on a missing body", () => {
    const reading = campaignPreviewAsReading(null);
    expect(reading.text).toBe("");
    expect(reading.email).toBe("");
  });
});

describe("campaignPreviewAsProblem", () => {
  it("keeps the two 404s apart — only one of them is worth retyping", () => {
    expect(
      campaignPreviewAsProblem(404, "subscriber_not_found", "subscriber not found"),
    ).toContain("No subscriber in this workspace has that address");
    expect(campaignPreviewAsProblem(404, "not_found", "campaign not found")).toBe(
      "This campaign no longer exists.",
    );
  });

  it("reads a bare 404 with no code as the campaign being gone", () => {
    expect(campaignPreviewAsProblem(404, undefined, "not found")).toBe(
      "This campaign no longer exists.",
    );
  });

  it("asks for the missing input instead of echoing a validation code", () => {
    expect(
      campaignPreviewAsProblem(400, "missing_subscriber", "required"),
    ).toContain("Enter the email address");
  });

  it("classifies permission and capability separately", () => {
    expect(campaignPreviewAsProblem(403, undefined, "no")).toContain(
      "permission",
    );
    expect(campaignPreviewAsProblem(501, undefined, "no")).toContain(
      "isn't available on this workspace yet",
    );
  });

  it("keeps an unexpected server message visible", () => {
    expect(campaignPreviewAsProblem(500, undefined, "boom")).toContain("boom");
    expect(campaignPreviewAsProblem(0, undefined, "  ")).toBe(
      "Couldn't render the preview.",
    );
  });
});
