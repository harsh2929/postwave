import { describe, expect, it } from "vitest";

import {
  decodeGiftHistoryPage,
  decodeGiftHistoryRecord,
  decodeGiftHistoryStats,
  giftHistoryCounts,
  giftHistoryMatchesFilter,
  giftHistorySearchPrefix,
  giftHistoryServerFilter,
  giftHistoryState,
  giftStateLabel,
  normalizedGiftStatus,
  sanitizeGiftHistorySearchInput,
  sortGiftHistory,
  type GiftHistoryRecord,
} from "../../components/gifts/gift-history";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";

function wireRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RECORD_ID,
    label: "Gift record 11111111",
    plan_label: "Studio annual",
    duration_months: 12,
    status: "paid",
    created_at: "2026-07-01T09:00:00.000Z",
    redeemed_at: null,
    expires_at: "2027-07-01T09:00:00.000Z",
    canceled_at: null,
    message_recorded: true,
    provider_invoice_linked: true,
    gifter_member_linked: false,
    recipient_member_linked: true,
    ...overrides,
  };
}

function record(overrides: Partial<GiftHistoryRecord> = {}): GiftHistoryRecord {
  return {
    ...decodeGiftHistoryRecord(wireRecord(), 0),
    ...overrides,
  };
}

describe("gift history protocol decoder", () => {
  it("accepts the complete sanitized projection without inventing issues", () => {
    expect(decodeGiftHistoryRecord(wireRecord(), 0)).toEqual({
      key: `gift:${RECORD_ID}`,
      sourceRecordID: RECORD_ID,
      label: "Gift record 11111111",
      planLabel: "Studio annual",
      durationMonths: 12,
      status: "paid",
      createdAt: "2026-07-01T09:00:00.000Z",
      redeemedAt: null,
      expiresAt: "2027-07-01T09:00:00.000Z",
      canceledAt: null,
      messageRecorded: true,
      providerInvoiceLinked: true,
      gifterMemberLinked: false,
      recipientMemberLinked: true,
      issues: [],
    });
  });

  it("flags every forbidden identity, free-text, tenant, token, and provider field", () => {
    const decoded = decodeGiftHistoryRecord(
      wireRecord({
        tenant_id: "tenant-secret",
        purchaser_email: "purchaser@example.com",
        recipient_email: "recipient@example.com",
        message: "private message",
        stripe_invoice_id: "in_secret",
        stripe_payment_url: "https://provider.invalid/pay",
        redemption_url: "https://postwave.invalid/redeem/secret",
        cancel_reason: "private reason",
        gifter_subscriber_id: "gifter-secret",
        gifter_attribution_token: "attribution-secret",
        redeemed_by_subscriber_id: "recipient-secret",
      }),
      0,
    );

    expect(decoded.issues).toHaveLength(11);
    expect(decoded.issues).toEqual(
      expect.arrayContaining([
        'Unexpected sensitive field "tenant_id" crossed the archive boundary.',
        'Unexpected sensitive field "purchaser_email" crossed the archive boundary.',
        'Unexpected sensitive field "recipient_email" crossed the archive boundary.',
        'Unexpected sensitive field "message" crossed the archive boundary.',
        'Unexpected sensitive field "stripe_invoice_id" crossed the archive boundary.',
        'Unexpected sensitive field "stripe_payment_url" crossed the archive boundary.',
        'Unexpected sensitive field "redemption_url" crossed the archive boundary.',
        'Unexpected sensitive field "cancel_reason" crossed the archive boundary.',
        'Unexpected sensitive field "gifter_subscriber_id" crossed the archive boundary.',
        'Unexpected sensitive field "gifter_attribution_token" crossed the archive boundary.',
        'Unexpected sensitive field "redeemed_by_subscriber_id" crossed the archive boundary.',
      ]),
    );
    expect(giftHistoryState(decoded)).toBe("data_issue");
    expect(JSON.stringify(decoded)).not.toContain("purchaser@example.com");
    expect(JSON.stringify(decoded)).not.toContain("in_secret");
  });

  it("uses bounded fallbacks for invalid identifiers, display text, duration, timestamps, and evidence", () => {
    const decoded = decodeGiftHistoryRecord(
      wireRecord({
        id: "not-an-id",
        label: "Unsafe\u202e label",
        plan_label: "",
        duration_months: 61,
        status: "invented",
        created_at: "not-a-date",
        redeemed_at: 42,
        expires_at: "",
        canceled_at: {},
        message_recorded: "yes",
        provider_invoice_linked: null,
        gifter_member_linked: 1,
        recipient_member_linked: undefined,
      }),
      4,
    );

    expect(decoded).toMatchObject({
      key: "gift-row:4",
      sourceRecordID: null,
      label: "Unidentified gift 5",
      planLabel: "Plan unavailable",
      durationMonths: null,
      status: "invented",
      createdAt: null,
      redeemedAt: null,
      expiresAt: null,
      canceledAt: null,
      messageRecorded: null,
      providerInvoiceLinked: null,
      gifterMemberLinked: null,
      recipientMemberLinked: null,
    });
    expect(decoded.issues).toEqual(
      expect.arrayContaining([
        "Archive record identifier is missing or invalid.",
        "Archive label is not safe display text.",
        "Plan label is missing.",
        "Gift duration is outside the supported 1–60 month range.",
        "Lifecycle status is not supported.",
        "Creation timestamp is required.",
      ]),
    );
  });

  it("detects missing terminal evidence, open/terminal conflicts, and reversed chronology", () => {
    const redeemed = decodeGiftHistoryRecord(
      wireRecord({ status: "redeemed", redeemed_at: null }),
      0,
    );
    const cancelled = decodeGiftHistoryRecord(
      wireRecord({ status: "cancelled", canceled_at: null }),
      1,
    );
    const conflicting = decodeGiftHistoryRecord(
      wireRecord({
        status: "pending",
        redeemed_at: "2026-06-01T09:00:00.000Z",
        canceled_at: "2026-06-02T09:00:00.000Z",
      }),
      2,
    );

    expect(redeemed.issues).toContain(
      "Redeemed status has no redemption timestamp.",
    );
    expect(cancelled.issues).toContain(
      "Cancelled status has no cancellation timestamp.",
    );
    expect(conflicting.issues).toEqual(
      expect.arrayContaining([
        "Open status conflicts with a terminal lifecycle timestamp.",
        "Redemption precedes record creation.",
        "Cancellation precedes record creation.",
      ]),
    );
  });

  it("rejects an unrecognized page and contains malformed rows and envelope fields", () => {
    const unrecognized = decodeGiftHistoryPage({ items: "not-an-array" });
    expect(unrecognized).toMatchObject({
      recognized: false,
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    });

    const contained = decodeGiftHistoryPage({
      items: [wireRecord(), "bad row", null],
      total: 0,
      limit: 500,
      offset: -1,
      snapshot_at: "invalid",
    });
    expect(contained).toMatchObject({
      recognized: true,
      total: 1,
      limit: 24,
      offset: 0,
      snapshotAt: null,
      rejectedRows: 2,
    });
    expect(contained.items).toHaveLength(1);
    expect(contained.envelopeIssues).toEqual(
      expect.arrayContaining([
        "Page limit is missing or outside 1–100.",
        "Page offset is missing or outside 0–10,000.",
        "Snapshot timestamp is required.",
        "Total record count is smaller than this page.",
      ]),
    );
  });

  it("bounds hostile page arrays and offsets before they reach the renderer", () => {
    const oversized = decodeGiftHistoryPage({
      items: Array.from({ length: 102 }, (_, index) =>
        wireRecord({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          label: `Gift record ${String(index).padStart(8, "0")}`,
        }),
      ),
      total: 102,
      limit: 24,
      offset: 10_001,
      snapshot_at: "2026-07-27T10:00:00.000Z",
    });

    expect(oversized.items).toHaveLength(100);
    expect(oversized.rejectedRows).toBe(2);
    expect(oversized.offset).toBe(0);
    expect(oversized.envelopeIssues).toEqual(
      expect.arrayContaining([
        "Page offset is missing or outside 0–10,000.",
        "Page contains more than 100 records.",
        "Page contains more records than its declared limit.",
      ]),
    );
  });

  it("validates statistics, preserves unclassified counts, and reports cross-field contradictions", () => {
    expect(decodeGiftHistoryStats(null)).toBeNull();
    expect(
      decodeGiftHistoryStats({
        total: 1,
        pending: -1,
        paid: 0,
        granted: 0,
        canceled: 0,
        expired: 0,
        refunded: 0,
        conversionRate: 0,
        generated_at: "2026-07-27T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      decodeGiftHistoryStats({
        total: 1,
        pending: 0,
        paid: 0,
        granted: 0,
        canceled: 0,
        expired: 0,
        refunded: 0,
        conversionRate: 2,
        generated_at: "2026-07-27T10:00:00.000Z",
      }),
    ).toBeNull();

    const stats = decodeGiftHistoryStats({
      total: 8,
      pending: 2,
      paid: 1,
      granted: 3,
      canceled: 1,
      expired: 0,
      refunded: 0,
      conversionRate: 0.75,
      generated_at: "invalid",
    });
    expect(stats).toMatchObject({
      total: 8,
      pending: 2,
      paid: 1,
      redeemed: 3,
      cancelled: 1,
      unclassified: 1,
      conversionRate: 0.75,
      generatedAt: null,
    });
    expect(stats?.issues).toContain(
      "Statistics generation timestamp is required.",
    );

    const contradictory = decodeGiftHistoryStats({
      total: 1,
      pending: 1,
      paid: 1,
      granted: 1,
      canceled: 1,
      expired: 1,
      refunded: 1,
      conversionRate: 0.5,
      generated_at: "2026-07-27T10:00:00.000Z",
    });
    expect(contradictory?.issues).toContain(
      "Lifecycle counts exceed the total record count.",
    );
    expect(contradictory?.issues).toContain(
      "Conversion rate conflicts with the lifecycle counts.",
    );
    expect(contradictory?.unclassified).toBe(0);
  });
});

