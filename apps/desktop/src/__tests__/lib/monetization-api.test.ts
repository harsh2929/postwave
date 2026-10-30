import { describe, expect, it } from "vitest";

import { createMonetizationApi } from "../../lib/api/monetization";
import type { ApiRequester, ApiResult } from "../../lib/api/result";

function recordingRequester() {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const request: ApiRequester = <T>(path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve<ApiResult<T>>({ data: {} as T });
  };
  return { calls, request };
}

describe("monetization domain API", () => {
  it("exposes only the sanitized discount archive reads", async () => {
    const transport = recordingRequester();
    const api = createMonetizationApi(transport.request);
    const recordID = "11111111-1111-4111-8111-111111111111";

    await api.listDiscounts();
    await api.listDiscountRedemptions(recordID, {
      limit: 25,
      offset: 50,
    });

    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/v1/discounts",
      `/api/v1/discounts/${recordID}/redemptions?limit=25&offset=50`,
    ]);
    expect(Object.keys(api)).not.toEqual(
      expect.arrayContaining([
        "createDiscount",
        "deleteDiscount",
        "checkDiscount",
        "updateDiscount",
        "discountRedemptionsCsvPath",
      ]),
    );
  });

  it("exposes only bounded sanitized gift archive reads", async () => {
    const transport = recordingRequester();
    const api = createMonetizationApi(transport.request);
    const recordID = "22222222-2222-4222-8222-222222222222";

    await api.listGiftSubscriptions({
      limit: 18,
      offset: 36,
      q: "22222222",
      filter: "open",
      sort: "duration",
    });
    await api.getGiftSubscriptionStats();
    await api.getGiftSubscription(recordID);

    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/v1/gift-subscriptions?limit=18&offset=36&q=22222222&filter=open&sort=duration",
      "/api/v1/gift-subscriptions/stats",
      `/api/v1/gift-subscriptions/${recordID}`,
    ]);
    expect(transport.calls.every((call) => call.init === undefined)).toBe(true);
    expect(Object.keys(api)).not.toEqual(
      expect.arrayContaining([
        "createGiftSubscription",
        "cancelGiftSubscription",
        "updateGiftSubscription",
        "getGiftSubscriptionAttribution",
      ]),
    );
  });

  it("never transmits identity-shaped Gift search or unbounded pagination", async () => {
    const transport = recordingRequester();
    const api = createMonetizationApi(transport.request);

    await api.listGiftSubscriptions({
      limit: 999,
      offset: -20,
      q: "pii-canary@example.invalid",
    });

    expect(transport.calls).toEqual([
      {
        path: "/api/v1/gift-subscriptions?limit=100&offset=0",
        init: undefined,
      },
    ]);
  });
});
