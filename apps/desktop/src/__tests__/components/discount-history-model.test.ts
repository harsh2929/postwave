import { describe, expect, it } from "vitest";

import {
  decodeDiscountHistoryPayload,
  discountAppliesLabel,
  discountBenefitLabel,
  discountHistoryCounts,
  discountHistoryMatchesFilter,
  discountHistoryMatchesSearch,
  discountHistoryState,
  discountStateLabel,
  sortDiscountHistory,
  type DiscountHistoryRecord,
} from "../../components/discounts/discount-history";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const validRow = {
  id: RECORD_ID,
  label: "Launch archive",
  percent_off: 20,
  amount_off_cents: null,
  currency: "usd",
  max_redemptions: 100,
  times_redeemed: 12,
  expires_at: "2099-12-31T23:59:59.000Z",
  applies_to: "both",
  created_at: "2026-07-01T09:00:00.000Z",
};

function record(
  overrides: Partial<DiscountHistoryRecord> = {},
): DiscountHistoryRecord {
  return {
    key: `id:${RECORD_ID}`,
    id: RECORD_ID,
    label: "Launch archive",
    sourceRecordID: RECORD_ID,
    percentOff: 20,
    amountOffCents: null,
    currency: "USD",
    maxRedemptions: 100,
    timesRedeemed: 12,
    expiresAt: "2099-12-31T23:59:59.000Z",
    appliesTo: "both",
    createdAt: "2026-07-01T09:00:00.000Z",
    issues: [],
    ...overrides,
  };
}

