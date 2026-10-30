// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  RetentionOffersContractError,
  formatAcceptanceRate,
  formatChurnThreshold,
  formatOfferDiscount,
  hasRetentionOutcomeConflict,
  parseRetentionFunnel,
  parseRetentionOffers,
  parseWinbackSettings,
} from "@/lib/retention-offers-api";
import {
  canAccessRetentionOffers,
  isRetentionOffersRoute,
  retentionEffectiveRole,
} from "@/lib/retention-offers-access";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OFFER_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID_2 = "33333333-3333-4333-8333-333333333333";
const TIER_ID = "44444444-4444-4444-8444-444444444444";
const TIER_ID_2 = "55555555-5555-4555-8555-555555555555";

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFER_ID,
    tenant_id: TENANT_ID,
    paywall_tier_id: TIER_ID,
    percent_off: 20,
    duration_months: 3,
    headline: "Stay with us",
    body: "A stored offer row.",
    stripe_coupon_id: "coupon_reference",
    active: false,
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:01:00Z",
    ...overrides,
  };
}

function fixedOffer(overrides: Record<string, unknown> = {}) {
  const { percent_off: _percentOff, ...row } = offer({
    id: OFFER_ID_2,
    paywall_tier_id: TIER_ID_2,
  });
  return { ...row, fixed_off_cents: 500, ...overrides };
}

function tile(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: OFFER_ID,
    tier_id: TIER_ID,
    shown: 4,
    accepted: 1,
    declined: 2,
    expired: 1,
    acceptance_rate: 0.25,
    ...overrides,
  };
}

function expectContractFailure(run: () => unknown): void {
  expect(run).toThrow(RetentionOffersContractError);
}

describe("retention-offers response contracts", () => {
  it("accepts exact settings and rejects absent, defaultable, or out-of-range facts", () => {
    expect(
      parseWinbackSettings({
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: 12,
      }),
    ).toEqual({
      enabled: false,
      churn_threshold: 0.7,
      churn_profiles_scored: 12,
    });
    for (const invalid of [
      { churn_threshold: 0.7, churn_profiles_scored: 12 },
      { enabled: "false", churn_threshold: 0.7, churn_profiles_scored: 12 },
      { enabled: false, churn_threshold: -0.1, churn_profiles_scored: 12 },
      { enabled: true, churn_threshold: 0, churn_profiles_scored: 0 },
      { enabled: false, churn_threshold: 1.1, churn_profiles_scored: 12 },
      { enabled: false, churn_threshold: 0.7, churn_profiles_scored: -1 },
      { enabled: false, churn_threshold: 0.7, churn_profiles_scored: 1.5 },
      {
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: 12,
        unrecognized: true,
      },
    ]) {
      expectContractFailure(() => parseWinbackSettings(invalid));
    }
  });

  it("decodes exact offer rows, preserves false, and enforces count parity", () => {
    expect(
      parseRetentionOffers(
        { offers: [offer(), fixedOffer()], count: 2 },
        TENANT_ID,
      ),
    ).toEqual({
      offers: [
        {
          id: OFFER_ID,
          paywall_tier_id: TIER_ID,
          percent_off: 20,
          duration_months: 3,
          headline: "Stay with us",
          body: "A stored offer row.",
          active: false,
          created_at: "2026-08-30T10:00:00Z",
          updated_at: "2026-08-30T10:01:00Z",
          // Presence only — the coupon id itself never leaves the decoder.
          provider_coupon_present: true,
        },
        {
          id: OFFER_ID_2,
          paywall_tier_id: TIER_ID_2,
          fixed_off_cents: 500,
          duration_months: 3,
          headline: "Stay with us",
          body: "A stored offer row.",
          active: false,
          created_at: "2026-08-30T10:00:00Z",
          updated_at: "2026-08-30T10:01:00Z",
          provider_coupon_present: true,
        },
      ],
      count: 2,
    });
    const { stripe_coupon_id: _coupon, ...noCoupon } = offer();
    expect(
      parseRetentionOffers({ offers: [noCoupon], count: 1 }).offers[0]
        ?.provider_coupon_present,
    ).toBe(false);
    expect(parseRetentionOffers({ offers: [], count: 0 })).toEqual({
      offers: [],
      count: 0,
    });
    expectContractFailure(() =>
      parseRetentionOffers({ offers: [offer()], count: 0 }),
    );
  });

  it("rejects malformed UUIDs, required fields, bounds, XOR drift, and extras", () => {
    const { active: _active, ...missingActive } = offer();
    const { percent_off: _percentOff, ...noAmount } = offer();
    const invalidRows = [
      offer({ id: "not-a-uuid" }),
      missingActive,
      offer({ active: "true" }),
      offer({ duration_months: 0 }),
      offer({ duration_months: 61 }),
      offer({ percent_off: 0 }),
      offer({ percent_off: 101 }),
      offer({ percent_off: 20.5 }),
      offer({ fixed_off_cents: 500 }),
      noAmount,
      fixedOffer({ fixed_off_cents: -1 }),
      fixedOffer({ fixed_off_cents: Number.MAX_SAFE_INTEGER }),
      offer({ headline: "x".repeat(1_001) }),
      offer({ headline: "😀".repeat(251) }),
      offer({ headline: "unsafe\u202evalue" }),
      offer({ created_at: "2026-02-30T10:00:00Z" }),
      offer({ updated_at: "2026-08-29T10:00:00Z" }),
      offer({ unexpected: "contract drift" }),
    ];
    for (const row of invalidRows) {
      expectContractFailure(() =>
        parseRetentionOffers({ offers: [row], count: 1 }),
      );
    }
  });

  it("rejects duplicate offer or tier identities, tenant mixing, and oversized pages", () => {
    expectContractFailure(() =>
      parseRetentionOffers({
        offers: [offer(), offer({ paywall_tier_id: TIER_ID_2 })],
        count: 2,
      }),
    );
    expectContractFailure(() =>
      parseRetentionOffers(
        { offers: [offer()], count: 1 },
        "66666666-6666-4666-8666-666666666666",
      ),
    );
    expectContractFailure(() =>
      parseRetentionOffers({ offers: [], count: 0 }, "not-a-uuid"),
    );
    expectContractFailure(() =>
      parseRetentionOffers({
        offers: [offer(), offer({ id: OFFER_ID_2 })],
        count: 2,
      }),
    );
    expectContractFailure(() =>
      parseRetentionOffers({
        offers: [
          offer(),
          fixedOffer({ tenant_id: "66666666-6666-4666-8666-666666666666" }),
        ],
        count: 2,
      }),
    );
    expectContractFailure(() =>
      parseRetentionOffers({
        offers: Array.from({ length: 1_001 }, () => offer()),
        count: 1_001,
      }),
    );
  });

  it("validates funnel identities, safe counters, rates, duplicates, and envelope count", () => {
    expect(parseRetentionFunnel({ tiles: [tile()], count: 1 })).toEqual({
      tiles: [tile()],
      count: 1,
    });
    expect(
      parseRetentionFunnel({
        tiles: [
          tile({
            shown: 0,
            accepted: 0,
            declined: 0,
            expired: 0,
            acceptance_rate: 0,
          }),
        ],
        count: 1,
      }),
    ).toBeTruthy();

    const invalidRows = [
      tile({ offer_id: "bad" }),
      tile({ shown: -1 }),
      tile({ shown: 1.5 }),
      tile({ shown: Math.floor(Number.MAX_SAFE_INTEGER / 4_000) + 1 }),
      tile({ shown: Number.MAX_SAFE_INTEGER + 1 }),
      tile({ accepted: 5 }),
      tile({ acceptance_rate: -0.1 }),
      tile({ acceptance_rate: 0.5 }),
      { ...tile(), extra: true },
    ];
    for (const row of invalidRows) {
      expectContractFailure(() =>
        parseRetentionFunnel({ tiles: [row], count: 1 }),
      );
    }
    expectContractFailure(() =>
      parseRetentionFunnel({ tiles: [tile()], count: 2 }),
    );
    expectContractFailure(() =>
      parseRetentionFunnel({
        tiles: [tile(), tile({ tier_id: TIER_ID_2 })],
        count: 2,
      }),
    );
    expectContractFailure(() =>
      parseRetentionFunnel({
        tiles: [tile(), tile({ offer_id: OFFER_ID_2, tier_id: TIER_ID })],
        count: 2,
      }),
    );
  });
});

