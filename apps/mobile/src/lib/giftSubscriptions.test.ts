import { describe, expect, it } from "vitest";

import {
  giftHistoryQueryPrefix,
  giftHistoryStatus,
  mergeGiftHistoryPages,
  nextGiftHistoryOffset,
  normalizeGiftHistoryPage,
  normalizeGiftHistoryRecord,
  normalizeGiftHistoryStats,
  sanitizeGiftHistoryQuery,
} from "./giftSubscriptions";

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
    expires_at: "2027-07-01T00:00:00Z",
    canceled_at: null,
    message_recorded: true,
    provider_invoice_linked: true,
    gifter_member_linked: false,
    recipient_member_linked: false,
    ...over,
  };
}

function wirePage(over: Record<string, unknown> = {}) {
  return {
    items: [wireRecord()],
    total: 25,
    limit: 24,
    offset: 0,
    snapshot_at: "2026-07-27T12:00:00Z",
    ...over,
  };
}

describe("normalizeGiftHistoryRecord", () => {
  it("decodes only the privacy-minimized archive projection", () => {
    expect(normalizeGiftHistoryRecord(wireRecord())).toEqual({
      id: ID,
      label: "Gift record A11CE001",
      planLabel: "Essentials Monthly",
      durationMonths: 12,
      status: "pending",
      createdAt: "2026-07-01T00:00:00Z",
      redeemedAt: null,
      expiresAt: "2027-07-01T00:00:00Z",
      canceledAt: null,
      messageRecorded: true,
      providerInvoiceLinked: true,
      gifterMemberLinked: false,
      recipientMemberLinked: false,
      issues: [],
    });
  });

  it("contains unexpected sensitive fields without retaining their values", () => {
    const record = normalizeGiftHistoryRecord(
      wireRecord({
        purchaser_email: "private@example.com",
        message: "secret words",
        stripe_payment_url: "https://provider.invalid/pay",
      }),
    );
    expect(record?.issues).toHaveLength(3);
    expect(JSON.stringify(record)).not.toContain("private@example.com");
    expect(JSON.stringify(record)).not.toContain("secret words");
    expect(JSON.stringify(record)).not.toContain("provider.invalid");
  });

  it("rejects rows without an opaque UUID and flags contradictory evidence", () => {
    expect(
      normalizeGiftHistoryRecord(wireRecord({ id: "public-label" })),
    ).toBeNull();
    const record = normalizeGiftHistoryRecord(
      wireRecord({
        status: "redeemed",
        redeemed_at: null,
        duration_months: 61,
      }),
    );
    expect(record?.status).toBe("redeemed");
    expect(record?.durationMonths).toBeNull();
    expect(record?.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/duration/i),
        expect.stringMatching(/redemption timestamp/i),
      ]),
    );
  });
});

