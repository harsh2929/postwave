import { describe, expect, it } from "vitest";

import {
  conversionRate,
  giftObservations,
  giftStatusLabel,
  giftStatusTone,
  recordHasDataIssue,
  statusDrift,
} from "./giftInsights";
import type {
  GiftHistoryPage,
  GiftHistoryRecord,
  GiftHistoryStats,
} from "./giftSubscriptions";

const ID = "a11ce001-1111-4111-8111-111111111111";

function record(over: Partial<GiftHistoryRecord> = {}): GiftHistoryRecord {
  return {
    id: ID,
    label: "Gift record A11CE001",
    planLabel: "Essentials Monthly",
    durationMonths: 12,
    status: "pending",
    createdAt: "2026-07-01T00:00:00Z",
    redeemedAt: null,
    expiresAt: null,
    canceledAt: null,
    messageRecorded: false,
    providerInvoiceLinked: true,
    gifterMemberLinked: false,
    recipientMemberLinked: false,
    issues: [],
    ...over,
  };
}

function page(over: Partial<GiftHistoryPage> = {}): GiftHistoryPage {
  return {
    items: [record()],
    total: 1,
    limit: 24,
    offset: 0,
    snapshotAt: "2026-07-27T12:00:00Z",
    rejectedRows: 0,
    envelopeIssues: [],
    recognized: true,
    ...over,
  };
}

function stats(over: Partial<GiftHistoryStats> = {}): GiftHistoryStats {
  return {
    total: 5,
    pending: 1,
    paid: 0,
    redeemed: 2,
    cancelled: 1,
    expired: 1,
    refunded: 0,
    unclassified: 0,
    conversionRate: 0.5,
    generatedAt: "2026-07-27T12:00:00Z",
    issues: [],
    ...over,
  };
}

describe("Gift lifecycle presentation", () => {
  it("labels and redundantly tones every state", () => {
    for (const status of [
      "pending",
      "paid",
      "redeemed",
      "cancelled",
      "expired",
      "refunded",
      "unclassified",
    ] as const) {
      expect(giftStatusLabel(status)).not.toBe("");
      expect(giftStatusTone(status)).not.toBe("");
    }
  });

  it("uses the server-approved conversion value and resolved population", () => {
    expect(conversionRate(stats())).toEqual({ rate: 0.5, resolved: 4 });
    expect(
      conversionRate(
        stats({
          redeemed: 0,
          cancelled: 0,
          expired: 0,
          refunded: 0,
          conversionRate: 0,
        }),
      ),
    ).toBeNull();
    expect(conversionRate(null)).toBeNull();
  });
});

describe("integrity observations", () => {
  it("surfaces contained row, envelope and rejection issues as one finding", () => {
    const observations = giftObservations({
      pages: [
        page({
          items: [record({ issues: ["bad timestamp"] })],
          rejectedRows: 1,
          envelopeIssues: ["bad total"],
        }),
      ],
      stats: null,
    });
    expect(observations[0]).toMatchObject({
      id: "integrity",
      severity: "warn",
    });
    expect(recordHasDataIssue(record({ issues: ["bad"] }))).toBe(true);
  });

  it("calls out paid-awaiting-access and unclassified aggregate gaps", () => {
    expect(
      giftObservations({
        pages: [page()],
        stats: stats({ paid: 2, unclassified: 1 }),
      }).map((item) => item.id),
    ).toEqual(["paid", "unclassified"]);
  });

  it("discloses when the archive total changes between fetched pages", () => {
    expect(
      giftObservations({
        pages: [page({ total: 4 }), page({ total: 5, offset: 1 })],
        stats: null,
      }).map((item) => item.id),
    ).toEqual(["page-drift"]);
  });

  it("does not fabricate an all-clear observation", () => {
    expect(giftObservations({ pages: [page()], stats: stats() })).toEqual([]);
  });
});

describe("detail refresh drift", () => {
  it("reports a lifecycle change for the same opaque record", () => {
    expect(statusDrift(record(), record({ status: "redeemed" }))).toEqual({
      from: "pending",
      to: "redeemed",
    });
  });

  it("ignores equal, missing and mismatched records", () => {
    expect(statusDrift(record(), record())).toBeNull();
    expect(statusDrift(record(), null)).toBeNull();
    expect(
      statusDrift(
        record(),
        record({ id: "b0b0f002-2222-4222-8222-222222222222" }),
      ),
    ).toBeNull();
  });
});
