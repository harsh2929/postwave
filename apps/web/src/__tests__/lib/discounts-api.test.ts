// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import * as discountsApi from "@/lib/discounts-api";
import {
  assignCoupon,
  decodeDiscountHistoryRecord,
  decodeDiscountRedemptionEvent,
  discountAppliesToLabel,
  discountHistoryState,
  discountValueLabel,
  getCouponPool,
  importCouponCodes,
  isDiscountRecordId,
  listCouponPools,
  listDiscountHistory,
  listDiscountRedemptionEvents,
  parseCouponCodes,
  upsertCouponPool,
  type DiscountHistoryRecord,
} from "@/lib/discounts-api";

const RECORD_ID = "11111111-2222-4333-8444-555555555555";

function record(
  patch: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: RECORD_ID,
    label: "Discount record 11111111",
    percent_off: 20,
    currency: "usd",
    times_redeemed: 3,
    applies_to: "both",
    created_at: "2026-07-10T00:00:00Z",
    ...patch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitized discount-history transport", () => {
  it("decodes the archive envelope and never sends a code-search query", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [record()], has_more: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listDiscountHistory()).resolves.toEqual({
      items: [
        {
          id: RECORD_ID,
          label: "Discount record 11111111",
          percent_off: 20,
          amount_off_cents: null,
          currency: "USD",
          max_redemptions: null,
          times_redeemed: 3,
          expires_at: null,
          applies_to: "both",
          created_at: "2026-07-10T00:00:00Z",
          issues: [],
        },
      ],
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/discounts?limit=50&offset=0",
      expect.any(Object),
    );
  });

  it.each([
    [
      "legacy code and tenant fields",
      record({ code: "SECRET20", tenant_id: "tenant-1" }),
    ],
    ["provider identifier", record({ stripe_coupon_id: "coupon_secret" })],
    ["numeric string", record({ times_redeemed: "3" })],
    ["invalid record ID", record({ id: "SECRET20" })],
    ["padded record ID", record({ id: ` ${RECORD_ID}` })],
    ["padded label", record({ label: " Discount record 11111111" })],
    ["padded currency", record({ currency: " usd" })],
    ["unsafe label", record({ label: "Safe\u202ehidden" })],
    ["invalid timestamp", record({ created_at: "yesterday" })],
    ["non-RFC3339 timestamp", record({ created_at: "2026-07-10" })],
    [
      "impossible RFC3339-shaped timestamp",
      record({ created_at: "2026-02-30T00:00:00Z" }),
    ],
    ["unsafe integer", record({ times_redeemed: Number.MAX_SAFE_INTEGER + 1 })],
    ["out-of-storage-range integer", record({ times_redeemed: 2_147_483_648 })],
  ])("rejects %s instead of coercing or exposing it", async (_name, row) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [row], has_more: false })),
    );
    await expect(listDiscountHistory()).rejects.toThrow(/invalid row/i);
  });

  it("rejects unknown envelope fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ items: [], has_more: false, code: "SECRET20" }),
      ),
    );
    await expect(listDiscountHistory()).rejects.toThrow(/malformed/i);
  });

  it("contains readable legacy domain anomalies as per-record data issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            record({
              percent_off: null,
              amount_off_cents: 500,
              currency: "notmoney",
              max_redemptions: 0,
              times_redeemed: -4,
            }),
          ],
          has_more: false,
        }),
      ),
    );

    await expect(listDiscountHistory()).resolves.toMatchObject({
      items: [
        {
          amount_off_cents: 500,
          currency: "XXX",
          max_redemptions: null,
          times_redeemed: 0,
          issues: ["invalid_currency", "invalid_cap", "invalid_count"],
        },
      ],
    });

    expect(
      decodeDiscountHistoryRecord(record({ amount_off_cents: 500 })),
    ).toMatchObject({ issues: ["invalid_benefit"] });
    const missingBenefit = decodeDiscountHistoryRecord(
      record({ percent_off: null }),
    );
    expect(missingBenefit).toMatchObject({ issues: ["invalid_benefit"] });
    expect(discountValueLabel(missingBenefit!)).toBe(
      "Stored benefit needs review",
    );

    const invalidCurrency = decodeDiscountHistoryRecord(
      record({
        percent_off: null,
        amount_off_cents: 250,
        currency: "INVALID",
      }),
    );
    expect(discountValueLabel(invalidCurrency!)).toBe(
      "250 minor units · currency unavailable",
    );
  });

  it("rejects responses that exceed their declared client bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            record(),
            record({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
          ],
          has_more: true,
        }),
      ),
    );
    await expect(listDiscountHistory({ limit: 1, offset: 0 })).rejects.toThrow(
      /invalid row/i,
    );
  });

  it("rejects a continuation claim on a short page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [record()], has_more: true })),
    );
    await expect(listDiscountHistory({ limit: 2, offset: 0 })).rejects.toThrow(
      /invalid row/i,
    );
  });

  it("normalizes an uppercase opaque detail filter once", async () => {
    const lowercaseID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const uppercaseID = lowercaseID.toUpperCase();
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [record({ id: lowercaseID })], has_more: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await listDiscountHistory({ limit: 1, offset: 0, recordId: uppercaseID });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:8080/api/v1/discounts?limit=1&offset=0&record_id=${lowercaseID}`,
      expect.any(Object),
    );
  });

  it("rejects an explicitly empty record filter before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listDiscountHistory({ limit: 1, offset: 0, recordId: "" }),
    ).rejects.toThrow(/record ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests one bounded page by opaque record ID and decodes linkage only", async () => {
    const rows = [
      { redeemed_at: "2026-07-12T00:00:00Z", subscriber_linked: true },
      { redeemed_at: "2026-07-11T00:00:00Z", subscriber_linked: false },
    ];
    const fetchMock = vi.fn(async () =>
      Response.json({ items: rows, has_more: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listDiscountRedemptionEvents(RECORD_ID, { limit: 2, offset: 4 }),
    ).resolves.toEqual({ items: rows, hasMore: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:8080/api/v1/discounts/${RECORD_ID}/redemptions?limit=2&offset=4`,
      expect.any(Object),
    );
  });

  it("rejects identity-bearing event rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              redeemed_at: "2026-07-12T00:00:00Z",
              subscriber_linked: true,
              subscriber_email: "private@example.test",
            },
          ],
          has_more: false,
        }),
      ),
    );
    await expect(
      listDiscountRedemptionEvents(RECORD_ID, { limit: 25, offset: 0 }),
    ).rejects.toThrow(/invalid row/i);
  });

  it("rejects a short event page that falsely claims continuation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              redeemed_at: "2026-07-12T00:00:00Z",
              subscriber_linked: false,
            },
          ],
          has_more: true,
        }),
      ),
    );
    await expect(
      listDiscountRedemptionEvents(RECORD_ID, { limit: 2, offset: 0 }),
    ).rejects.toThrow(/invalid row/i);
  });

  it("rejects a code-shaped path value before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listDiscountRedemptionEvents("SECRET20", { limit: 25, offset: 0 }),
    ).rejects.toThrow(/record ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not export stale live, mutation, or PII-export transports", () => {
    for (const name of [
      "checkDiscount",
      "createDiscount",
      "deleteDiscount",
      "listRedemptions",
      "listRedemptionsPage",
      "redemptionsCsv",
      "updateDiscount",
    ]) {
      expect(discountsApi).not.toHaveProperty(name);
    }
  });
});

