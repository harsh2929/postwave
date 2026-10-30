import { describe, expect, it } from "vitest";

import { decodeDiscountHistoryPayload } from "../../components/discounts/discount-history";

describe("discount history containment", () => {
  it("uses only the archive label and opaque record id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const decoded = decodeDiscountHistoryPayload({
      items: [
        {
          id,
          label: "Discount record 11111111",
          code: "LIVE-COUPON-SECRET",
          tenant_id: "tenant-secret",
          stripe_coupon_id: "provider-secret",
          percent_off: 20,
          currency: "USD",
          times_redeemed: 3,
          applies_to: "both",
          created_at: "2026-07-27T00:00:00Z",
        },
      ],
    });

    expect(decoded.recognized).toBe(true);
    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]?.label).toBe("Discount record 11111111");
    expect(decoded.items[0]?.sourceRecordID).toBe(id);
    expect(JSON.stringify(decoded.items)).not.toContain("LIVE-COUPON-SECRET");
    expect(JSON.stringify(decoded.items)).not.toContain("tenant-secret");
    expect(JSON.stringify(decoded.items)).not.toContain("provider-secret");
  });

  it("never falls back to a legacy redeemable code", () => {
    const decoded = decodeDiscountHistoryPayload({
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          code: "LEGACY-LIVE-CODE",
          percent_off: 10,
          currency: "USD",
          times_redeemed: 0,
          applies_to: "both",
        },
      ],
    });

    expect(decoded.items[0]?.label).toBe("Unidentified record 1");
    expect(JSON.stringify(decoded.items)).not.toContain("LEGACY-LIVE-CODE");
    expect(decoded.items[0]?.issues).toContain("Archive label is missing.");
  });
});
