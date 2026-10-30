import { describe, expect, it } from "vitest";

import { decodeCampaignTemplateCompareResponse } from "../../lib/api/campaign-template-discovery";

function item(id: string) {
  return {
    requested_identifier: id,
    matched_by: "id",
    template: {
      id,
      slug: id,
      name: `Template ${id}`,
      subject: "Monthly update",
    },
  };
}

describe("campaign template comparison response", () => {
  it("accepts partial comparisons with explicit unavailable identifiers", () => {
    expect(
      decodeCampaignTemplateCompareResponse({
        items: [item("template-a")],
        unavailable_identifiers: ["template-b"],
      }),
    ).toEqual({
      items: [item("template-a")],
      unavailable_identifiers: ["template-b"],
    });
  });

  it("rejects missing, duplicated, or out-of-bounds availability accounting", () => {
    expect(
      decodeCampaignTemplateCompareResponse({
        items: [item("template-a"), item("template-b")],
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateCompareResponse({
        items: [item("template-a")],
        unavailable_identifiers: ["template-a"],
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplateCompareResponse({
        items: [],
        unavailable_identifiers: ["only-one"],
      }),
    ).toBeNull();
  });
});
