import { describe, expect, it } from "vitest";

import { ADMIN_MOBILE_ROUTES } from "./mobileRoutesAdmin";

import {
  acceptanceRateOf,
  durationLabel,
  funnelTotals,
  isRetentionScopeDenied,
  joinOffersToFunnel,
  normalizePaywallTierNames,
  normalizeRetentionFunnel,
  normalizeRetentionOffers,
  normalizeWinbackSettings,
  offerAmount,
  RetentionPayloadError,
  retentionObservations,
  type RetentionFunnelTile,
  type RetentionOffer,
} from "./retentionOffers";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";
const OFFER_ID_2 = "44444444-4444-4444-8444-444444444444";
const TIER_ID = "55555555-5555-4555-8555-555555555555";
const TIER_ID_2 = "66666666-6666-4666-8666-666666666666";

function offer(over: Partial<RetentionOffer> = {}): RetentionOffer {
  return {
    id: "off-1",
    tierId: "tier-1",
    percentOff: 20,
    fixedOffCents: null,
    durationMonths: 1,
    headline: "Wait — here's an offer",
    couponId: "coupon_123",
    active: true,
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function tile(over: Partial<RetentionFunnelTile> = {}): RetentionFunnelTile {
  return {
    offerId: "off-1",
    tierId: "tier-1",
    shown: 0,
    accepted: 0,
    declined: 0,
    expired: 0,
    ...over,
  };
}

function wireOffer(over: Record<string, unknown> = {}) {
  return {
    id: OFFER_ID,
    tenant_id: TENANT_ID,
    paywall_tier_id: TIER_ID,
    percent_off: 20,
    duration_months: 1,
    headline: "Stay",
    stripe_coupon_id: "cpn_1",
    active: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...over,
  };
}

function wireFixedOffer(over: Record<string, unknown> = {}) {
  const { percent_off: _percentOff, ...row } = wireOffer({
    id: OFFER_ID_2,
    paywall_tier_id: TIER_ID_2,
  });
  return { ...row, fixed_off_cents: 500, ...over };
}

function wireTile(over: Record<string, unknown> = {}) {
  return {
    offer_id: OFFER_ID,
    tier_id: TIER_ID,
    shown: 10,
    accepted: 3,
    declined: 5,
    expired: 1,
    acceptance_rate: 0.3,
    ...over,
  };
}

function wireTier(over: Record<string, unknown> = {}) {
  return {
    id: TIER_ID,
    name: "Founding member",
    active: true,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    ...over,
  };
}

describe("normalizeRetentionOffers", () => {
  it("reads the server envelope and keeps percent/fixed absence distinct from zero", () => {
    const {
      headline: _headline,
      stripe_coupon_id: _coupon,
      ...fixedOffer
    } = wireFixedOffer({ active: false });
    const rows = normalizeRetentionOffers(
      {
        offers: [
          wireOffer({
            id: OFFER_ID,
            paywall_tier_id: TIER_ID,
            percent_off: 20,
            duration_months: 3,
            headline: "Stay",
            stripe_coupon_id: "cpn_1",
            active: true,
          }),
          fixedOffer,
        ],
        count: 2,
      },
      TENANT_ID,
    );
    expect(rows).toHaveLength(2);
    // percent present → fixed is ABSENT (null), not 0. The CHECK in migration
    // 0306 enforces the XOR, so a 0 here would read as "a zero-value discount".
    expect(rows[0]).toMatchObject({
      id: OFFER_ID,
      tierId: TIER_ID,
      percentOff: 20,
      fixedOffCents: null,
      durationMonths: 3,
      headline: "Stay",
      couponId: "cpn_1",
      active: true,
    });
    expect(rows[1]).toMatchObject({
      percentOff: null,
      fixedOffCents: 500,
      active: false,
      couponId: "",
    });
  });

  it("accepts an exact empty envelope as the only success-empty form", () => {
    expect(
      normalizeRetentionOffers({ offers: [], count: 0 }, TENANT_ID),
    ).toEqual([]);
  });

  it("rejects malformed envelopes instead of turning them into an empty catalogue", () => {
    for (const junk of [
      undefined,
      null,
      "nope",
      7,
      [],
      {},
      { offers: "x", count: 0 },
      { offers: [], count: 1 },
    ]) {
      expect(() => normalizeRetentionOffers(junk)).toThrow(
        RetentionPayloadError,
      );
    }
  });

  it("rejects malformed rows instead of dropping or defaulting them", () => {
    const malformed = [
      wireOffer({ id: "" }),
      wireOffer({ active: undefined }),
      wireOffer({ duration_months: 0 }),
      wireOffer({ duration_months: 1.5 }),
      wireOffer({ percent_off: undefined }),
      wireOffer({ fixed_off_cents: 500 }),
      wireOffer({ percent_off: 101 }),
      wireOffer({ tenant_id: undefined }),
      wireOffer({ updated_at: undefined }),
    ];
    for (const row of malformed) {
      expect(() =>
        normalizeRetentionOffers({ offers: [row], count: 1 }),
      ).toThrow(RetentionPayloadError);
    }
  });

  it("rejects contract drift, cross-tenant rows, duplicate identities, and oversized pages", () => {
    expect(() =>
      normalizeRetentionOffers(
        { offers: [wireOffer()], count: 1, extra: true },
        TENANT_ID,
      ),
    ).toThrow(RetentionPayloadError);
    expect(() =>
      normalizeRetentionOffers(
        { offers: [wireOffer({ extra: true })], count: 1 },
        TENANT_ID,
      ),
    ).toThrow(RetentionPayloadError);
    expect(() =>
      normalizeRetentionOffers(
        { offers: [wireOffer()], count: 1 },
        OTHER_TENANT_ID,
      ),
    ).toThrow(RetentionPayloadError);
    expect(() =>
      normalizeRetentionOffers({
        offers: [wireOffer(), wireFixedOffer({ tenant_id: OTHER_TENANT_ID })],
        count: 2,
      }),
    ).toThrow(RetentionPayloadError);
    expect(() =>
      normalizeRetentionOffers(
        {
          offers: [wireOffer(), wireFixedOffer({ id: OFFER_ID })],
          count: 2,
        },
        TENANT_ID,
      ),
    ).toThrow(RetentionPayloadError);
    expect(() =>
      normalizeRetentionOffers(
        {
          offers: Array.from({ length: 1_001 }, () => wireOffer()),
          count: 1_001,
        },
        TENANT_ID,
      ),
    ).toThrow(RetentionPayloadError);
  });

  it("rejects invalid instants, temporal reversal, unsafe text, and UTF-8 byte overflow", () => {
    for (const row of [
      wireOffer({ created_at: "2026-02-30T00:00:00Z" }),
      wireOffer({ updated_at: "2026-06-30T23:59:59Z" }),
      wireOffer({ headline: "unsafe\u202evalue" }),
      wireOffer({ headline: "😀".repeat(251) }),
    ]) {
      expect(() =>
        normalizeRetentionOffers({ offers: [row], count: 1 }, TENANT_ID),
      ).toThrow(RetentionPayloadError);
    }
  });
});

describe("normalizeRetentionFunnel", () => {
  it("keeps the four counts as real measurements", () => {
    const tiles = normalizeRetentionFunnel({
      tiles: [wireTile()],
      count: 1,
    });
    expect(tiles[0]).toEqual({
      offerId: OFFER_ID,
      tierId: TIER_ID,
      shown: 10,
      accepted: 3,
      declined: 5,
      expired: 1,
    });
  });

  it("drops the server's acceptance_rate entirely", () => {
    // It is assigned only inside `if t.Shown > 0`, so an unshown offer arrives
    // carrying a plain 0 that reads as "0% acceptance".
    const tiles = normalizeRetentionFunnel({
      tiles: [
        wireTile({
          shown: 0,
          accepted: 0,
          declined: 0,
          expired: 0,
          acceptance_rate: 0,
        }),
      ],
      count: 1,
    });
    expect(tiles[0]).not.toHaveProperty("acceptanceRate");
    expect(acceptanceRateOf(tiles[0] ?? null)).toBeNull();
  });

  it("accepts a real zero tile but rejects missing, negative, fractional, or unsafe counts", () => {
    expect(
      normalizeRetentionFunnel({
        tiles: [
          wireTile({
            shown: 0,
            accepted: 0,
            declined: 0,
            expired: 0,
            acceptance_rate: 0,
          }),
        ],
        count: 1,
      })[0],
    ).toMatchObject({ shown: 0, accepted: 0, declined: 0, expired: 0 });

    for (const shown of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        normalizeRetentionFunnel({
          tiles: [wireTile({ shown })],
          count: 1,
        }),
      ).toThrow(RetentionPayloadError);
    }
  });

  it("rejects malformed funnel envelopes instead of returning success-empty", () => {
    for (const junk of [
      null,
      [],
      {},
      { tiles: "no", count: 0 },
      { tiles: [], count: 2 },
    ]) {
      expect(() => normalizeRetentionFunnel(junk)).toThrow(
        RetentionPayloadError,
      );
    }
  });

  it("rejects extra fields, duplicate identities, impossible counts, and rate drift", () => {
    for (const payload of [
      { tiles: [wireTile({ extra: true })], count: 1 },
      { tiles: [wireTile({ accepted: 11, acceptance_rate: 1.1 })], count: 1 },
      { tiles: [wireTile({ acceptance_rate: 0.31 })], count: 1 },
      { tiles: [wireTile(), wireTile()], count: 2 },
      { tiles: [wireTile()], count: 1, extra: true },
    ]) {
      expect(() => normalizeRetentionFunnel(payload)).toThrow(
        RetentionPayloadError,
      );
    }
  });
});

describe("acceptanceRateOf", () => {
  it("is null when nothing was shown — never a 0% verdict", () => {
    expect(acceptanceRateOf(tile({ shown: 0, accepted: 0 }))).toBeNull();
    expect(acceptanceRateOf(null)).toBeNull();
  });

  it("is a real ratio once there is a denominator", () => {
    expect(acceptanceRateOf(tile({ shown: 8, accepted: 2 }))).toBe(0.25);
  });

  it("reports a genuine zero when offers were shown and none accepted", () => {
    expect(acceptanceRateOf(tile({ shown: 5, accepted: 0 }))).toBe(0);
  });

  it("withholds the rate when outcomes exceed showings", () => {
    expect(
      acceptanceRateOf(
        tile({ shown: 4, accepted: 1, declined: 4, expired: 0 }),
      ),
    ).toBeNull();
  });
});

describe("joinOffersToFunnel", () => {
  it("marks EVERY row unknown when the funnel read failed", () => {
    const rows = joinOffersToFunnel([offer(), offer({ id: "off-2" })], null);
    expect(rows.map((row) => row.funnel)).toEqual([null, null]);
  });

  it("distinguishes a missing tile from a zeroed tile", () => {
    const rows = joinOffersToFunnel(
      [offer({ id: "off-1" }), offer({ id: "off-2" })],
      [tile({ offerId: "off-1", shown: 4 })],
    );
    expect(rows[0]?.funnel?.shown).toBe(4);
    // off-2 has no tile: the two reads disagree, so the honest answer is
    // "unknown", not a fabricated zero.
    expect(rows[1]?.funnel).toBeNull();
  });

  it("names the tier when the tier read resolved one, else leaves it null", () => {
    const rows = joinOffersToFunnel([offer({ tierId: "tier-1" })], [], {
      "tier-1": "Founding member",
    });
    expect(rows[0]?.tierName).toBe("Founding member");
    expect(joinOffersToFunnel([offer()], [], {})[0]?.tierName).toBeNull();
  });
});

describe("funnelTotals", () => {
  it("sums the four counts across offers", () => {
    expect(
      funnelTotals([
        tile({ shown: 10, accepted: 2, declined: 6, expired: 1 }),
        tile({ offerId: "b", shown: 4, accepted: 1, declined: 2, expired: 0 }),
      ]),
    ).toEqual({ shown: 14, accepted: 3, declined: 8, expired: 1 });
  });
});

describe("normalizeWinbackSettings", () => {
  it("reads the wire shape", () => {
    expect(
      normalizeWinbackSettings({
        enabled: true,
        churn_threshold: 0.55,
        churn_profiles_scored: 1240,
      }),
    ).toEqual({
      enabled: true,
      churnThreshold: 0.55,
      churnProfilesScored: 1240,
    });
  });

  it("rejects every absent or malformed field instead of making up settings", () => {
    for (const junk of [
      undefined,
      null,
      "nope",
      7,
      [],
      {},
      { enabled: false, churn_threshold: 0.7 },
      {
        enabled: false,
        churn_threshold: "0.7",
        churn_profiles_scored: 0,
      },
      {
        enabled: false,
        churn_threshold: 0,
        churn_profiles_scored: 0,
      },
      {
        enabled: "false",
        churn_threshold: 0.7,
        churn_profiles_scored: 0,
      },
      {
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: -1,
      },
      {
        enabled: false,
        churn_threshold: 0.7,
        churn_profiles_scored: 0,
        extra: true,
      },
    ]) {
      expect(() => normalizeWinbackSettings(junk)).toThrow(
        RetentionPayloadError,
      );
    }
  });
});

describe("normalizePaywallTierNames", () => {
  it("indexes an exact tier projection by id", () => {
    expect(
      normalizePaywallTierNames({
        tiers: [wireTier()],
      }),
    ).toEqual({ [TIER_ID]: "Founding member" });
  });

  it("accepts a genuine empty tier list", () => {
    expect(normalizePaywallTierNames({ tiers: [] })).toEqual({});
  });

  it("rejects malformed or duplicate rows instead of dropping or overwriting them", () => {
    for (const junk of [
      undefined,
      {},
      { tiers: "no" },
      { tiers: [wireTier({ name: "" })] },
      { tiers: [wireTier({ active: undefined })] },
      { tiers: [wireTier({ createdAt: "2026-02-30T00:00:00Z" })] },
      { tiers: [wireTier({ extra: true })] },
      { tiers: [wireTier()], extra: true },
      { tiers: [wireTier(), wireTier()] },
    ]) {
      expect(() => normalizePaywallTierNames(junk)).toThrow(
        RetentionPayloadError,
      );
    }
  });
});

describe("offerAmount", () => {
  it("renders a percent offer", () => {
    expect(offerAmount(offer({ percentOff: 20 })).label).toBe("20% off");
  });

  it("renders a fixed offer as raw minor units without inventing precision or currency", () => {
    // Migration 0306 stores fixed_off_cents with no currency column, and the
    // wire carries none. No client may invent currency or decimal precision.
    const amount = offerAmount(offer({ percentOff: null, fixedOffCents: 500 }));
    expect(amount.label).toBe("500 minor units off");
    expect(amount.label).not.toContain("$");
    expect(amount.spoken).toContain("does not identify the billing currency");
  });

  it("says so when neither side of the XOR is set", () => {
    const amount = offerAmount(
      offer({ percentOff: null, fixedOffCents: null }),
    );
    expect(amount.kind).toBe("none");
    expect(amount.label).toBe("No discount recorded");
  });
});

describe("durationLabel", () => {
  it("renders the server's literal month field without inferring billing cycles", () => {
    expect(durationLabel(offer({ durationMonths: 1 }))).toBe("1 month");
    expect(durationLabel(offer({ durationMonths: 12 }))).toBe("12 months");
  });
});

describe("retentionObservations", () => {
  it("reports the stored active flag without inventing a cancel-flow effect", () => {
    const notes = retentionObservations({
      offers: [offer({ active: false })],
      tiles: [],
      winback: null,
    });
    expect(notes[0]?.id).toBe("no-active-offer");
    expect(notes[0]?.tone).toBe("attention");
  });

  it("flags an active offer with no mirrored Stripe coupon", () => {
    // AcceptOffer returns ErrProviderReferenceRequired on a blank coupon id,
    // so this offer cannot complete an acceptance even once the portal is on.
    const notes = retentionObservations({
      offers: [offer({ couponId: "" })],
      tiles: null,
      winback: null,
    });
    expect(notes.map((n) => n.id)).toContain("no-coupon-mirrored");
    expect(notes.find((n) => n.id === "no-coupon-mirrored")?.text).toContain(
      "1 offer marked active",
    );
  });

  it("says nothing about the funnel while the funnel is unknown", () => {
    const notes = retentionObservations({
      offers: [offer()],
      tiles: null,
      winback: null,
    });
    expect(notes.map((n) => n.id)).not.toContain("never-shown");
  });

  it("reports 'never shown' only once the funnel actually loaded", () => {
    const notes = retentionObservations({
      offers: [offer()],
      tiles: [tile()],
      winback: null,
    });
    expect(notes.map((n) => n.id)).toContain("never-shown");
  });

  it("reports historical accepted outcomes without inventing causality", () => {
    expect(
      retentionObservations({
        offers: [offer()],
        tiles: [tile({ shown: 9, accepted: 1 })],
        winback: null,
      }).find((n) => n.id === "accepted")?.text,
    ).toBe("The historical funnel contains 1 recorded accepted outcome.");
    expect(
      retentionObservations({
        offers: [offer()],
        tiles: [tile({ shown: 9, accepted: 4 })],
        winback: null,
      }).find((n) => n.id === "accepted")?.tone,
    ).toBe("good");
  });

  it("flags win-backs that are on but have nobody scored", () => {
    const notes = retentionObservations({
      offers: [offer()],
      tiles: null,
      winback: { enabled: true, churnThreshold: 0.7, churnProfilesScored: 0 },
    });
    expect(notes.map((n) => n.id)).toContain("winback-unscored");
  });

  it("stays quiet about win-backs that are simply switched off", () => {
    const notes = retentionObservations({
      offers: [offer()],
      tiles: null,
      winback: { enabled: false, churnThreshold: 0.7, churnProfilesScored: 0 },
    });
    expect(notes.map((n) => n.id)).not.toContain("winback-unscored");
  });

  it("never judges the acceptance RATE", () => {
    // With the portal routes unmounted an acceptance cannot be recorded, so a
    // low rate is evidence of nothing.
    const notes = retentionObservations({
      offers: [offer()],
      tiles: [tile({ shown: 500, accepted: 0, declined: 500 })],
      winback: null,
    });
    expect(notes.map((n) => n.text).join(" ")).not.toMatch(/rate|low|poor/i);
  });
});

describe("isRetentionScopeDenied", () => {
  it("is true only for a 403", () => {
    expect(isRetentionScopeDenied({ status: 403 })).toBe(true);
    expect(isRetentionScopeDenied({ status: 500 })).toBe(false);
    expect(isRetentionScopeDenied(new Error("boom"))).toBe(false);
    expect(isRetentionScopeDenied(null)).toBe(false);
  });
});

describe("retention navigation copy", () => {
  it("advertises bounded stored evidence and preserves the admin role floor", () => {
    const route = ADMIN_MOBILE_ROUTES.find(
      (candidate) => candidate.key === "retention-offers",
    );
    expect(route).toMatchObject({
      hint: "Stored rows, settings and aggregate counters",
      minimumRole: "admin",
    });
    expect(`${route?.label} ${route?.hint}`).not.toMatch(
      /customers? saved|helped .* stay|offers? shown|delivery|acceptance rate/iu,
    );
  });
});
