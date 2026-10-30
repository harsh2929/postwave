import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createArchiveReferralOperationsMethods,
  parseArchiveListResponse,
  type ArchiveReferralOperationsDependencies,
  type ArchiveReferralRequester,
  type ArchiveReferralRequestOptions,
  type ReferralMilestone,
} from "../../lib/api/archive-referral-operations";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: ArchiveReferralRequestOptions | undefined;
}

const METHOD_NAMES = [
  "listArchive",
  "publishCampaignArchive",
  "listPaywallTiers",
  "upsertPaywallTier",
  "deactivatePaywallTier",
  "unpublishCampaignArchive",
  "getArchiveStats",
  "pinArchive",
  "unpinArchive",
  "getArchiveRelatedPreview",
  "getArchiveRelatedOverrides",
  "setArchiveRelatedOverrides",
  "getArchiveIssuePreview",
  "getArchiveTenantSettings",
  "putArchiveTenantSettings",
  "getArchiveCustomDomain",
  "verifyArchiveCustomDomain",
  "deleteArchiveCustomDomain",
  "getReferralProgram",
  "getReferralStats",
  "listReferralPayouts",
  "updateReferralPayout",
  "creditReferral",
  "setReferralProgram",
  "getSubscriberReferral",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: ArchiveReferralRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: ArchiveReferralRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: ArchiveReferralOperationsDependencies = { request };
  return {
    calls,
    methods: createArchiveReferralOperationsMethods(dependencies),
  };
}

