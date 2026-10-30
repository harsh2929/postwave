import { describe, expect, it } from "vitest";

import {
  RETENTION_RECORD_CAP,
  acceptanceRateOf,
  decodeRetentionFunnel,
  decodeRetentionOffers,
  decodeRetentionTiers,
  decodeRetentionWinbackSettings,
  reconcileRetentionHistory,
  type RetentionFunnelTile,
  type RetentionOfferRecord,
  type RetentionTierRecord,
} from "../lib/retention-offers-contract";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_TENANT_ID = "10000000-0000-4000-8000-000000000002";
const OFFER_1 = "20000000-0000-4000-8000-000000000001";
const OFFER_2 = "20000000-0000-4000-8000-000000000002";
const OFFER_3 = "20000000-0000-4000-8000-000000000003";
const TIER_1 = "30000000-0000-4000-8000-000000000001";
const TIER_2 = "30000000-0000-4000-8000-000000000002";
const TIER_3 = "30000000-0000-4000-8000-000000000003";

function offerWire(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFER_1,
    tenant_id: TENANT_ID,
    paywall_tier_id: TIER_1,
    percent_off: 20,
    duration_months: 3,
    headline: " Stay for the next chapter ",
    body: "A short member-facing description.",
    stripe_coupon_id: "coupon_private_reference",
    active: true,
    created_at: "2026-07-01T09:00:00.123456Z",
    updated_at: "2026-07-03T10:30:00Z",
    ...overrides,
  };
}

function fixedOfferWire(overrides: Record<string, unknown> = {}) {
  const {
    percent_off: _percentOff,
    headline: _headline,
    body: _body,
    stripe_coupon_id: _providerReference,
    ...row
  } = offerWire();
  return { ...row, fixed_off_cents: 725, ...overrides };
}

function tileWire(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: OFFER_1,
    tier_id: TIER_1,
    shown: 12,
    accepted: 3,
    declined: 6,
    expired: 1,
    acceptance_rate: 0.25,
    ...overrides,
  };
}

function tierWire(overrides: Record<string, unknown> = {}) {
  return {
    id: TIER_1,
    name: "Founding members",
    active: true,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-07-02T09:00:00Z",
    ...overrides,
  };
}

function offer(
  overrides: Partial<RetentionOfferRecord> = {},
): RetentionOfferRecord {
  return {
    id: OFFER_1,
    tierId: TIER_1,
    discount: { kind: "percent", percent: 20 },
    durationMonths: 3,
    headline: "Stay for the next chapter",
    body: "A short member-facing description.",
    providerCouponPresent: true,
    active: true,
    createdAt: "2026-07-01T09:00:00.123Z",
    updatedAt: "2026-07-03T10:30:00.000Z",
    ...overrides,
  };
}

function tile(
  overrides: Partial<RetentionFunnelTile> = {},
): RetentionFunnelTile {
  return {
    offerId: OFFER_1,
    tierId: TIER_1,
    shown: 12,
    accepted: 3,
    declined: 6,
    expired: 1,
    ...overrides,
  };
}

function tier(
  overrides: Partial<RetentionTierRecord> = {},
): RetentionTierRecord {
  return { id: TIER_1, name: "Founding members", active: true, ...overrides };
}

