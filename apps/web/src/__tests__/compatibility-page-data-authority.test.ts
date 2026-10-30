// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  listResources: vi.fn(),
  listCampaigns: vi.fn(),
  optional: vi.fn(),
}));

vi.mock("@/lib/campaigns-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns-api")>()),
  listCampaigns: mocks.listCampaigns,
}));

vi.mock("@/lib/mailchimp-compat-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mailchimp-compat-api")>();
  return {
    ...actual,
    getMailchimpCompatSummary: mocks.summary,
    listCompatResources: mocks.listResources,
    getMultiChannelReadiness: mocks.optional,
    getSurveys: mocks.optional,
    getLandingPageParity: mocks.optional,
    getWebsiteBuilderStatus: mocks.optional,
    getAudienceInsights: mocks.optional,
    getAdvancedSegmentSchema: mocks.optional,
    getContentStudio: mocks.optional,
    getMailchimpBlockCatalog: mocks.optional,
    getBatches: mocks.optional,
    getAccountExports: mocks.optional,
    getConnectedSites: mocks.optional,
    getVerifiedDomains: mocks.optional,
    getIntegrationMarketplace: mocks.optional,
    getAgencyEcosystem: mocks.optional,
    getMailchimpParityWorkbench: mocks.optional,
    getCampaignPlanner: mocks.optional,
    getCustomReport: mocks.optional,
  };
});

import { loadCompatibilityPageData } from "@/app/(dashboard)/app/compatibility/compatibility-page-data";

const SUMMARY = {
  contacts: {
    total: 0,
    by_mailchimp_status: {},
    groups: 0,
    activity_events: 0,
  },
  campaigns: { total: 0, by_type: {}, assets: 0, reusable_sections: 0 },
  reports: { events: 0, reportable_campaigns: 0 },
  automations: { total: 0, by_status: {} },
  growth: { landing_pages: 0, popups: 0, views: 0, conversions: 0 },
  ecommerce: {
    integrations: 0,
    customers: 0,
    products: 0,
    orders: 0,
    revenue_cents: 0,
    attributed_revenue_cents: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary.mockResolvedValue(SUMMARY);
  mocks.listResources.mockResolvedValue([]);
  mocks.listCampaigns.mockResolvedValue([]);
  mocks.optional.mockResolvedValue(null);
});

describe("compatibility page-data authority routing", () => {
  it("retains viewer-safe reads while issuing zero admin-only collection requests", async () => {
    const controller = new AbortController();
    const data = await loadCompatibilityPageData({
      includeAdmin: false,
      signal: controller.signal,
    });

    expect(mocks.listResources.mock.calls.map(([path]) => path)).toEqual([
      "groups",
      "assets",
      "sections",
    ]);
    expect(data.adminOnlyUnavailable).toEqual([
      "Automations",
      "Landing pages",
      "Popups",
      "Ecommerce integrations",
    ]);
    expect(mocks.summary).toHaveBeenCalledWith({ signal: controller.signal });
    expect(mocks.listCampaigns).toHaveBeenCalledWith(
      { limit: 10 },
      { signal: controller.signal },
    );
  });

  it("loads the four admin collections only for a resolved admin", async () => {
    const data = await loadCompatibilityPageData({ includeAdmin: true });

    expect(mocks.listResources.mock.calls.map(([path]) => path)).toEqual([
      "groups",
      "assets",
      "sections",
      "automations",
      "landing-pages",
      "popups",
      "ecommerce/integrations",
    ]);
    expect(data.adminOnlyUnavailable).toEqual([]);
  });

  it("propagates a 403 instead of folding it into an empty optional result", async () => {
    mocks.optional.mockRejectedValueOnce(new ApiError("forbidden", 403));

    await expect(
      loadCompatibilityPageData({ includeAdmin: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
