import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest: mocks.rawRequest }));

const giftApi = await import("./giftSubscriptions");

const ID = "a11ce001-1111-4111-8111-111111111111";

function wireRecord(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Gift record A11CE001",
    plan_label: "Essentials Monthly",
    duration_months: 12,
    status: "pending",
    created_at: "2026-07-01T00:00:00Z",
    redeemed_at: null,
    expires_at: null,
    canceled_at: null,
    message_recorded: false,
    provider_invoice_linked: true,
    gifter_member_linked: false,
    recipient_member_linked: false,
    ...over,
  };
}

beforeEach(() => {
  mocks.rawRequest.mockReset();
});

describe("Gift history mobile transport", () => {
  it("serializes only bounded, allow-listed list inputs", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: {
        items: [wireRecord()],
        total: 1,
        limit: 100,
        offset: 10_000,
        snapshot_at: "2026-07-27T12:00:00Z",
      },
      error: null,
    });
    await giftApi.listGiftSubscriptions({
      limit: 500,
      offset: 99_999,
      query: " Gift record A11CE001 ",
      filter: "redeemed",
      sort: "oldest",
    });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/gift-subscriptions?limit=100&offset=10000&q=a11ce001&filter=redeemed&sort=oldest",
      undefined,
    );
  });

  it("never transmits an invalid or identity-shaped search value", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: {
        items: [],
        total: 0,
        limit: 24,
        offset: 0,
        snapshot_at: "2026-07-27T12:00:00Z",
      },
      error: null,
    });
    await giftApi.listGiftSubscriptions({
      query: "pii-canary@example.invalid",
    });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/gift-subscriptions?limit=24&offset=0",
      undefined,
    );
  });

  it("uses exactly the three mounted GET reads", async () => {
    mocks.rawRequest
      .mockResolvedValueOnce({
        data: {
          items: [wireRecord()],
          total: 1,
          limit: 24,
          offset: 0,
          snapshot_at: "2026-07-27T12:00:00Z",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          total: 1,
          pending: 1,
          paid: 0,
          granted: 0,
          canceled: 0,
          expired: 0,
          refunded: 0,
          conversionRate: 0,
          generated_at: "2026-07-27T12:00:00Z",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: wireRecord(), error: null });

    await giftApi.listGiftSubscriptions();
    await giftApi.fetchGiftStats();
    await giftApi.fetchGiftSubscription(ID);

    const calls = mocks.rawRequest.mock.calls.map(
      ([method, path]) => `${String(method)} ${String(path).split("?")[0]}`,
    );
    expect(calls).toEqual([
      "GET /api/v1/gift-subscriptions",
      "GET /api/v1/gift-subscriptions/stats",
      `GET /api/v1/gift-subscriptions/${ID}`,
    ]);
    expect(JSON.stringify(calls)).not.toContain("attribution");
    expect(giftApi).not.toHaveProperty("createGiftSubscription");
    expect(giftApi).not.toHaveProperty("fetchGiftAttribution");
  });

  it("fails closed on malformed successful responses", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: { items: "not-an-array" },
      error: null,
    });
    await expect(giftApi.listGiftSubscriptions()).rejects.toBeInstanceOf(
      giftApi.GiftContractError,
    );
  });

  it("fails closed on contradictory aggregate statistics", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: {
        total: 4,
        pending: 0,
        paid: 0,
        granted: 1,
        canceled: 1,
        expired: 1,
        refunded: 1,
        conversionRate: 0.5,
        generated_at: "2026-07-27T12:00:00Z",
      },
      error: null,
    });
    await expect(giftApi.fetchGiftStats()).rejects.toBeInstanceOf(
      giftApi.GiftContractError,
    );
  });

  it("rejects a non-UUID detail id before the network", async () => {
    await expect(
      giftApi.fetchGiftSubscription("not-a-record-id"),
    ).rejects.toThrow(/valid gift record id/i);
    expect(mocks.rawRequest).not.toHaveBeenCalled();
  });

  it("rejects a detail payload for a different record", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: wireRecord({
        id: "b22ce002-2222-4222-8222-222222222222",
      }),
      error: null,
    });
    await expect(giftApi.fetchGiftSubscription(ID)).rejects.toThrow(
      /did not match the requested record/i,
    );
  });

  it("reserves null for a tenant-safe detail 404", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: null,
      error: { status: 404, message: "not found" },
    });
    await expect(giftApi.fetchGiftSubscription(ID)).resolves.toBeNull();
  });
});