describe("gift history lifecycle derivations", () => {
  it("normalizes the complete supported status vocabulary and labels", () => {
    expect(
      [
        "pending",
        "paid",
        "granted",
        "redeemed",
        "active",
        "canceled",
        "cancelled",
        "expired",
        "refunded",
        "unknown",
      ].map(normalizedGiftStatus),
    ).toEqual([
      "pending",
      "paid",
      "redeemed",
      "redeemed",
      "redeemed",
      "cancelled",
      "cancelled",
      "expired",
      "refunded",
      "pending",
    ]);
    expect(
      [
        "pending",
        "paid",
        "redeemed",
        "cancelled",
        "expired",
        "refunded",
        "data_issue",
      ].map((state) =>
        giftStateLabel(state as Parameters<typeof giftStateLabel>[0]),
      ),
    ).toEqual([
      "Pending",
      "Paid · awaiting access",
      "Redeemed",
      "Cancelled",
      "Expired",
      "Refunded",
      "Data issue",
    ]);
  });

  it("counts open, closed, issue, duration, and provider evidence without treating warnings as healthy", () => {
    const records = [
      record({ status: "pending", durationMonths: 1 }),
      record({ status: "paid", durationMonths: 2 }),
      record({
        status: "redeemed",
        redeemedAt: "2026-07-02T09:00:00.000Z",
        durationMonths: 3,
      }),
      record({ status: "expired", durationMonths: null }),
      record({ issues: ["Unsafe boundary"], providerInvoiceLinked: false }),
    ];

    expect(giftHistoryCounts(records)).toEqual({
      all: 5,
      open: 2,
      pending: 1,
      paid: 1,
      redeemed: 1,
      closed: 2,
      cancelled: 0,
      expired: 1,
      refunded: 0,
      data_issue: 1,
      monthsRecorded: 18,
      providerLinked: 4,
    });
  });

  it("matches grouped filters and accepts only a display-label UUID prefix", () => {
    const paid = record();
    const redeemed = record({
      label: "Renewal evidence",
      planLabel: "Essentials",
      status: "redeemed",
      redeemedAt: "2026-07-02T09:00:00.000Z",
    });
    const issue = record({ issues: ["Protocol warning"] });

    expect(giftHistoryMatchesFilter(paid, "open")).toBe(true);
    expect(giftHistoryMatchesFilter(paid, "closed")).toBe(false);
    expect(giftHistoryMatchesFilter(redeemed, "closed")).toBe(true);
    expect(giftHistoryMatchesFilter(redeemed, "redeemed")).toBe(true);
    expect(giftHistoryMatchesFilter(issue, "data_issue")).toBe(true);
    expect(giftHistorySearchPrefix("Gift record 11111111")).toBe("11111111");
    expect(giftHistorySearchPrefix(RECORD_ID)).toBe(
      RECORD_ID.replaceAll("-", ""),
    );
    expect(giftHistorySearchPrefix("renewal")).toBeUndefined();
    expect(giftHistorySearchPrefix("1111111")).toBeUndefined();
    expect(
      sanitizeGiftHistorySearchInput("11111111\u202e@example.invalid"),
    ).toBe("11111111@example.invalid");
  });

  it("sorts on explicit lifecycle fields without mutating the source array", () => {
    const oldest = record({
      key: "oldest",
      label: "Oldest",
      status: "refunded",
      createdAt: "2026-01-01T00:00:00.000Z",
      durationMonths: 1,
    });
    const newest = record({
      key: "newest",
      label: "Newest",
      status: "paid",
      createdAt: "2026-03-01T00:00:00.000Z",
      durationMonths: 3,
    });
    const middle = record({
      key: "middle",
      label: "Middle",
      status: "redeemed",
      createdAt: "2026-02-01T00:00:00.000Z",
      durationMonths: 12,
      redeemedAt: "2026-02-02T00:00:00.000Z",
    });
    const source = [middle, oldest, newest];

    expect(sortGiftHistory(source, "newest").map(({ key }) => key)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(sortGiftHistory(source, "oldest").map(({ key }) => key)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(sortGiftHistory(source, "duration").map(({ key }) => key)).toEqual([
      "middle",
      "newest",
      "oldest",
    ]);
    expect(sortGiftHistory(source, "status").map(({ key }) => key)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(source.map(({ key }) => key)).toEqual([
      "middle",
      "oldest",
      "newest",
    ]);
  });

  it("keeps data-issue review client-contained while forwarding supported server filters", () => {
    expect(giftHistoryServerFilter("data_issue")).toBeUndefined();
    expect(giftHistoryServerFilter("all")).toBe("all");
    expect(giftHistoryServerFilter("open")).toBe("open");
    expect(giftHistoryServerFilter("closed")).toBe("closed");
  });
});
