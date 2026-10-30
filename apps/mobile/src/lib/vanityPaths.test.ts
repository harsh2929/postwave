import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  campaignEvidenceOutcomeLabel,
  outcomeVisibilityCaveat,
  parseCampaignDirectAttributionPage,
  parseVanityPaths,
  readershipCaveat,
  vanityDestination,
} from "./vanityPaths";

describe("readershipCaveat", () => {
  it("is IDENTICAL to the web copy, character for character", () => {
    // The web module says the sentence is defined once because "the whole point
    // of F04 is an arrival signal that is honest about what it does not prove".
    // A per-surface rewording is how a disclosure drifts into a marketing line,
    // so this asserts against the real file rather than a copy of the string.
    const web = readFileSync(
      join(__dirname, "..", "..", "..", "web", "src", "lib", "vanity-paths.ts"),
      "utf8",
    );
    const start = web.indexOf("export function readershipCaveat()");
    const body = web.slice(start, web.indexOf("}", start));
    const quoted = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(quoted).toBe(readershipCaveat());
  });

  it("still names all three things a visit does not prove", () => {
    const caveat = readershipCaveat();
    expect(caveat).toContain("not that a person");
    expect(caveat).toContain("forwarded");
    expect(caveat).toContain("never proof of human attention or readership");
  });
});

describe("outcomeVisibilityCaveat", () => {
  it("states the allocation and campaign-outcome reporting boundary", () => {
    expect(outcomeVisibilityCaveat()).toContain("never shown as zero");
    expect(outcomeVisibilityCaveat()).toContain("explicitly unavailable");
    expect(outcomeVisibilityCaveat()).toContain("no cross-currency total");
  });
});

describe("campaignEvidenceOutcomeLabel", () => {
  it("renders linked value only with receipt-level currency truth", () => {
    expect(campaignEvidenceOutcomeLabel(9, -250, "GBP")).toBe(
      "Linked conversion 9 · GBP -2.50",
    );
    expect(campaignEvidenceOutcomeLabel(9, -250, "")).toBe(
      "Linked conversion 9 · -250 recorded cents; currency unavailable",
    );
  });
});

describe("parseCampaignDirectAttributionPage", () => {
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

  it("preserves unavailable click evidence and derives no next page", () => {
    const parsed = parseCampaignDirectAttributionPage(
      fixture,
      fixture.campaign_id,
    );
    expect(parsed?.items[0]?.linkedWithoutRecordedAssignmentClick).toBeNull();
    expect(parsed?.summary.clickEvidenceUnavailable).toBe(1);
    expect(parsed?.nextOffset).toBeUndefined();
  });

  it("rejects an overclaim instead of returning an empty register", () => {
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          items: [{ ...fixture.items[0], readership_proven: true }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects provenance/scope drift and malformed nullable dates", () => {
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          items: [
            {
              ...fixture.items[0],
              attributed_via: "campaign_vanity_path",
            },
          ],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          items: [{ ...fixture.items[0], expires_at: 123 }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("fails closed when any authoritative summary field is missing", () => {
    const { vanity_linked_outcomes: _omitted, ...summary } = fixture.summary;
    expect(
      parseCampaignDirectAttributionPage(
        { ...fixture, summary },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects leaked fields, invalid currencies, and contradictory totals", () => {
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          items: [{ ...fixture.items[0], subscriber_id: "private" }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          items: [{ ...fixture.items[0], currency: "usd" }],
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
    expect(
      parseCampaignDirectAttributionPage(
        {
          ...fixture,
          summary: { ...fixture.summary, with_click_redemptions: 1 },
        },
        fixture.campaign_id,
      ),
    ).toBeNull();
  });

  it("rejects evidence for a different requested campaign", () => {
    expect(
      parseCampaignDirectAttributionPage(
        fixture,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toBeNull();
  });
});

describe("parseVanityPaths", () => {
  it("reads the handler's { items } envelope", () => {
    const rows = parseVanityPaths({
      items: [
        {
          id: "v1",
          slug: "spring",
          public_path: "/go/spring",
          destination_host: "shop.example.com",
          destination_path: "/sale",
          status: "active",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicPath).toBe("/go/spring");
  });

  it("prefers the server's public_path over rebuilding it", () => {
    // The /go/ prefix is the server's to choose; a client that reconstructs it is
    // wrong the day it changes.
    expect(
      parseVanityPaths({
        items: [{ id: "v1", slug: "spring", public_path: "/short/spring" }],
      })[0]?.publicPath,
    ).toBe("/short/spring");
  });

  it("falls back to the known prefix only when the server omits it", () => {
    expect(
      parseVanityPaths({ items: [{ id: "v1", slug: "spring" }] })[0]
        ?.publicPath,
    ).toBe("/go/spring");
  });

  it("drops rows missing an id or a slug", () => {
    expect(parseVanityPaths({ items: [{ id: "v1" }] })).toEqual([]);
    expect(parseVanityPaths({ items: [{ slug: "s" }] })).toEqual([]);
    expect(parseVanityPaths(null)).toEqual([]);
  });
});

describe("vanityDestination", () => {
  it("joins host and path", () => {
    expect(
      vanityDestination({
        id: "v1",
        slug: "s",
        publicPath: "",
        destinationHost: "shop.example.com",
        destinationPath: "/sale",
        status: "",
      }),
    ).toBe("shop.example.com/sale");
  });

  it("says so plainly when no destination is set", () => {
    expect(
      vanityDestination({
        id: "v1",
        slug: "s",
        publicPath: "",
        destinationHost: "",
        destinationPath: "",
        status: "",
      }),
    ).toBe("destination not set");
  });
});
