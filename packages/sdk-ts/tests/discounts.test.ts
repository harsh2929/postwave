import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";
import type {
  Discount,
  DiscountRedemptionEvent,
  DiscountRedemptionsParams,
} from "../src/index.js";

const RECORD_ID = "A1B2C3D4-E5F6-4789-ABCD-EF0123456789";

const SAFE_RECORD = {
  id: RECORD_ID.toLowerCase(),
  label: "Discount record A1B2C3D4",
  percent_off: 20,
  currency: "usd",
  max_redemptions: null,
  times_redeemed: 3,
  expires_at: null,
  applies_to: "both",
  created_at: "2026-07-01T00:00:00Z",
} satisfies Discount;

const SAFE_EVENT = {
  redeemed_at: "2026-07-02T00:00:00Z",
  subscriber_linked: true,
} satisfies DiscountRedemptionEvent;

type SensitiveRecordKey = Extract<
  keyof Discount,
  | "code"
  | "tenant_id"
  | "stripe_coupon_id"
  | "stripe_promo_id"
  | "subscriber_id"
  | "subscriber_email"
>;

type SensitiveEventKey = Extract<
  keyof DiscountRedemptionEvent,
  | "code"
  | "discount_code"
  | "subscriber_id"
  | "subscriber_email"
  | "tenant_id"
>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DiscountsResource sanitized history contract", () => {
  it("exposes only the two mounted read routes", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url });
      return new URL(url).pathname.endsWith("/discounts")
        ? json({ items: [SAFE_RECORD], has_more: false })
        : json({ items: [SAFE_EVENT], has_more: true });
    });
    const client = new PostwaveClient({
      apiKey: "test",
      tenantId: "tenant",
      fetch,
      retries: 0,
    });

    await expect(
      client.discounts.list({
        record_id: RECORD_ID,
        limit: 50,
        offset: 0,
      }),
    ).resolves.toEqual({
      items: [SAFE_RECORD],
      has_more: false,
    });
    await expect(
      client.discounts.redemptions(RECORD_ID, { limit: 100, offset: 10_000 }),
    ).resolves.toEqual({ items: [SAFE_EVENT], has_more: true });

    expect(seen).toEqual([
      {
        method: "GET",
        url:
          "https://api.moosewave.com/api/v1/discounts?record_id=a1b2c3d4-e5f6-4789-abcd-ef0123456789&limit=50&offset=0",
      },
      {
        method: "GET",
        url:
          "https://api.moosewave.com/api/v1/discounts/a1b2c3d4-e5f6-4789-abcd-ef0123456789/redemptions?limit=100&offset=10000",
      },
    ]);
    expect("check" in client.discounts).toBe(false);
    expect("exportRedemptionsCsv" in client.discounts).toBe(false);
  });

  it("omits the query string when pagination is not supplied", async () => {
    const fetch = vi.fn(async (_url: string) => json({ items: [] }));
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });

    await client.discounts.list();
    await client.discounts.redemptions(RECORD_ID);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/discounts",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/discounts/a1b2c3d4-e5f6-4789-abcd-ef0123456789/redemptions",
    );
  });

  it("rejects code-shaped identifiers and unsafe pagination before transport", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });
    const invalidIds: unknown[] = [
      "SAVE20",
      "",
      " a1b2c3d4-e5f6-4789-abcd-ef0123456789",
      "a1b2c3d4e5f64789abcdef0123456789",
      "a1b2c3d4-e5f6-4789-abcd-ef012345678",
      42,
    ];
    for (const id of invalidIds) {
      expect(() =>
        client.discounts.list({ record_id: id as string }),
      ).toThrow(/record_id/u);
      expect(() => client.discounts.redemptions(id as string)).toThrow(
        /record_id/u,
      );
    }
    const invalidParams: DiscountRedemptionsParams[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 10_001 },
      { offset: Number.NaN },
    ];
    for (const params of invalidParams) {
      expect(() => client.discounts.list(params)).toThrow();
      expect(() => client.discounts.redemptions(RECORD_ID, params)).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps sensitive identifiers out of both public response types", () => {
    const recordHasNoSensitiveKeys: [SensitiveRecordKey] extends [never]
      ? true
      : false = true;
    const eventHasNoSensitiveKeys: [SensitiveEventKey] extends [never]
      ? true
      : false = true;
    expect(recordHasNoSensitiveKeys).toBe(true);
    expect(eventHasNoSensitiveKeys).toBe(true);
  });
});
