/**
 * Retention transport boundary: a 2xx body is not success until the exact
 * read-side contract has been decoded. These cases prevent malformed payloads
 * from becoming empty catalogues, zero funnels, or default settings in the
 * TanStack cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RetentionPayloadError } from "@/lib/retentionOffers";

import {
  fetchPaywallTierNames,
  fetchRetentionFunnel,
  fetchWinbackSettings,
  listRetentionOffers,
} from "./retentionOffers";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OFFER_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => rawRequest.mockReset());

describe("retention read transport", () => {
  it("accepts a genuine empty offer envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { offers: [], count: 0 },
      error: null,
    });

    await expect(listRetentionOffers(TENANT_ID)).resolves.toEqual([]);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/retention-offers",
      undefined,
    );
  });

  it("decodes genuine zero funnel counts without trusting the wire rate", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tiles: [
          {
            offer_id: OFFER_ID,
            tier_id: TIER_ID,
            shown: 0,
            accepted: 0,
            declined: 0,
            expired: 0,
            acceptance_rate: 0,
          },
        ],
        count: 1,
      },
      error: null,
    });

    await expect(fetchRetentionFunnel()).resolves.toEqual([
      {
        offerId: OFFER_ID,
        tierId: TIER_ID,
        shown: 0,
        accepted: 0,
        declined: 0,
        expired: 0,
      },
    ]);
  });

  it("decodes complete stored win-back settings", async () => {
    rawRequest.mockResolvedValue({
      data: {
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: 0,
      },
      error: null,
    });

    await expect(fetchWinbackSettings()).resolves.toEqual({
      enabled: false,
      churnThreshold: 0.7,
      churnProfilesScored: 0,
    });
  });

  it("decodes a complete tier-name projection", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tiers: [
          {
            id: TIER_ID,
            name: "Founding member",
            active: true,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-02T00:00:00Z",
          },
        ],
      },
      error: null,
    });

    await expect(fetchPaywallTierNames()).resolves.toEqual({
      [TIER_ID]: "Founding member",
    });
  });

  it.each([
    ["offers", () => listRetentionOffers(TENANT_ID), null],
    [
      "funnel",
      fetchRetentionFunnel,
      { tiles: [{ offer_id: "off-1" }], count: 1 },
    ],
    [
      "settings",
      fetchWinbackSettings,
      { enabled: false, churn_threshold: "0.7", churn_profiles_scored: 0 },
    ],
    ["tiers", fetchPaywallTierNames, { tiers: [{ id: "tier-1", name: "" }] }],
  ])("rejects a malformed %s 2xx body", async (_label, read, data) => {
    rawRequest.mockResolvedValue({ data, error: null });
    await expect(read()).rejects.toBeInstanceOf(RetentionPayloadError);
  });

  it("keeps HTTP failures distinct from payload failures", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        code: "forbidden",
        message: "admin role required",
        requestId: "req-1",
      },
    });

    await expect(listRetentionOffers(TENANT_ID)).rejects.toMatchObject({
      name: "RetentionRequestError",
      status: 403,
      code: "forbidden",
      requestId: "req-1",
    });
  });
});