describe("discount history model", () => {
  it.each([
    ["array", [validRow]],
    ["items", { items: [validRow] }],
    ["data", { data: [validRow] }],
    ["results", { results: [validRow] }],
  ])("strictly decodes the supported %s envelope", (_name, payload) => {
    const decoded = decodeDiscountHistoryPayload(payload);

    expect(decoded).toMatchObject({
      recognized: true,
      rejectedRows: 0,
    });
    expect(decoded.items).toEqual([
      expect.objectContaining({
        id: RECORD_ID,
        key: `id:${RECORD_ID}`,
        label: "Launch archive",
        sourceRecordID: RECORD_ID,
        percentOff: 20,
        amountOffCents: null,
        currency: "USD",
        maxRedemptions: 100,
        timesRedeemed: 12,
        appliesTo: "both",
        issues: [],
      }),
    ]);
  });

  it("distinguishes an unrecognized payload from a recognized empty archive", () => {
    for (const payload of [
      null,
      "not-an-envelope",
      {},
      { items: {} },
      { data: null },
    ]) {
      expect(decodeDiscountHistoryPayload(payload)).toEqual({
        items: [],
        rejectedRows: 0,
        recognized: false,
      });
    }

    expect(decodeDiscountHistoryPayload({ items: [] })).toEqual({
      items: [],
      rejectedRows: 0,
      recognized: true,
    });
  });

  it("rejects non-object rows while retaining malformed objects as reviewable evidence", () => {
    const decoded = decodeDiscountHistoryPayload({
      items: [
        null,
        "not-a-row",
        [],
        {
          id: "not-an-opaque-id",
          label: " \u202eambiguous",
          code: "LEGACY-REDEEMABLE-SECRET",
          percent_off: 0,
          amount_off_cents: 1.5,
          currency: "US",
          max_redemptions: -2,
          times_redeemed: -1,
          expires_at: "not-a-timestamp",
          applies_to: "sometimes",
          created_at: "also-not-a-timestamp",
        },
      ],
    });

    expect(decoded.recognized).toBe(true);
    expect(decoded.rejectedRows).toBe(3);
    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({
      id: "not-an-opaque-id",
      label: "Unidentified record 4",
      sourceRecordID: null,
      percentOff: null,
      amountOffCents: null,
      currency: "USD",
      maxRedemptions: null,
      timesRedeemed: 0,
      expiresAt: "not-a-timestamp",
      appliesTo: "unknown",
      createdAt: "also-not-a-timestamp",
    });
    expect(decoded.items[0]?.issues).toEqual(
      expect.arrayContaining([
        "Archive label contains control or bidirectional formatting characters.",
        "Archive record identifier is invalid.",
        "Percent benefit is outside the supported 1–100 range.",
        "Fixed benefit is not a positive whole-cent amount.",
        "No valid discount benefit is present.",
        "Fixed benefit has an invalid ISO currency code.",
        "Recorded redemption count is missing or invalid.",
        "Redemption cap is not a positive whole number.",
        "Expiry timestamp is invalid.",
        "Creation timestamp is invalid.",
        "Application scope is missing or unsupported.",
      ]),
    );
    expect(JSON.stringify(decoded.items)).not.toContain(
      "LEGACY-REDEEMABLE-SECRET",
    );
  });

  it("flags missing identity and mutually exclusive benefit violations", () => {
    const missingIdentity = decodeDiscountHistoryPayload({
      items: [
        {
          label: "No identity",
          percent_off: 10,
          times_redeemed: 0,
          applies_to: "first_payment",
        },
      ],
    }).items[0];
    expect(missingIdentity?.sourceRecordID).toBeNull();
    expect(missingIdentity?.issues).toContain(
      "Archive record identifier is missing.",
    );

    const bothBenefits = decodeDiscountHistoryPayload({
      items: [
        {
          ...validRow,
          amount_off_cents: 500,
        },
      ],
    }).items[0];
    expect(bothBenefits).toMatchObject({
      percentOff: 20,
      amountOffCents: 500,
    });
    expect(bothBenefits?.issues).toContain(
      "Both percent and fixed benefits are present.",
    );
  });

  it("applies integrity, expiry, and cap state precedence deterministically", () => {
    expect(
      discountHistoryState(
        record({
          issues: ["Stored value is untrusted."],
          expiresAt: "2020-01-01T00:00:00.000Z",
          maxRedemptions: 1,
          timesRedeemed: 1,
        }),
        NOW,
      ),
    ).toBe("data_issue");
    expect(
      discountHistoryState(
        record({
          expiresAt: "2020-01-01T00:00:00.000Z",
          maxRedemptions: 1,
          timesRedeemed: 1,
        }),
        NOW,
      ),
    ).toBe("expired");
    expect(
      discountHistoryState(
        record({
          expiresAt: null,
          maxRedemptions: 12,
          timesRedeemed: 12,
        }),
        NOW,
      ),
    ).toBe("cap_reached");
    expect(discountHistoryState(record(), NOW)).toBe("within_stored_rules");
  });

  it("counts recorded evidence and implements the combined closed filter", () => {
    const records = [
      record({ label: "Open", timesRedeemed: 2 }),
      record({
        label: "Expired",
        expiresAt: "2020-01-01T00:00:00.000Z",
        timesRedeemed: 3,
      }),
      record({
        label: "Capped",
        expiresAt: null,
        maxRedemptions: 4,
        timesRedeemed: 4,
      }),
      record({
        label: "Review",
        issues: ["Invalid source."],
        timesRedeemed: 5,
      }),
    ];

    expect(discountHistoryCounts(records, NOW)).toEqual({
      all: 4,
      within_stored_rules: 1,
      expired: 1,
      cap_reached: 1,
      data_issue: 1,
      closed: 2,
      recordedRedemptions: 14,
    });
    expect(
      records
        .filter((item) => discountHistoryMatchesFilter(item, "closed", NOW))
        .map((item) => item.label),
    ).toEqual(["Expired", "Capped"]);
    expect(discountHistoryMatchesFilter(records[3]!, "data_issue", NOW)).toBe(
      true,
    );
  });

  it("searches only display-safe record fields", () => {
    const item = record({
      label: "Partner launch",
      percentOff: null,
      amountOffCents: 1250,
      currency: "EUR",
      appliesTo: "recurring",
    });

    for (const query of [" partner ", "EUR", "recurring", "1250"]) {
      expect(discountHistoryMatchesSearch(item, query)).toBe(true);
    }
    expect(discountHistoryMatchesSearch(item, "")).toBe(true);
    expect(discountHistoryMatchesSearch(item, "redeemable-secret")).toBe(false);
  });

  it("sorts copies predictably without mutating the source order", () => {
    const archive10 = record({
      key: "10",
      label: "Archive 10",
      timesRedeemed: 7,
      createdAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    const archive2 = record({
      key: "2",
      label: "Archive 2",
      timesRedeemed: 7,
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    const undated = record({
      key: "none",
      label: "Undated",
      timesRedeemed: 1,
      createdAt: null,
      expiresAt: null,
    });
    const source = [archive10, undated, archive2];

    expect(
      sortDiscountHistory(source, "label").map((item) => item.label),
    ).toEqual(["Archive 2", "Archive 10", "Undated"]);
    expect(
      sortDiscountHistory(source, "newest").map((item) => item.label),
    ).toEqual(["Archive 10", "Archive 2", "Undated"]);
    expect(
      sortDiscountHistory(source, "oldest").map((item) => item.label),
    ).toEqual(["Archive 2", "Archive 10", "Undated"]);
    expect(
      sortDiscountHistory(source, "redemptions").map((item) => item.label),
    ).toEqual(["Archive 10", "Archive 2", "Undated"]);
    expect(
      sortDiscountHistory(source, "expiry").map((item) => item.label),
    ).toEqual(["Archive 2", "Archive 10", "Undated"]);
    expect(source).toEqual([archive10, undated, archive2]);
  });

  it("formats benefits, scope, and state with truthful fallback copy", () => {
    expect(discountBenefitLabel(record({ percentOff: 25 }))).toBe("25% off");
    expect(
      discountBenefitLabel(record({ percentOff: null, amountOffCents: null })),
    ).toBe("Benefit unavailable");

    expect(discountAppliesLabel("first_payment")).toBe("First payment");
    expect(discountAppliesLabel("recurring")).toBe("Recurring");
    expect(discountAppliesLabel("both")).toBe("First + recurring");
    expect(discountAppliesLabel("unknown")).toBe("Scope unavailable");
    expect(discountStateLabel("within_stored_rules")).toBe(
      "Within stored rules",
    );
    expect(discountStateLabel("expired")).toBe("Expired in record");
    expect(discountStateLabel("cap_reached")).toBe("Recorded cap reached");
    expect(discountStateLabel("data_issue")).toBe("Data needs review");
  });

  it.each([
    ["USD", 1250, 12.5],
    ["JPY", 1250, 1250],
    ["KWD", 1250, 1.25],
  ])(
    "formats %s fixed benefits with the currency's minor-unit precision",
    (currency, storedMinorUnits, expectedMajorUnits) => {
      const expected = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(expectedMajorUnits);

      expect(
        discountBenefitLabel(
          record({
            percentOff: null,
            amountOffCents: storedMinorUnits,
            currency,
          }),
        ),
      ).toBe(`${expected} off`);
    },
  );
});
