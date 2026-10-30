import { describe, expect, it } from "vitest";

import { isCampaignAbTest } from "./campaignAbTest";

describe("isCampaignAbTest", () => {
  it("is false for an ordinary campaign — the previous behaviour showed the button on everything", () => {
    expect(isCampaignAbTest({})).toBe(false);
    expect(isCampaignAbTest({ delivery_settings: {} })).toBe(false);
    expect(isCampaignAbTest(null)).toBe(false);
    expect(isCampaignAbTest(undefined)).toBe(false);
  });

  it("reads the top-level is_ab_test flag", () => {
    expect(isCampaignAbTest({ is_ab_test: true })).toBe(true);
  });

  it("reads delivery_settings.ab_test.is_parent, matching desktop", () => {
    expect(
      isCampaignAbTest({ delivery_settings: { ab_test: { is_parent: true } } }),
    ).toBe(true);
  });

  it("accepts the JSON-ish truthy encodings the gateway can emit", () => {
    expect(isCampaignAbTest({ is_ab_test: "true" })).toBe(true);
    expect(isCampaignAbTest({ is_ab_test: 1 })).toBe(true);
    expect(isCampaignAbTest({ is_ab_test: "false" })).toBe(false);
    expect(isCampaignAbTest({ is_ab_test: 0 })).toBe(false);
  });

  it("treats an enabled ab_test block as a parent", () => {
    expect(
      isCampaignAbTest({ delivery_settings: { ab_test: { enabled: true } } }),
    ).toBe(true);
  });

  it("recognises a parent that already carries its arms", () => {
    expect(isCampaignAbTest({ variants: [{}, {}] })).toBe(true);
    expect(isCampaignAbTest({ variants: [{}] })).toBe(false);
    expect(isCampaignAbTest({ variants: [] })).toBe(false);
  });

  it("survives a malformed delivery_settings payload", () => {
    expect(isCampaignAbTest({ delivery_settings: "nope" })).toBe(false);
    expect(isCampaignAbTest({ delivery_settings: { ab_test: 7 } })).toBe(false);
  });
});