describe("archive and referral operations API extraction contracts", () => {
  it("strictly decodes canonical and legacy archive list envelopes", () => {
    const issue = {
      slug: "launch",
      subject: "Launch",
      excerpt: "What shipped",
      publishedAt: "2026-07-26T08:00:00Z",
      pinned: true,
      campaignId: "00000000-0000-4000-8000-000000000002",
      viewCount: 0,
      uniqueVisitors: 12,
    };

    expect(
      parseArchiveListResponse({
        items: [issue],
        nextCursor: "next",
      }),
    ).toEqual({ items: [issue], nextCursor: "next" });
    expect(parseArchiveListResponse([issue])).toEqual({ items: [issue] });
    expect(parseArchiveListResponse({ results: [issue] })).toEqual({
      items: [issue],
    });
  });

  it("rejects malformed archive projections before they reach the renderer", () => {
    expect(() =>
      parseArchiveListResponse({
        items: [
          {
            slug: "launch",
            subject: "Launch",
            excerpt: "",
            publishedAt: "not-a-date",
          },
        ],
      }),
    ).toThrow("invalid core projection");
    expect(() =>
      parseArchiveListResponse({
        items: [
          {
            slug: "launch",
            subject: "Launch",
            excerpt: "",
            publishedAt: "2026-07-26T08:00:00Z",
            viewCount: Number.NaN,
          },
        ],
      }),
    ).toThrow("non-negative integer");
    expect(() =>
      parseArchiveListResponse({ items: {}, nextCursor: 42 }),
    ).toThrow("items must be an array");
  });

  it("retains the exact ordered 25-method inventory without eager work", () => {
    const { calls, methods } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
  });

  it("preserves archive publishing, paywall, stats, and pin transports", async () => {
    const { calls, methods } = createHarness();
    const publishInput = {
      slug: "launch/one",
      excerpt: "Launch summary",
      metaDescription: null,
      ogImage: "https://cdn.example.test/og.png",
      heroImage: null,
      authorName: "Ada",
      canonicalUrl: null,
    };
    const tierInput = {
      id: "tier/one",
      name: "Founding members",
      description: "Early access",
      stripePriceId: "price/one",
      active: true,
    };

    await methods.listArchive({ cursor: "cursor/one", limit: 25 });
    await methods.publishCampaignArchive("campaign/one", publishInput);
    await methods.listPaywallTiers();
    await methods.upsertPaywallTier(tierInput);
    await methods.deactivatePaywallTier("tier/one");
    await methods.unpublishCampaignArchive("campaign/one");
    await methods.getArchiveStats();
    await methods.pinArchive("campaign/one");
    await methods.unpinArchive("campaign/one");

    const campaign = "/api/v1/campaigns/campaign%2Fone";
    expect(calls).toEqual([
      {
        path: "/api/v1/archive?cursor=cursor%2Fone&limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: `${campaign}/publish-archive`,
        init: {
          method: "POST",
          body: JSON.stringify({
            slug: "launch/one",
            excerpt: "Launch summary",
            metaDescription: "",
            ogImage: "https://cdn.example.test/og.png",
            heroImage: "",
            authorName: "Ada",
            canonicalUrl: "",
          }),
        },
        opts: undefined,
      },
      { path: "/api/v1/paywall/tiers", init: undefined, opts: undefined },
      {
        path: "/api/v1/paywall/tiers",
        init: { method: "POST", body: JSON.stringify(tierInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/paywall/tiers/tier%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: `${campaign}/unpublish-archive`,
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      { path: "/api/v1/archive/stats", init: undefined, opts: undefined },
      {
        path: `${campaign}/archive/pin`,
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: `${campaign}/archive/unpin`,
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("preserves related-issue, preview, tenant-settings, and archive-domain transports", async () => {
    const { calls, methods } = createHarness();
    const relatedIds = ["campaign/two", "campaign/three"];
    const settings = {
      tenant_archive_slug: "ada-news",
      archive_domain: "news.example.test",
      archive_title: "Ada's Notes",
      archive_tagline: "Systems and software",
    };

    await methods.getArchiveRelatedPreview("campaign/one", { limit: 4 });
    await methods.getArchiveRelatedOverrides("campaign/one");
    await methods.setArchiveRelatedOverrides("campaign/one", relatedIds);
    await methods.getArchiveIssuePreview("launch/one");
    await methods.getArchiveTenantSettings();
    await methods.putArchiveTenantSettings(settings);
    await methods.getArchiveCustomDomain();
    await methods.verifyArchiveCustomDomain();
    await methods.deleteArchiveCustomDomain();

    const related = "/api/v1/campaigns/campaign%2Fone/archive/related";
    expect(calls).toEqual([
      {
        path: `${related}?limit=4`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${related}/overrides`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${related}/overrides`,
        init: {
          method: "PUT",
          body: JSON.stringify({ relatedCampaignIds: relatedIds }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/issues/launch%2Fone/preview",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/tenant-settings",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/tenant-settings",
        init: { method: "PUT", body: JSON.stringify(settings) },
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/domain",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/domain/verify",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/admin/archive/domain",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves referral program, stats, payout, credit, and subscriber transports", async () => {
    const { calls, methods } = createHarness();
    const credit = { subscriber_id: "sub/one" };
    const milestone: ReferralMilestone = {
      count: 3,
      reward_label: "Sticker pack",
      reward_kind: "swag",
      reward_value_cents: 2_500,
      reward_currency: "USD",
      reward_sku: "swag-sticker-pack",
      reward_image_asset_id: "asset/one",
    };
    const program = {
      milestones: [milestone],
      expires_at: "2026-12-31T23:59:59Z",
      expected_program_id: "program-1",
      referee_reward_kind: "credit",
      referee_reward_label: "$10 credit",
      referee_reward_image_asset_id: "asset/two",
      reward_value_cents: 1_000,
      reward_currency: "USD",
      reward_sku: "credit-10",
      verification_window_days: 14,
    };

    await methods.getReferralProgram();
    await methods.getReferralStats();
    await methods.listReferralPayouts({ status: "approved", limit: 50 });
    await methods.updateReferralPayout("payout/one", "paid");
    await methods.creditReferral(credit);
    await methods.setReferralProgram(program);
    await methods.getSubscriberReferral(42);

    expect(calls).toEqual([
      {
        path: "/api/v1/referral-programs/current",
        init: undefined,
        opts: undefined,
      },
      { path: "/api/v1/referrals/stats", init: undefined, opts: undefined },
      {
        path: "/api/v1/referrals/payouts?status=approved&limit=50",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/referrals/payouts/payout%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({ status: "paid" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/referrals/credit",
        init: { method: "POST", body: JSON.stringify(credit) },
        opts: undefined,
      },
      {
        path: "/api/v1/referral-programs",
        init: {
          method: "POST",
          body: JSON.stringify({
            milestones: program.milestones,
            expires_at: program.expires_at,
            expected_program_id: program.expected_program_id,
            referee_reward_kind: program.referee_reward_kind,
            referee_reward_label: program.referee_reward_label,
            referee_reward_image_asset_id:
              program.referee_reward_image_asset_id,
            reward_value_cents: program.reward_value_cents,
            reward_currency: program.reward_currency,
            reward_sku: program.reward_sku,
            verification_window_days: program.verification_window_days,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/42/referral",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("retains default queries, PATCH-style omission, and pass-through errors", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.listArchive()).resolves.toBe(expectedError);
    await methods.publishCampaignArchive("campaign/one");
    await methods.getArchiveRelatedPreview("campaign/one");
    await methods.listReferralPayouts();
    await methods.setReferralProgram({ milestones: [] });

    expect(calls).toEqual([
      { path: "/api/v1/archive", init: undefined, opts: undefined },
      {
        path: "/api/v1/campaigns/campaign%2Fone/publish-archive",
        init: {
          method: "POST",
          body: JSON.stringify({ slug: "", excerpt: "" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/archive/related",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/referrals/payouts",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/referral-programs",
        init: {
          method: "POST",
          body: JSON.stringify({ milestones: [], expires_at: null }),
        },
        opts: undefined,
      },
    ]);
  });
});
