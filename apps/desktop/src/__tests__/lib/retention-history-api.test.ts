import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  funnel: vi.fn(),
  offers: vi.fn(),
  settings: vi.fn(),
  tiers: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listPaywallTiers: mocks.tiers,
  },
  apiRetentionOffers: {
    getRetentionOfferFunnel: mocks.funnel,
    listRetentionOffers: mocks.offers,
  },
  winbackSettingsApi: {
    get: mocks.settings,
  },
}));

import {
  loadRetentionFunnel,
  loadRetentionOffers,
  loadRetentionTiers,
  loadRetentionWinbackSettings,
} from "../../lib/api/retention-history";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000001";
const TIER_ID = "30000000-0000-4000-8000-000000000001";

function offerWire() {
  return {
    id: OFFER_ID,
    tenant_id: TENANT_ID,
    paywall_tier_id: TIER_ID,
    percent_off: 20,
    duration_months: 2,
    headline: "Stay with us",
    body: "A historical offer.",
    stripe_coupon_id: "private-provider-value",
    active: true,
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-02T09:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offers.mockResolvedValue({
    data: { offers: [offerWire()], count: 1 },
  });
  mocks.funnel.mockResolvedValue({
    data: {
      tiles: [
        {
          offer_id: OFFER_ID,
          tier_id: TIER_ID,
          shown: 10,
          accepted: 2,
          declined: 5,
          expired: 1,
          acceptance_rate: 0.2,
        },
      ],
      count: 1,
    },
  });
  mocks.tiers.mockResolvedValue({
    data: {
      tiers: [
        {
          id: TIER_ID,
          name: "Founders",
          active: true,
          createdAt: "2026-07-01T09:00:00Z",
          updatedAt: "2026-07-02T09:00:00Z",
        },
      ],
    },
  });
  mocks.settings.mockResolvedValue({
    data: {
      enabled: true,
      churn_threshold: 0.7,
      churn_profiles_scored: 24,
    },
  });
});

describe("retention history read facade", () => {
  it("exposes only four validated GET loaders and minimizes their projections", async () => {
    const [offers, funnel, tiers, settings] = await Promise.all([
      loadRetentionOffers(TENANT_ID),
      loadRetentionFunnel(),
      loadRetentionTiers(),
      loadRetentionWinbackSettings(),
    ]);

    expect(mocks.offers).toHaveBeenCalledTimes(1);
    expect(mocks.funnel).toHaveBeenCalledTimes(1);
    expect(mocks.tiers).toHaveBeenCalledTimes(1);
    expect(mocks.settings).toHaveBeenCalledTimes(1);
    expect(offers).toMatchObject({
      data: {
        items: [
          {
            id: OFFER_ID,
            tierId: TIER_ID,
            headline: "Stay with us",
            providerCouponPresent: true,
          },
        ],
      },
    });
    expect(JSON.stringify(offers)).not.toContain("private-provider-value");
    expect(funnel).toMatchObject({
      data: { items: [{ shown: 10, accepted: 2, declined: 5, expired: 1 }] },
    });
    expect(tiers).toMatchObject({
      data: { items: [{ name: "Founders" }] },
    });
    expect(settings).toMatchObject({
      data: { enabled: true, churnThreshold: 0.7 },
    });
  });

  it("maps malformed success payloads to bounded parse failures", async () => {
    mocks.offers.mockResolvedValue({
      data: { offers: [offerWire()], count: 0 },
    });
    mocks.funnel.mockResolvedValue({ data: { tiles: "not-an-array" } });
    mocks.tiers.mockResolvedValue({ data: { tiers: [{ id: "bad" }] } });
    mocks.settings.mockResolvedValue({
      data: { enabled: "true", churn_threshold: 0.7 },
    });

    await expect(loadRetentionOffers(TENANT_ID)).resolves.toEqual({
      error: expect.objectContaining({
        kind: "parse",
        code: "count-mismatch",
      }),
    });
    await expect(loadRetentionFunnel()).resolves.toEqual({
      error: expect.objectContaining({
        kind: "parse",
        code: "invalid-envelope",
      }),
    });
    await expect(loadRetentionTiers()).resolves.toEqual({
      error: expect.objectContaining({
        kind: "parse",
        code: "invalid-record",
      }),
    });
    await expect(loadRetentionWinbackSettings()).resolves.toEqual({
      error: expect.objectContaining({
        kind: "parse",
        code: "invalid-record",
      }),
    });
  });

  it("passes transport errors through without reflecting payload data", async () => {
    const error = {
      status: 503,
      code: "unavailable",
      message: "private database detail",
    };
    mocks.offers.mockResolvedValue({ error });
    await expect(loadRetentionOffers(TENANT_ID)).resolves.toEqual({ error });
  });

  it("keeps the route facade statically read-only", () => {
    const source = readFileSync(
      new URL("../../lib/api/retention-history.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("listRetentionOffers()");
    expect(source).toContain("getRetentionOfferFunnel()");
    expect(source).toContain("listPaywallTiers()");
    expect(source).toContain("winbackSettingsApi.get()");
    expect(source).not.toMatch(
      /\.(?:upsertRetentionOffer|deactivateRetentionOffer|put|post|delete|logRetentionOfferEvent|acceptPortalRetentionOffer|declinePortalRetentionOffer)\s*\(/u,
    );
  });
});
