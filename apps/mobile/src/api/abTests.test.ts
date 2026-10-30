import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createABTestCampaign,
  getABResults,
  type ABTestCreateInput,
} from "./abTests";

const mocks = vi.hoisted(() => ({
  rawRequest: vi.fn(),
}));

vi.mock("./request", () => ({
  rawRequest: mocks.rawRequest,
}));

describe("mobile A/B test API helpers", () => {
  beforeEach(() => {
    mocks.rawRequest.mockReset();
  });

  it("posts the exact create payload to the governed A/B endpoint", async () => {
    const input: ABTestCreateInput = {
      name: "Subject line test",
      subject_variants: ["Control", "Variant"],
      audience_list_id: "list_123",
      body_html: "<p>Hello</p>",
      plain_text: "Hello",
      split_percentage: 50,
    };
    const response = {
      parent: { id: "cmp_parent", name: "Subject line test" },
      children: [{ id: "cmp_child", subject: "Variant" }],
    };
    mocks.rawRequest.mockResolvedValueOnce({ data: response, error: null });

    await expect(createABTestCampaign(input)).resolves.toEqual({
      data: response,
      error: null,
    });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/campaigns/ab-test",
      input,
    );
  });

  it("fails closed when create succeeds without a parent campaign", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: { children: [{ id: "cmp_child" }] },
      error: null,
    });

    await expect(
      createABTestCampaign({
        name: "Broken response",
        subject_variants: ["A", "B"],
      }),
    ).resolves.toEqual({
      data: null,
      error: { status: 0, message: "ab-test create returned no parent" },
    });
  });

  it("encodes campaign id and metric when reading results", async () => {
    const result = {
      campaign_id: "cmp/with spaces",
      metric: "reply_rate",
      variants: [],
      frequentist: {},
      bayesian: {},
      bonferroni: {
        num_comparisons: 0,
        family_alpha: 0.05,
        corrected_alpha: 0.05,
        applied_to_frequentist: true,
      },
    };
    mocks.rawRequest.mockResolvedValueOnce({ data: result, error: null });

    await expect(getABResults("cmp/with spaces", "reply_rate")).resolves.toEqual(
      {
        data: result,
        error: null,
      },
    );
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/campaigns/cmp%2Fwith%20spaces/ab-results?metric=reply_rate",
    );
  });
});
