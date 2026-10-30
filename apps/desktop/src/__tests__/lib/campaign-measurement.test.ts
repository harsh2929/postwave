import { describe, expect, it } from "vitest";

import {
  liftVerdict,
  formatSignedPercent,
  type HoldoutLift,
  type HoldoutSignificance,
} from "../../lib/holdout-lift";
import {
  campaignEvidenceOutcomeLabel,
  normalizeSlug,
  outcomeVisibilityCaveat,
  parseCampaignDirectAttributionEvidence,
  readershipCaveat,
  validateDestination,
} from "../../lib/vanity-paths";

// Two measurement surfaces that share one property: each reports something a
// campaign CAUSED rather than something that merely followed it, and each is
// only defensible with a caveat attached that the code has to enforce.

function significance(
  over: Partial<HoldoutSignificance> = {},
): HoldoutSignificance {
  return {
    control_rate: 0.05,
    treatment_rate: 0.07,
    absolute_lift: 0.02,
    relative_lift: 0.4,
    incremental_conversions: 180,
    p_value: 0.001,
    ci_low: 0.01,
    ci_high: 0.03,
    powered: true,
    minimum_detectable_effect: 0.008,
    underpowered_reason: "",
    ...over,
  };
}

function lift(over: Partial<HoldoutLift> = {}): HoldoutLift {
  return {
    campaign_id: "c1",
    percent: 10,
    status: "decided",
    held_out_subs: 1000,
    sent_subs: 9000,
    held_out_click_rate: 0.05,
    sent_click_rate: 0.07,
    significance: significance(),
    ...over,
  };
}

describe("liftVerdict", () => {
  it("reports a measured result when the comparison is powered", () => {
    const verdict = liftVerdict(lift());
    expect(verdict.kind).toBe("measured");
  });

  // The headline rule. An underpowered test rendered as "+40%" is worse than
  // showing nothing, because that is the figure that reaches a slide.
  it("carries no number at all when underpowered", () => {
    const verdict = liftVerdict(
      lift({
        significance: significance({
          powered: false,
          absolute_lift: null,
          underpowered_reason: "control arm too small",
        }),
      }),
    );
    expect(verdict.kind).toBe("underpowered");
    expect(JSON.stringify(verdict)).not.toContain("0.4");
  });

  it("flags a powered result whose interval still spans zero", () => {
    const verdict = liftVerdict(
      lift({ significance: significance({ ci_low: -0.01, ci_high: 0.03 }) }),
    );
    if (verdict.kind !== "measured") throw new Error("expected measured");
    expect(verdict.spansZero).toBe(true);
  });

  it("is pending before the holdout is decided", () => {
    expect(liftVerdict(lift({ status: "pending" })).kind).toBe("pending");
  });
});

describe("formatSignedPercent", () => {
  // A holdout can show the campaign did WORSE than sending nothing. That has
  // to read as a loss, not as a smaller win.
  it("keeps the sign", () => {
    expect(formatSignedPercent(-0.123)).toBe("−12.3%");
    expect(formatSignedPercent(0.4)).toBe("+40.0%");
  });
});

describe("normalizeSlug", () => {
  it("lowercases and trims", () => {
    expect(normalizeSlug("  Spring ")).toEqual({ ok: true, slug: "spring" });
  });

  // Some clients trim a trailing dash when they linkify a URL, so the address
  // a reader lands on would not be the one published.
  it("rejects a leading or trailing dash", () => {
    expect(normalizeSlug("-spring").ok).toBe(false);
    expect(normalizeSlug("spring-").ok).toBe(false);
  });

  it("rejects anything that cannot be read aloud and retyped", () => {
    expect(normalizeSlug("spring sale").ok).toBe(false);
    expect(normalizeSlug("spring/sale").ok).toBe(false);
  });
});

describe("validateDestination", () => {
  it("accepts a dotted host with a rooted path", () => {
    expect(validateDestination("shop.example.com", "/spring")).toEqual([]);
  });

  // "//evil.example" is a protocol-relative URL: a browser reads it as a
  // different HOST, which would make our own domain an open redirect.
  it("rejects a protocol-relative path", () => {
    expect(
      validateDestination("shop.example.com", "//evil.example"),
    ).toHaveLength(1);
  });

  it("reports every problem at once", () => {
    expect(validateDestination("localhost", "spring")).toHaveLength(2);
  });
});

describe("readershipCaveat", () => {
  // The single most important sentence on the codes surface.
  it("says a visit does not prove the recipient read the email", () => {
    expect(readershipCaveat()).toMatch(/never proof|does not prove/i);
    expect(readershipCaveat()).toMatch(/read/i);
  });
});

describe("outcomeVisibilityCaveat", () => {
  it("keeps failed and historical unknown evidence out of zero counts", () => {
    expect(outcomeVisibilityCaveat()).toContain("never shown as zero");
    expect(outcomeVisibilityCaveat()).toContain("explicitly unavailable");
    expect(outcomeVisibilityCaveat()).toContain("no cross-currency total");
  });
});

describe("campaignEvidenceOutcomeLabel", () => {
  it("renders per-receipt money without inventing a currency", () => {
    expect(campaignEvidenceOutcomeLabel(7, 1250, "EUR")).toBe(
      "Linked conversion 7 · EUR 12.50",
    );
    expect(campaignEvidenceOutcomeLabel(7, 1250, "")).toContain(
      "currency unavailable",
    );
  });
});

describe("parseCampaignDirectAttributionEvidence", () => {
  const fixture = {
    campaign_id: "11111111-1111-4111-8111-111111111111",
    summary: {
      code_allocations: 1,
      code_redemptions: 1,
      code_linked_outcomes: 0,
      no_click_redemptions: 0,
      with_click_redemptions: 0,
      click_evidence_unavailable: 1,
      vanity_visits: 0,
      vanity_linked_outcomes: 0,
    },
    items: [
      {
        kind: "code_allocation",
        evidence_id: "22222222-2222-4222-8222-222222222222",
        occurred_at: "2026-08-30T12:00:00Z",
        status: "redeemed",
        expires_at: null,
        redeemed_at: null,
        redemption_id: 4,
        conversion_id: null,
        amount_cents: null,
        currency: "",
        attributed_via: "code_redemption",
        attribution_scope: "campaign_assignment",
        linked_without_recorded_assignment_click: null,
        readership_proven: false,
      },
    ],
    page_info: { limit: 25, offset: 0, total: 1, has_more: false },
  };

  it("keeps historical click evidence unavailable", () => {
    expect(
      parseCampaignDirectAttributionEvidence(fixture, fixture.campaign_id)
        ?.items[0]?.linked_without_recorded_assignment_click,
    ).toBeNull();
  });

  it("rejects a response that claims readership proof", () => {
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          items: [{ ...fixture.items[0], readership_proven: true }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects mismatched provenance and inconsistent pagination", () => {
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          items: [
            { ...fixture.items[0], attributed_via: "campaign_vanity_path" },
          ],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          page_info: { ...fixture.page_info, total: 2, has_more: false },
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects leaked fields, invalid currencies, and contradictory totals", () => {
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          items: [
            { ...fixture.items[0], subscriber_email: "leak@example.test" },
          ],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          items: [{ ...fixture.items[0], currency: "usd" }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionEvidence(
        {
          ...fixture,
          summary: { ...fixture.summary, no_click_redemptions: 1 },
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects evidence for a different requested campaign", () => {
    expect(
      parseCampaignDirectAttributionEvidence(
        fixture,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toBeNull();
  });
});
