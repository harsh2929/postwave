import { describe, expect, it } from "vitest";

import { buildCreateJobDraft } from "../../components/deliverability/VerificationBulkPanel";

describe("bulk verification job draft", () => {
  it("preserves submitted duplicates while calculating the credit ceiling", () => {
    expect(
      buildCreateJobDraft(
        "inline",
        " Person@example.com,person@example.com\nother@example.com ",
        "",
      ),
    ).toEqual({
      input: {
        source: "inline",
        emails: [
          "Person@example.com",
          "person@example.com",
          "other@example.com",
        ],
      },
      error: null,
      addressCount: 3,
      uniqueCount: 2,
    });
  });

  it("builds server-resolved scopes without inventing a recipient count", () => {
    expect(buildCreateJobDraft("tag", "", "  customer  ")).toEqual({
      input: { source: "tag", source_ref: "customer" },
      error: null,
      addressCount: null,
      uniqueCount: null,
    });
    expect(buildCreateJobDraft("all_subscribers", "", "")).toEqual({
      input: { source: "all_subscribers" },
      error: null,
      addressCount: null,
      uniqueCount: null,
    });
  });

  it("rejects hidden tag controls and oversized addresses before submit", () => {
    expect(buildCreateJobDraft("tag", "", "safe\u202Eunsafe").input).toBeNull();
    expect(
      buildCreateJobDraft("inline", `${"a".repeat(321)}@example.com`, "").input,
    ).toBeNull();
  });
});