describe("retention evidence formatting", () => {
  it("never invents a currency for fixed discounts", () => {
    expect(formatOfferDiscount(undefined, 500)).toBe(
      "500 minor units off; currency unavailable",
    );
    expect(formatOfferDiscount(undefined, 500)).not.toMatch(/USD|\$/u);
    expect(formatOfferDiscount(20)).toBe("20% off");
  });

  it("renders acceptance without a denominator as unknown", () => {
    expect(
      formatAcceptanceRate({
        shown: 0,
        accepted: 0,
        declined: 0,
        expired: 0,
      }),
    ).toBe("Unknown");
    expect(
      formatAcceptanceRate({
        shown: 4,
        accepted: 1,
        declined: 2,
        expired: 1,
      }),
    ).toBe("25%");
  });

  it("withholds a rate when recorded outcomes exceed showings", () => {
    const conflicted = { shown: 4, accepted: 1, declined: 4, expired: 0 };
    expect(hasRetentionOutcomeConflict(conflicted)).toBe(true);
    expect(formatAcceptanceRate(conflicted)).toBe("Unknown");
  });

  it("formats only valid churn probabilities", () => {
    expect(formatChurnThreshold(0.7)).toBe("70%");
    expect(formatChurnThreshold(1.1)).toBe("—");
  });
});

describe("retention access boundary", () => {
  it("admits only the effective owner/admin role outside viewer mode", () => {
    expect(canAccessRetentionOffers({ role: "owner" })).toBe(true);
    expect(canAccessRetentionOffers({ role: "admin" })).toBe(true);
    expect(canAccessRetentionOffers({ role: "editor" })).toBe(false);
    expect(canAccessRetentionOffers({ role: "viewer" })).toBe(false);
    expect(
      canAccessRetentionOffers({
        role: "owner",
        effective_role: "viewer",
        viewer_mode: true,
      }),
    ).toBe(false);
    expect(
      canAccessRetentionOffers({
        role: "viewer",
        effective_role: "admin",
        viewer_mode: false,
      }),
    ).toBe(true);
    expect(
      retentionEffectiveRole({ role: "owner", effective_role: "admin" }),
    ).toBe("admin");
  });

  it("recognizes the protected route and its descendants only", () => {
    expect(isRetentionOffersRoute("/app/retention")).toBe(true);
    expect(isRetentionOffersRoute("/app/retention/example")).toBe(true);
    expect(isRetentionOffersRoute("/app/retention-policy")).toBe(false);
  });
});
