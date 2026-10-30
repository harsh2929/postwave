// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCampaign, listCampaigns } from "@/lib/campaigns-api";
import {
  applyMailchimpLocalClosures,
  cancelDelivery,
  convertVideoForEmail,
  createAccountExport,
  createBatch,
  createCompatResource,
  generateCreativeAssistant,
  getAccountExports,
  getAdvancedSegmentSchema,
  getAgencyEcosystem,
  getAudienceInsights,
  getBatches,
  getCampaignInbox,
  getCampaignPlanner,
  getCampaignReport,
  getClickMap,
  getConnectedSites,
  getContentStudio,
  getCustomReport,
  getDeliveryInsights,
  getIntegrationMarketplace,
  getLandingPageParity,
  getMailchimpBlockCatalog,
  getMailchimpCompatSummary,
  getMailchimpLocalClosures,
  getMailchimpParityWorkbench,
  getMultiChannelReadiness,
  getMultivariateTest,
  getSendDayOptimization,
  getSendTimeOptimization,
  getSurveys,
  getVerifiedDomains,
  getWebsiteBuilderStatus,
  listCompatResources,
  pauseJourney,
  previewMailchimpTemplate,
  recordCampaignEvent,
  resumeJourney,
  syncDemoCommerce,
} from "@/lib/mailchimp-compat-api";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.get,
      post: mocks.post,
    },
  };
});

vi.mock("@/lib/mock-mode", () => ({ isMockModeEnabled: () => false }));

function expectBoundedOptions(value: unknown, signal: AbortSignal) {
  expect(value).toMatchObject({
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue([]);
  mocks.post.mockResolvedValue({});
});

describe("Mailchimp compatibility authority transport options", () => {
  it("forwards bounded cancellation through compatibility campaign reads and creation", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await listCampaigns({ limit: 10 }, options);
    await createCampaign(
      {
        name: "Compatibility seed",
        subject: "Welcome",
        body_html: "<p>Welcome</p>",
      },
      options,
    );

    expectBoundedOptions(mocks.get.mock.calls[0]?.[1], controller.signal);
    expectBoundedOptions(mocks.post.mock.calls[0]?.[2], controller.signal);
  });

  // The New campaign dialog calls createCampaign(input) with no options, and
  // that branch used to fall back to the default transport: three attempts at
  // 15 s each for a POST that carries no server-side idempotency.
  it("keeps a campaign create single-attempt and online-only without caller options", async () => {
    await createCampaign({ name: "Dialog create", subject: "Welcome" });

    expect(mocks.post.mock.calls[0]?.[2]).toMatchObject({
      requireOnline: true,
      maxAttempts: 1,
    });
  });

  it("makes every compatibility overview read abortable, online-only, and single-attempt", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await getMailchimpCompatSummary(options);
    await listCompatResources("groups", options);
    await getCampaignReport("campaign-1", options);
    await getCampaignPlanner(options);
    await getMultivariateTest("campaign-1", options);
    await getSendTimeOptimization("campaign-1", options);
    await getSendDayOptimization("campaign-1", options);
    await getClickMap("campaign-1", options);
    await getCustomReport(undefined, options);
    await getDeliveryInsights("campaign-1", options);
    await getCampaignInbox("campaign-1", options);
    await getMultiChannelReadiness(options);
    await getSurveys(options);
    await getLandingPageParity(options);
    await getWebsiteBuilderStatus(options);
    await getAudienceInsights(options);
    await getAdvancedSegmentSchema(options);
    await getContentStudio(options);
    await getMailchimpBlockCatalog(options);
    await getBatches(options);
    await getAccountExports(options);
    await getConnectedSites(options);
    await getVerifiedDomains(options);
    await getIntegrationMarketplace(options);
    await getAgencyEcosystem(options);
    await getMailchimpParityWorkbench(options);
    await getMailchimpLocalClosures(options);

    expect(mocks.get).toHaveBeenCalledTimes(27);
    for (const call of mocks.get.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
  });

  it("makes every compatibility demo mutation abortable, online-only, single-attempt, and eligible for shared idempotency", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await createCompatResource("groups", { name: "Interests" }, options);
    await cancelDelivery("campaign-1", options);
    await createBatch({ operations: [] }, options);
    await createAccountExport({ sections: ["audiences"] }, options);
    await applyMailchimpLocalClosures(options);
    await generateCreativeAssistant({ goal: "Welcome" }, options);
    await convertVideoForEmail({ url: "https://example.test/video" }, options);
    await previewMailchimpTemplate({ html: "<p>*|FNAME|*</p>" }, options);
    await recordCampaignEvent(
      "campaign-1",
      { subscriber_email: "person@example.test", event_type: "opened" },
      options,
    );
    await pauseJourney("journey-1", options);
    await resumeJourney("journey-1", options);
    await syncDemoCommerce("commerce-1", options);

    expect(mocks.post).toHaveBeenCalledTimes(12);
    for (const call of mocks.post.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
      // The shared transport mints one Idempotency-Key for every POST unless a
      // caller explicitly opts out; these clients intentionally do not.
      expect(call.at(-1)).not.toMatchObject({ idempotencyKey: null });
    }
  });
});
