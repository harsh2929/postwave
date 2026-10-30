import { describe, expect, it } from "vitest";

import {
  reconcileRetentionHistory,
  type RetentionFunnelTile,
  type RetentionOfferHistoryRow,
  type RetentionOfferRecord,
} from "../lib/retention-offers-contract";
import {
  filterAndSortRetentionRows,
  retentionDiscountPresentation,
  retentionReadinessFacts,
  retentionRowMatchesQuery,
} from "../lib/retention-offers-view-model";

const OFFER_1 = "20000000-0000-4000-8000-000000000001";
const OFFER_2 = "20000000-0000-4000-8000-000000000002";
const OFFER_3 = "20000000-0000-4000-8000-000000000003";
const OFFER_4 = "20000000-0000-4000-8000-000000000004";
const TIER_1 = "30000000-0000-4000-8000-000000000001";
const TIER_2 = "30000000-0000-4000-8000-000000000002";
const TIER_3 = "30000000-0000-4000-8000-000000000003";
const TIER_4 = "30000000-0000-4000-8000-000000000004";

function offer(
  overrides: Partial<RetentionOfferRecord> = {},
): RetentionOfferRecord {
  return {
    id: OFFER_1,
    tierId: TIER_1,
    discount: { kind: "percent", percent: 20 },
    durationMonths: 3,
    headline: "Stay for the next chapter",
    body: "Private detail-only phrase",
    providerCouponPresent: true,
    active: true,
    createdAt: "2026-07-01T09:00:00.000Z",
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

function row(
  overrides: {
    offer?: Partial<RetentionOfferRecord>;
    tierName?: string | null;
    funnel?: RetentionFunnelTile | null;
    funnelState?: RetentionOfferHistoryRow["funnelState"];
  } = {},
): RetentionOfferHistoryRow {
  const record = offer(overrides.offer);
  return {
    offer: record,
    tierName:
      overrides.tierName === undefined
        ? "Founding members"
        : overrides.tierName,
    funnel:
      overrides.funnel === undefined
        ? tile({
            offerId: record.id,
            tierId: record.tierId,
          })
        : overrides.funnel,
    funnelState: overrides.funnelState ?? "matched",
  };
}

describe("retention discount presentation", () => {
  it("formats a percent discount with a spoken equivalent", () => {
    expect(
      retentionDiscountPresentation(
        offer({ discount: { kind: "percent", percent: 15 } }),
      ),
    ).toEqual({
      label: "15% off",
      spokenLabel: "15 percent off",
      currencyKnown: true,
    });
  });

  it("never invents a currency for fixed minor units", () => {
    const presentation = retentionDiscountPresentation(
      offer({
        discount: { kind: "fixed", minorUnits: 1_250, currency: null },
      }),
    );
    expect(presentation).toEqual({
      label: "1,250 minor units off",
      spokenLabel:
        "1,250 minor units off; the record does not identify the billing currency or decimal precision",
      currencyKnown: false,
    });
    expect(JSON.stringify(presentation)).not.toContain("$");
    expect(JSON.stringify(presentation)).not.toMatch(/\bUSD\b/i);
  });
});

describe("retention history query", () => {
  const rows: RetentionOfferHistoryRow[] = [
    row(),
    row({
      offer: {
        id: OFFER_2,
        tierId: TIER_2,
        active: false,
        discount: { kind: "fixed", minorUnits: 500, currency: null },
        headline: "Annual thank-you",
        createdAt: "2026-07-04T09:00:00.000Z",
      },
      tierName: "Annual",
      funnel: tile({
        offerId: OFFER_2,
        tierId: TIER_2,
        shown: 0,
        accepted: 0,
        declined: 0,
        expired: 0,
      }),
    }),
    row({
      offer: {
        id: OFFER_3,
        tierId: TIER_3,
        createdAt: "2026-07-03T09:00:00.000Z",
      },
      tierName: "Professional",
      funnel: null,
      funnelState: "missing",
    }),
    row({
      offer: {
        id: OFFER_4,
        tierId: TIER_4,
        createdAt: "2026-07-02T09:00:00.000Z",
      },
      tierName: "Enterprise",
      funnel: tile({
        offerId: OFFER_4,
        tierId: TIER_4,
        shown: 100,
        accepted: 90,
        declined: 20,
      }),
      funnelState: "outcome-excess",
    }),
  ];

  it("searches safe operational fields but not retained detail-only body copy", () => {
    expect(retentionRowMatchesQuery(rows[0], "  founding   MEMBERS ")).toBe(
      true,
    );
    expect(retentionRowMatchesQuery(rows[1], "500 minor units off")).toBe(true);
    expect(retentionRowMatchesQuery(rows[1], "inactive")).toBe(true);
    expect(retentionRowMatchesQuery(rows[0], "inactive")).toBe(false);
    expect(retentionRowMatchesQuery(rows[0], "active")).toBe(true);
    expect(retentionRowMatchesQuery(rows[1], "active")).toBe(false);
    expect(retentionRowMatchesQuery(rows[1], OFFER_2)).toBe(true);
    expect(
      retentionRowMatchesQuery(rows[0], "private detail-only phrase"),
    ).toBe(false);
  });

  it("normalizes Unicode search input deterministically", () => {
    const compatibilityRow = row({ tierName: "Ａnnual plan" });
    expect(retentionRowMatchesQuery(compatibilityRow, "annual")).toBe(true);
  });

  it("combines status, discount, evidence, and query filters", () => {
    expect(
      filterAndSortRetentionRows(rows, {
        status: "inactive",
        discount: "fixed",
        evidence: "zero",
        query: "annual",
      }).map((item) => item.offer.id),
    ).toEqual([OFFER_2]);
    expect(
      filterAndSortRetentionRows(rows, { evidence: "measured" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_1]);
    expect(
      filterAndSortRetentionRows(rows, { evidence: "unknown" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_3]);
    expect(
      filterAndSortRetentionRows(rows, { evidence: "anomaly" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_3, OFFER_4]);
  });

  it("does not treat outcome-excess evidence as measured or as a sortable metric", () => {
    expect(
      filterAndSortRetentionRows(rows, { evidence: "measured" }).some(
        (item) => item.offer.id === OFFER_4,
      ),
    ).toBe(false);
    expect(
      filterAndSortRetentionRows(rows, { sort: "shown-desc" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_1, OFFER_2, OFFER_3, OFFER_4]);
  });

  it("sorts newest and oldest without mutating the source", () => {
    const source = [...rows];
    expect(
      filterAndSortRetentionRows(source, { sort: "newest" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_2, OFFER_3, OFFER_4, OFFER_1]);
    expect(
      filterAndSortRetentionRows(source, { sort: "oldest" }).map(
        (item) => item.offer.id,
      ),
    ).toEqual([OFFER_1, OFFER_4, OFFER_3, OFFER_2]);
    expect(source).toEqual(rows);
  });

  it("can surface recently overwritten rows independently of creation order", () => {
    const mutableRows = [
      row({
        offer: {
          id: OFFER_1,
          tierId: TIER_1,
          createdAt: "2026-07-04T09:00:00.000Z",
          updatedAt: "2026-07-04T09:00:00.000Z",
        },
      }),
      row({
        offer: {
          id: OFFER_2,
          tierId: TIER_2,
          createdAt: "2026-07-01T09:00:00.000Z",
          updatedAt: "2026-07-09T09:00:00.000Z",
        },
      }),
    ];

    expect(
      filterAndSortRetentionRows(mutableRows, {
        sort: "updated-desc",
      }).map((item) => item.offer.id),
    ).toEqual([OFFER_2, OFFER_1]);
  });

  it("puts known metrics first and applies deterministic tie breakers", () => {
    const tied = [
      row({
        offer: {
          id: OFFER_2,
          tierId: TIER_2,
          createdAt: "2026-07-01T09:00:00.000Z",
        },
        funnel: tile({ offerId: OFFER_2, tierId: TIER_2 }),
      }),
      rows[0],
      rows[2],
    ];
    const forward = filterAndSortRetentionRows(tied, {
      sort: "accepted-desc",
    }).map((item) => item.offer.id);
    const reverse = filterAndSortRetentionRows([...tied].reverse(), {
      sort: "accepted-desc",
    }).map((item) => item.offer.id);
    expect(forward).toEqual([OFFER_1, OFFER_2, OFFER_3]);
    expect(reverse).toEqual(forward);
  });

  it("sorts tier labels by a deterministic normalized key", () => {
    expect(
      filterAndSortRetentionRows(rows, { sort: "tier-asc" }).map(
        (item) => item.tierName,
      ),
    ).toEqual(["Annual", "Enterprise", "Founding members", "Professional"]);
  });
});

describe("retention readiness facts", () => {
  it("keeps production delivery blocked regardless of healthy read responses", () => {
    const reconciliation = reconcileRetentionHistory([offer()], [tile()]);
    const facts = retentionReadinessFacts({
      reconciliation,
      offersAvailable: true,
      offersPending: false,
      funnelPending: false,
      winback: {
        enabled: true,
        churnThreshold: 0.7,
        churnProfilesScored: 4_000,
      },
      winbackPending: false,
    });
    expect(facts[0]).toMatchObject({
      id: "history-mode",
      state: "blocked",
      basis: "source-contract",
    });
    expect(facts[0]?.detail).toContain(
      "strictly decoded current offer rows and all-time event counters",
    );
    expect(
      facts.find((fact) => fact.id === "provider-reference"),
    ).toMatchObject({ state: "unknown" });
    expect(facts.map((fact) => fact.detail).join(" ")).not.toMatch(
      /\bproduction[- ]ready\b|\bdelivery works\b/i,
    );
  });

  it("reports unavailable funnel evidence as unknown, never zero", () => {
    const facts = retentionReadinessFacts({
      reconciliation: reconcileRetentionHistory([offer()], null),
      offersAvailable: true,
      offersPending: false,
      funnelPending: false,
      winback: null,
      winbackPending: false,
    });
    expect(facts.find((fact) => fact.id === "funnel-integrity")).toEqual({
      id: "funnel-integrity",
      label: "Funnel evidence",
      state: "unknown",
      detail:
        "The funnel response is unavailable, so no zero or rate can be asserted for the current stored offers.",
      basis: "response",
    });
  });

  it("does not reinterpret an unavailable offer response as a valid zero", () => {
    const facts = retentionReadinessFacts({
      reconciliation: reconcileRetentionHistory([], [tile()]),
      offersAvailable: false,
      offersPending: false,
      funnelPending: false,
      winback: null,
      winbackPending: false,
    });

    for (const id of [
      "funnel-integrity",
      "provider-reference",
      "fixed-currency",
    ]) {
      expect(facts.find((fact) => fact.id === id)).toMatchObject({
        state: "unknown",
        basis: "response",
      });
    }
    expect(facts.map((fact) => fact.detail).join(" ")).not.toMatch(
      /no active offers|no current stored offer row/i,
    );
  });

  it("surfaces every reconciliation defect as attention", () => {
    const reconciliation = reconcileRetentionHistory(
      [offer()],
      [
        tile({ shown: 1, accepted: 1, declined: 1 }),
        tile({
          offerId: OFFER_2,
          tierId: TIER_2,
          shown: 1,
          accepted: 0,
          declined: 1,
          expired: 0,
        }),
      ],
    );
    const fact = retentionReadinessFacts({
      reconciliation,
      offersAvailable: true,
      offersPending: false,
      funnelPending: false,
      winback: null,
      winbackPending: false,
    }).find((candidate) => candidate.id === "funnel-integrity");
    expect(fact).toMatchObject({ state: "attention", basis: "response" });
    expect(fact?.detail).toContain("2 reconciliation issues");
  });

  it("flags missing provider references without retaining their values", () => {
    const reconciliation = reconcileRetentionHistory(
      [offer({ providerCouponPresent: false })],
      [tile()],
    );
    expect(
      retentionReadinessFacts({
        reconciliation,
        offersAvailable: true,
        offersPending: false,
        funnelPending: false,
        winback: null,
        winbackPending: false,
      }).find((fact) => fact.id === "provider-reference"),
    ).toEqual({
      id: "provider-reference",
      label: "Provider references",
      state: "attention",
      detail: "1 active offer has no coupon reference on the retained record.",
      basis: "response",
    });
  });

  it("states that fixed currency is unknown and never supplies a symbol", () => {
    const fixed = offer({
      discount: { kind: "fixed", minorUnits: 500, currency: null },
    });
    const facts = retentionReadinessFacts({
      reconciliation: reconcileRetentionHistory([fixed], [tile()]),
      offersAvailable: true,
      offersPending: false,
      funnelPending: false,
      winback: null,
      winbackPending: false,
    });
    const fact = facts.find((candidate) => candidate.id === "fixed-currency");
    expect(fact).toMatchObject({ state: "unknown" });
    expect(fact?.detail).toContain("without a currency");
    expect(fact?.detail).not.toContain("$");
  });

  it("makes zero scored profiles an explicit win-back blocker observation", () => {
    const reconciliation = reconcileRetentionHistory([], []);
    expect(
      retentionReadinessFacts({
        reconciliation,
        offersAvailable: true,
        offersPending: false,
        funnelPending: false,
        winback: {
          enabled: true,
          churnThreshold: 0.7,
          churnProfilesScored: 0,
        },
        winbackPending: false,
      }).find((fact) => fact.id === "winback-observation"),
    ).toMatchObject({
      state: "attention",
      detail:
        "The stored enabled flag is true, but zero churn profiles are scored. This does not prove a running worker or eligible recipient.",
    });
  });

  it("uses not-applicable facts when no active or fixed offers exist", () => {
    const inactive = offer({ active: false });
    const facts = retentionReadinessFacts({
      reconciliation: reconcileRetentionHistory([inactive], [tile()]),
      offersAvailable: true,
      offersPending: false,
      funnelPending: false,
      winback: {
        enabled: false,
        churnThreshold: 0.7,
        churnProfilesScored: 0,
      },
      winbackPending: false,
    });
    expect(facts.find((fact) => fact.id === "provider-reference")?.state).toBe(
      "not-applicable",
    );
    expect(facts.find((fact) => fact.id === "fixed-currency")?.state).toBe(
      "not-applicable",
    );
    expect(
      facts.find((fact) => fact.id === "winback-observation"),
    ).toMatchObject({
      state: "observed",
      detail: "The retained setting reports win-backs disabled.",
    });
  });
});
