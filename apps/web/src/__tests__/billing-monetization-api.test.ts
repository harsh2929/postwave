import { afterEach, describe, expect, it, vi } from "vitest";

import { listAffiliates } from "@/lib/affiliates-api";
import { setBillingOverage } from "@/lib/billing-api";
import { listDiscountRedemptionEvents } from "@/lib/discounts-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("monetization list queries", () => {
  it("loads one bounded PII-free discount event page", async () => {
    const calls: string[] = [];
    const row = {
      redeemed_at: "2026-07-10T00:00:00Z",
      subscriber_linked: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return Response.json({ items: [row], has_more: false });
      }),
    );

    const id = "11111111-2222-4333-8444-555555555555";
    await expect(
      listDiscountRedemptionEvents(id, { limit: 50, offset: 0 }),
    ).resolves.toEqual({ items: [row], hasMore: false });
    expect(calls).toEqual([
      `http://localhost:8080/api/v1/discounts/${id}/redemptions?limit=50&offset=0`,
    ]);
  });

  it("keeps affiliate administration release-held before transport", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listAffiliates({
        country: "US",
        sort: "name",
        status: ["approved", "suspended"],
      }),
    ).rejects.toThrow(/Affiliate listing is release-held/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs the overage preference with a normalized cap (BILL-052)", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        tier: "studio_ltd_cloud",
        startedAt: "",
        sendingAddon: null,
        card: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await setBillingOverage(true, 5000);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:8080/api/v1/billing/overage");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      overageEnabled: true,
      overageCap: 5000,
    });

    // Omitted cap serializes as null (uncapped), never undefined.
    await setBillingOverage(false);
    const secondInit = (
      fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    )[1];
    expect(JSON.parse(secondInit.body as string)).toEqual({
      overageEnabled: false,
      overageCap: null,
    });
  });
});