describe("retention offer response contract", () => {
  it("decodes the exact counted envelope into a privacy-minimized projection", () => {
    const result = decodeRetentionOffers(
      { offers: [offerWire()], count: 1 },
      { expectedTenantId: TENANT_ID },
    );
    expect(result).toEqual({
      ok: true,
      data: {
        reportedCount: 1,
        items: [
          {
            id: OFFER_1,
            tierId: TIER_1,
            discount: { kind: "percent", percent: 20 },
            durationMonths: 3,
            headline: "Stay for the next chapter",
            body: "A short member-facing description.",
            providerCouponPresent: true,
            active: true,
            createdAt: "2026-07-01T09:00:00.123Z",
            updatedAt: "2026-07-03T10:30:00.000Z",
          },
        ],
      },
    });
    if (!result.ok) throw new Error("fixture should decode");
    expect(result.data.items[0]).not.toHaveProperty("tenant_id");
    expect(result.data.items[0]).not.toHaveProperty("stripe_coupon_id");
    expect(result.data.items[0]).not.toHaveProperty("ignored");
    expect(JSON.stringify(result.data)).not.toContain(
      "coupon_private_reference",
    );
    expect(
      decodeRetentionOffers({
        offers: [offerWire({ ignored: "contract drift" })],
        count: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
  });

  it("preserves fixed minor units without assigning a currency", () => {
    const result = decodeRetentionOffers({
      offers: [fixedOfferWire()],
      count: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            discount: { kind: "fixed", minorUnits: 725, currency: null },
            headline: null,
            body: null,
            providerCouponPresent: false,
          },
        ],
      },
    });
  });

  it.each([
    null,
    undefined,
    [],
    "payload",
    4,
    {},
    { offers: "not-an-array", count: 0 },
    { offers: [], count: 0, extra: true },
  ])("fails closed for malformed envelopes without throwing: %j", (value) => {
    expect(() => decodeRetentionOffers(value)).not.toThrow();
    expect(decodeRetentionOffers(value)).toEqual({
      ok: false,
      reason: "invalid-envelope",
    });
  });

  it("requires an exact non-negative integer count", () => {
    for (const count of [undefined, null, "1", -1, 0, 1.5, 2]) {
      expect(decodeRetentionOffers({ offers: [offerWire()], count })).toEqual({
        ok: false,
        reason: "count-mismatch",
      });
    }
  });

  it("rejects, rather than truncates, an over-cap collection", () => {
    const offers = Array.from({ length: RETENTION_RECORD_CAP + 1 }, () =>
      offerWire(),
    );
    expect(decodeRetentionOffers({ offers, count: offers.length })).toEqual({
      ok: false,
      reason: "too-many-records",
    });
  });

  it("fails the whole collection when any row is malformed and locates it", () => {
    expect(
      decodeRetentionOffers({
        offers: [offerWire(), { ...offerWire(), active: "true" }],
        count: 2,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 1 });
  });

  it("validates and discards tenant identity, including cross-tenant rows", () => {
    expect(
      decodeRetentionOffers(
        {
          offers: [offerWire({ tenant_id: OTHER_TENANT_ID })],
          count: 1,
        },
        { expectedTenantId: TENANT_ID },
      ),
    ).toEqual({ ok: false, reason: "tenant-mismatch", recordIndex: 0 });
    expect(
      decodeRetentionOffers(
        { offers: [], count: 0 },
        { expectedTenantId: "../unsafe" },
      ),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
  });

  it.each([
    { id: ` ${OFFER_1}` },
    { id: "not-a-uuid" },
    { tenant_id: undefined },
    { paywall_tier_id: "<script>" },
  ])("rejects unsafe or missing UUID identities: %j", (overrides) => {
    expect(
      decodeRetentionOffers({
        offers: [offerWire(overrides)],
        count: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
  });

  it("normalizes UUID casing but rejects duplicate offer or tier identities", () => {
    const uppercase = offerWire({
      id: OFFER_1.toUpperCase(),
      tenant_id: TENANT_ID.toUpperCase(),
      paywall_tier_id: TIER_1.toUpperCase(),
    });
    const decoded = decodeRetentionOffers({ offers: [uppercase], count: 1 });
    expect(decoded).toMatchObject({
      ok: true,
      data: { items: [{ id: OFFER_1, tierId: TIER_1 }] },
    });

    expect(
      decodeRetentionOffers({
        offers: [offerWire(), offerWire({ paywall_tier_id: TIER_2 })],
        count: 2,
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate-identity",
      recordIndex: 1,
    });
    expect(
      decodeRetentionOffers({
        offers: [offerWire(), offerWire({ id: OFFER_2 })],
        count: 2,
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate-identity",
      recordIndex: 1,
    });
  });

  it.each([
    { percent_off: 0 },
    { percent_off: 101 },
    { percent_off: 10.5 },
    { percent_off: null, fixed_off_cents: 0 },
    { percent_off: null, fixed_off_cents: 4.5 },
    { fixed_off_cents: 500 },
    { percent_off: null, fixed_off_cents: null },
    { duration_months: 0 },
    { duration_months: 61 },
  ])("rejects impossible offer amount or duration shapes: %j", (overrides) => {
    expect(
      decodeRetentionOffers({
        offers: [offerWire(overrides)],
        count: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
  });

  it("bounds and sanitizes display strings while preserving meaningful Unicode", () => {
    const good = decodeRetentionOffers({
      offers: [
        offerWire({
          headline: "  مرحباً   members \n again  ",
          body: "  Line one\r\nLine two\rLong unbroken line  ",
        }),
      ],
      count: 1,
    });
    expect(good).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            headline: "مرحباً members again",
            body: "Line one\nLine two\nLong unbroken line",
          },
        ],
      },
    });

    for (const headline of [
      "x".repeat(1_001),
      "😀".repeat(251),
      "unsafe\u0000copy",
      "spoof\u202ecopy",
    ]) {
      expect(
        decodeRetentionOffers({
          offers: [offerWire({ headline })],
          count: 1,
        }),
      ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    }
    expect(
      decodeRetentionOffers({
        offers: [offerWire({ body: "x".repeat(10_001) })],
        count: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    for (const body of ["unsafe\u0000copy", "spoof\u202ecopy"]) {
      expect(
        decodeRetentionOffers({
          offers: [offerWire({ body })],
          count: 1,
        }),
      ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    }
  });

  it("requires real ISO instants in causal order", () => {
    for (const overrides of [
      { created_at: "yesterday" },
      { created_at: "2026-02-31T09:00:00Z" },
      { created_at: "2026-07-01" },
      { created_at: "2026-07-04T00:00:00Z" },
    ]) {
      expect(
        decodeRetentionOffers({
          offers: [offerWire(overrides)],
          count: 1,
        }),
      ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    }
  });

  it("bounds provider references without exposing their value", () => {
    for (const reference of [
      ` ${"coupon"}`,
      "x".repeat(513),
      "coupon\u0000bad",
      42,
    ]) {
      expect(
        decodeRetentionOffers({
          offers: [offerWire({ stripe_coupon_id: reference })],
          count: 1,
        }),
      ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    }
  });
});

describe("retention funnel response contract", () => {
  it("decodes all four lifecycle counts and discards the wire rate", () => {
    const result = decodeRetentionFunnel({
      tiles: [tileWire()],
      count: 1,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        reportedCount: 1,
        items: [
          {
            offerId: OFFER_1,
            tierId: TIER_1,
            shown: 12,
            accepted: 3,
            declined: 6,
            expired: 1,
          },
        ],
      },
    });
    if (!result.ok) throw new Error("fixture should decode");
    expect(result.data.items[0]).not.toHaveProperty("acceptance_rate");
  });

  it("enforces the envelope count and collection cap", () => {
    expect(decodeRetentionFunnel({ tiles: [tileWire()], count: 0 })).toEqual({
      ok: false,
      reason: "count-mismatch",
    });
    const tiles = Array.from({ length: RETENTION_RECORD_CAP + 1 }, () =>
      tileWire(),
    );
    expect(decodeRetentionFunnel({ tiles, count: tiles.length })).toEqual({
      ok: false,
      reason: "too-many-records",
    });
    expect(
      decodeRetentionFunnel({ tiles: [], count: 0, extra: true }),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
  });

  it.each([
    { shown: -1 },
    { accepted: 1.5 },
    { declined: undefined },
    { expired: Number.MAX_SAFE_INTEGER },
    { offer_id: "unsafe" },
    { tier_id: ` ${TIER_1}` },
    { acceptance_rate: 0.99 },
    { acceptance_rate: undefined },
    { extra: true },
  ])("rejects malformed tile identities and counts: %j", (overrides) => {
    expect(
      decodeRetentionFunnel({
        tiles: [tileWire(overrides)],
        count: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
  });

  it("preserves duplicate tiles so reconciliation can expose ambiguity", () => {
    const result = decodeRetentionFunnel({
      tiles: [
        tileWire(),
        tileWire({ shown: 99, acceptance_rate: 3 / 99 }),
      ],
      count: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { items: [{ shown: 12 }, { shown: 99 }] },
    });
  });

  it("recomputes rates from counts and distinguishes no denominator", () => {
    expect(acceptanceRateOf(tile({ shown: 12, accepted: 3 }))).toBe(0.25);
    expect(acceptanceRateOf(tile({ shown: 0, accepted: 0 }))).toBeNull();
    expect(acceptanceRateOf(null)).toBeNull();
    expect(acceptanceRateOf(tile({ shown: 2, accepted: 3 }))).toBeNull();
  });
});

describe("supporting retention read contracts", () => {
  it("decodes only bounded tier identity, name, and state", () => {
    const result = decodeRetentionTiers({
      tiers: [
        tierWire({
          name: " Founding   members ",
          description: "discarded",
          stripePriceId: "price_private",
        }),
      ],
    });
    expect(result).toEqual({
      ok: true,
      data: {
        items: [{ id: TIER_1, name: "Founding members", active: true }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("price_private");
  });

  it("rejects malformed, duplicate, and over-cap tier catalogues", () => {
    expect(
      decodeRetentionTiers({ tiers: [tierWire({ name: "" })] }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    expect(
      decodeRetentionTiers({
        tiers: [
          tierWire({ name: "One" }),
          tierWire({ name: "Two", active: false }),
        ],
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate-identity",
      recordIndex: 1,
    });
    expect(
      decodeRetentionTiers({
        tiers: Array.from({ length: RETENTION_RECORD_CAP + 1 }, () => ({
          ...tierWire({ name: "One" }),
        })),
      }),
    ).toEqual({ ok: false, reason: "too-many-records" });
    expect(
      decodeRetentionTiers({ tiers: [tierWire({ extra: true })] }),
    ).toEqual({ ok: false, reason: "invalid-record", recordIndex: 0 });
    expect(
      decodeRetentionTiers({ tiers: [tierWire()], extra: true }),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
  });

  it("strictly decodes direct win-back settings without defaulting unknown data", () => {
    expect(
      decodeRetentionWinbackSettings({
        enabled: true,
        churn_threshold: 0.7,
        churn_profiles_scored: 12_450,
      }),
    ).toEqual({
      ok: true,
      data: {
        enabled: true,
        churnThreshold: 0.7,
        churnProfilesScored: 12_450,
      },
    });
    for (const value of [
      null,
      {},
      { enabled: false, churn_threshold: 0, churn_profiles_scored: 0 },
      { enabled: false, churn_threshold: 1.01, churn_profiles_scored: 0 },
      {
        enabled: "false",
        churn_threshold: 0.7,
        churn_profiles_scored: 0,
      },
      { enabled: false, churn_threshold: 0.7, churn_profiles_scored: -1 },
      {
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: 0,
        extra: true,
      },
    ]) {
      expect(decodeRetentionWinbackSettings(value)).toEqual({
        ok: false,
        reason: "invalid-record",
      });
    }
  });
});

describe("retention offer/funnel reconciliation", () => {
  it("marks every row unknown when the independently loaded funnel is unavailable", () => {
    const result = reconcileRetentionHistory(
      [offer(), offer({ id: OFFER_2, tierId: TIER_2 })],
      null,
      [tier()],
    );
    expect(result.integrity).toBe("unavailable");
    expect(result.sourceTileCount).toBeNull();
    expect(result.rows.map((row) => row.funnelState)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    expect(result.rows[0]?.tierName).toBe("Founding members");
    expect(result.missingTileOfferIds).toEqual([]);
    expect(result.matchedTotals).toEqual({
      shown: 0,
      accepted: 0,
      declined: 0,
      expired: 0,
    });
  });

  it("distinguishes a loaded zero tile from a missing tile", () => {
    const result = reconcileRetentionHistory(
      [offer(), offer({ id: OFFER_2, tierId: TIER_2 })],
      [tile({ shown: 0, accepted: 0, declined: 0, expired: 0 })],
    );
    expect(result.rows[0]).toMatchObject({
      funnelState: "matched",
      funnel: { shown: 0 },
    });
    expect(result.rows[1]).toMatchObject({
      funnelState: "missing",
      funnel: null,
    });
    expect(result.missingTileOfferIds).toEqual([OFFER_2]);
    expect(result.integrity).toBe("inconsistent");
  });

  it("never overwrites duplicate tiles with an arbitrary winner", () => {
    const result = reconcileRetentionHistory(
      [offer()],
      [tile({ shown: 2 }), tile({ shown: 200 })],
    );
    expect(result.rows[0]).toMatchObject({
      funnelState: "duplicate",
      funnel: null,
    });
    expect(result.duplicateTileOfferIds).toEqual([OFFER_1]);
    expect(result.matchedTotals.shown).toBe(0);
  });

  it("reports orphan and tier-mismatched tiles without attaching them", () => {
    const result = reconcileRetentionHistory(
      [offer()],
      [tile({ tierId: TIER_2 }), tile({ offerId: OFFER_3, tierId: TIER_3 })],
    );
    expect(result.rows[0]).toMatchObject({
      funnelState: "tier-mismatch",
      funnel: null,
    });
    expect(result.tierMismatchOfferIds).toEqual([OFFER_1]);
    expect(result.orphanTileOfferIds).toEqual([OFFER_3]);
    expect(result.integrity).toBe("inconsistent");
  });

  it("returns deterministic anomaly IDs and includes duplicate orphans in both facts", () => {
    const result = reconcileRetentionHistory(
      [
        offer({ id: OFFER_2, tierId: TIER_2 }),
        offer({ id: OFFER_1, tierId: TIER_1 }),
      ],
      [
        tile({ offerId: OFFER_3, tierId: TIER_3 }),
        tile({ offerId: OFFER_3, tierId: TIER_3 }),
      ],
    );
    expect(result.missingTileOfferIds).toEqual([OFFER_1, OFFER_2]);
    expect(result.duplicateTileOfferIds).toEqual([OFFER_3]);
    expect(result.orphanTileOfferIds).toEqual([OFFER_3]);
  });

  it("sums only unambiguous matched tiles and flags excess outcomes", () => {
    const result = reconcileRetentionHistory(
      [offer(), offer({ id: OFFER_2, tierId: TIER_2 })],
      [
        tile({ shown: 10, accepted: 2, declined: 6, expired: 1 }),
        tile({
          offerId: OFFER_2,
          tierId: TIER_2,
          shown: 2,
          accepted: 2,
          declined: 1,
          expired: 0,
        }),
      ],
    );
    expect(result.matchedTotals).toEqual({
      shown: 10,
      accepted: 2,
      declined: 6,
      expired: 1,
    });
    expect(result.rows[1]).toMatchObject({
      funnelState: "outcome-excess",
      funnel: { shown: 2, accepted: 2, declined: 1 },
    });
    expect(result.outcomeExcessOfferIds).toEqual([OFFER_2]);
    expect(result.integrity).toBe("inconsistent");
  });

  it("reports a fully reconciled collection only for exact one-to-one matches", () => {
    const result = reconcileRetentionHistory(
      [offer(), offer({ id: OFFER_2, tierId: TIER_2 })],
      [tile(), tile({ offerId: OFFER_2, tierId: TIER_2 })],
      [tier(), tier({ id: TIER_2, name: "Annual", active: false })],
    );
    expect(result.integrity).toBe("reconciled");
    expect(result.rows.map((row) => row.funnelState)).toEqual([
      "matched",
      "matched",
    ]);
    expect(result.rows.map((row) => row.tierName)).toEqual([
      "Founding members",
      "Annual",
    ]);
    expect(result).toMatchObject({
      missingTileOfferIds: [],
      duplicateTileOfferIds: [],
      orphanTileOfferIds: [],
      tierMismatchOfferIds: [],
      outcomeExcessOfferIds: [],
    });
  });
});