describe("normalizeGiftHistoryPage", () => {
  it("preserves server pagination and snapshot provenance", () => {
    const page = normalizeGiftHistoryPage(wirePage());
    expect(page.recognized).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(25);
    expect(page.limit).toBe(24);
    expect(page.offset).toBe(0);
    expect(page.snapshotAt).toBe("2026-07-27T12:00:00Z");
    expect(nextGiftHistoryOffset(page)).toBe(1);
  });

  it("rejects malformed rows and never converts an invalid envelope to empty truth", () => {
    const page = normalizeGiftHistoryPage(
      wirePage({ items: [wireRecord(), null, { label: "No id" }] }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.rejectedRows).toBe(2);
    expect(nextGiftHistoryOffset(page)).toBe(3);
    expect(normalizeGiftHistoryPage({ items: "not-an-array" }).recognized).toBe(
      false,
    );
  });

  it("bounds hostile page arrays and offsets before rendering", () => {
    const page = normalizeGiftHistoryPage(
      wirePage({
        items: Array.from({ length: 102 }, (_, index) =>
          wireRecord({
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Gift record ${String(index).padStart(8, "0")}`,
          }),
        ),
        total: 102,
        limit: 24,
        offset: 10_001,
      }),
    );

    expect(page.items).toHaveLength(100);
    expect(page.rejectedRows).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.envelopeIssues).toEqual(
      expect.arrayContaining([
        "Page offset is outside 0–10,000.",
        "Page contains more than 100 records.",
        "Page contains more records than its declared limit.",
      ]),
    );
  });

  it("de-duplicates records when adjacent server pages overlap", () => {
    const first = normalizeGiftHistoryPage(wirePage());
    const second = normalizeGiftHistoryPage(
      wirePage({ offset: 1, items: [wireRecord()] }),
    );
    expect(mergeGiftHistoryPages([first, second])).toHaveLength(1);
  });

  it("stops paging at the total and at the server offset ceiling", () => {
    expect(
      nextGiftHistoryOffset(
        normalizeGiftHistoryPage(wirePage({ total: 1, limit: 24 })),
      ),
    ).toBeUndefined();
    expect(
      nextGiftHistoryOffset(
        normalizeGiftHistoryPage(
          wirePage({ total: 20_000, offset: 10_000, limit: 24 }),
        ),
      ),
    ).toBeUndefined();
  });
});

describe("normalizeGiftHistoryStats", () => {
  it("decodes paid and provenance while retaining unclassified count", () => {
    expect(
      normalizeGiftHistoryStats({
        total: 12,
        pending: 2,
        paid: 1,
        granted: 5,
        canceled: 1,
        expired: 1,
        refunded: 1,
        conversionRate: 5 / 8,
        generated_at: "2026-07-27T12:00:00Z",
      }),
    ).toMatchObject({
      total: 12,
      pending: 2,
      paid: 1,
      redeemed: 5,
      cancelled: 1,
      expired: 1,
      refunded: 1,
      unclassified: 1,
      generatedAt: "2026-07-27T12:00:00Z",
    });
  });

  it("returns null for unreadable or impossible primitive types", () => {
    expect(normalizeGiftHistoryStats(null)).toBeNull();
    expect(normalizeGiftHistoryStats({ total: "12" })).toBeNull();
    expect(
      normalizeGiftHistoryStats({
        total: 0,
        pending: 0,
        paid: 0,
        granted: 0,
        canceled: 0,
        expired: 0,
        refunded: 0,
        conversionRate: 2,
      }),
    ).toBeNull();
  });

  it("contains a conversion value that conflicts with terminal counts", () => {
    expect(
      normalizeGiftHistoryStats({
        total: 4,
        pending: 0,
        paid: 0,
        granted: 1,
        canceled: 1,
        expired: 1,
        refunded: 1,
        conversionRate: 0.5,
        generated_at: "2026-07-27T12:00:00Z",
      })?.issues,
    ).toContain("Conversion rate conflicts with the lifecycle counts.");
  });
});

describe("archive vocabulary and query boundary", () => {
  it("normalizes every supported lifecycle spelling without inventing one", () => {
    expect(giftHistoryStatus("granted")).toBe("redeemed");
    expect(giftHistoryStatus("active")).toBe("redeemed");
    expect(giftHistoryStatus("canceled")).toBe("cancelled");
    expect(giftHistoryStatus("processing")).toBe("unclassified");
  });

  it("removes control text, bounds local input, and accepts only UUID prefixes", () => {
    expect(sanitizeGiftHistoryQuery("Gift A11CE001\u202e@example")).toBe(
      "Gift A11CE001@example",
    );
    expect(sanitizeGiftHistoryQuery("a".repeat(120))).toHaveLength(96);
    expect(giftHistoryQueryPrefix("Gift record A11CE001")).toBe("a11ce001");
    expect(giftHistoryQueryPrefix(ID)).toBe(ID.replaceAll("-", ""));
    expect(giftHistoryQueryPrefix("pii@example.invalid")).toBeUndefined();
    expect(giftHistoryQueryPrefix("a11ce00")).toBeUndefined();
  });
});