describe("strict decoders", () => {
  it("accepts exact sanitized records and events", () => {
    expect(decodeDiscountHistoryRecord(record())).toMatchObject({
      id: RECORD_ID,
      label: "Discount record 11111111",
    });
    expect(
      decodeDiscountRedemptionEvent({
        redeemed_at: "2026-07-12T00:00:00Z",
        subscriber_linked: false,
      }),
    ).toEqual({
      redeemed_at: "2026-07-12T00:00:00Z",
      subscriber_linked: false,
    });
    expect(isDiscountRecordId(RECORD_ID)).toBe(true);
    expect(isDiscountRecordId("SAVE20")).toBe(false);
    expect(isDiscountRecordId(` ${RECORD_ID}`)).toBe(false);
  });
});

describe("historical presentation helpers", () => {
  const base: DiscountHistoryRecord = {
    id: RECORD_ID,
    label: "Discount record 11111111",
    currency: "USD",
    percent_off: 25,
    amount_off_cents: null,
    max_redemptions: null,
    times_redeemed: 0,
    expires_at: null,
    applies_to: "first_payment",
    created_at: "2026-01-01T00:00:00Z",
    issues: [],
  };

  it("formats stored benefits and scopes", () => {
    expect(discountValueLabel(base)).toBe("25% off");
    expect(
      discountValueLabel({
        ...base,
        percent_off: null,
        amount_off_cents: 500,
      }),
    ).toMatch(/5\.00 off$/);
    expect(discountAppliesToLabel("first_payment")).toBe("First payment");
    expect(discountAppliesToLabel("recurring")).toBe("Recurring payments");
    expect(discountAppliesToLabel("both")).toBe("First and recurring payments");
  });

  it("uses stored-rule language and evaluates expiry before the cap", () => {
    const now = Date.parse("2026-04-29T00:00:00Z");
    expect(discountHistoryState(base, now)).toBe("within_stored_rules");
    expect(
      discountHistoryState(
        {
          ...base,
          expires_at: "2026-01-01T00:00:00Z",
          max_redemptions: 1,
          times_redeemed: 1,
        },
        now,
      ),
    ).toBe("expired");
    expect(
      discountHistoryState(
        { ...base, max_redemptions: 1, times_redeemed: 1 },
        now,
      ),
    ).toBe("cap_reached");
    expect(
      discountHistoryState({ ...base, issues: ["invalid_benefit"] }, now),
    ).toBe("data_issue");
  });
});

describe("coupon-pool release holds", () => {
  it("fails before transport and retains code parsing for dormant tooling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCouponPools()).rejects.toThrow(/release-held/i);
    await expect(getCouponPool("pool-1")).rejects.toThrow(/release-held/i);
    await expect(upsertCouponPool({ name: "Launch codes" })).rejects.toThrow(
      /release-held/i,
    );
    await expect(importCouponCodes("pool-1", ["SAVE10"])).rejects.toThrow(
      /release-held/i,
    );
    await expect(
      assignCoupon("pool-1", { subscriber_email: "person@example.test" }),
    ).rejects.toThrow(/release-held/i);
    expect(parseCouponCodes("a, b\n a\nC")).toEqual(["A", "B", "C"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
