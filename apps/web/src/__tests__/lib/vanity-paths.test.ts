// SPDX-License-Identifier: AGPL-3.0-only
//
// A vanity path is the "no link in the email" route: the reader types
// example.com/go/spring into a browser. It exists because a click is not
// evidence a person did anything — scanners and proxies generate those — while
// a short-address request was recorded, without declaring who made it.
//
// It still is not proof of readership, and the copy has to say so. Someone can
// be told the code by a friend. F04 is explicit: codes prove REDEMPTION
// LINKAGE, not reader identity.

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  campaignEvidenceOutcomeLabel,
  createVanityPath,
  listVanityPaths,
  normalizeSlug,
  outcomeVisibilityCaveat,
  parseCampaignDirectAttributionPage,
  validateDestination,
  publicPathFor,
  readershipCaveat,
} from "@/lib/vanity-paths";

beforeEach(() => {
  Object.values(apiMocks).forEach((mock) => mock.mockReset());
});

describe("normalizeSlug", () => {
  it("lowercases and trims, matching the server", () => {
    expect(normalizeSlug("  Spring  ")).toEqual({ ok: true, slug: "spring" });
  });

  it("accepts internal dashes", () => {
    expect(normalizeSlug("spring-sale")).toEqual({
      ok: true,
      slug: "spring-sale",
    });
  });

  // A leading or trailing dash reads as a typo, and some clients trim it out
  // of a linkified URL — so the path a reader lands on would not be the one
  // that was published.
  it("rejects a leading or trailing dash", () => {
    expect(normalizeSlug("-spring").ok).toBe(false);
    expect(normalizeSlug("spring-").ok).toBe(false);
  });

  it("rejects characters that cannot survive being read aloud or retyped", () => {
    expect(normalizeSlug("spring sale").ok).toBe(false);
    expect(normalizeSlug("spring/sale").ok).toBe(false);
    expect(normalizeSlug("spring_sale").ok).toBe(false);
  });

  it("rejects empty and over-long slugs", () => {
    expect(normalizeSlug("").ok).toBe(false);
    expect(normalizeSlug("a".repeat(65)).ok).toBe(false);
    expect(normalizeSlug("a".repeat(64)).ok).toBe(true);
  });
});

describe("validateDestination", () => {
  it("accepts a host with a path", () => {
    expect(validateDestination("shop.example.com", "/spring")).toEqual([]);
  });

  it("requires a dotted host", () => {
    expect(validateDestination("localhost", "/spring")).toHaveLength(1);
  });

  it("requires the path to start with a slash", () => {
    expect(validateDestination("shop.example.com", "spring")).toHaveLength(1);
  });

  // "//evil.example" is a protocol-relative URL, not a path: a browser treats
  // it as a different HOST, so this is an open-redirect off our own domain.
  it("rejects a protocol-relative path", () => {
    expect(
      validateDestination("shop.example.com", "//evil.example"),
    ).toHaveLength(1);
  });

  it("reports every problem at once", () => {
    expect(validateDestination("localhost", "spring")).toHaveLength(2);
  });
});

describe("publicPathFor", () => {
  it("is the path a reader can actually type", () => {
    expect(publicPathFor("spring")).toBe("/go/spring");
  });
});

describe("readershipCaveat", () => {
  // The single most important sentence on this surface. A visit proves someone
  // requested, not that a person typed, arrived, or read — the address travels.
  it("says a visit is not proof the recipient read the email", () => {
    expect(readershipCaveat()).toMatch(/never proof|does not prove/i);
    expect(readershipCaveat()).toMatch(/read/i);
  });
});

describe("outcomeVisibilityCaveat", () => {
  it("does not turn an absent campaign report into zero outcomes", () => {
    expect(outcomeVisibilityCaveat()).toContain("never shown as zero");
    expect(outcomeVisibilityCaveat()).toContain("explicitly unavailable");
    expect(outcomeVisibilityCaveat()).toContain("not reader identity");
    expect(outcomeVisibilityCaveat()).toContain("no cross-currency total");
  });
});

describe("campaignEvidenceOutcomeLabel", () => {
  it("keeps each value attached to its known currency", () => {
    expect(campaignEvidenceOutcomeLabel(5, 4900, "USD")).toBe(
      "Linked conversion 5 · USD 49.00",
    );
    expect(campaignEvidenceOutcomeLabel(5, 4900, "")).toBe(
      "Linked conversion 5 · 4900 recorded cents; currency unavailable",
    );
    expect(campaignEvidenceOutcomeLabel(5, null, "")).toBe(
      "Linked conversion 5 · value unavailable",
    );
    expect(campaignEvidenceOutcomeLabel(null, 4900, "USD")).toBeNull();
  });
});

const directEvidenceFixture = {
  campaign_id: "11111111-1111-4111-8111-111111111111",
  summary: {
    code_allocations: 1,
    code_redemptions: 1,
    code_linked_outcomes: 1,
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
      redeemed_at: "2026-08-30T12:05:00Z",
      redemption_id: 4,
      conversion_id: 5,
      amount_cents: 4900,
      currency: "USD",
      attributed_via: "code_redemption",
      attribution_scope: "campaign_assignment",
      linked_without_recorded_assignment_click: null,
      readership_proven: false,
    },
  ],
  page_info: { limit: 25, offset: 0, total: 1, has_more: false },
};

describe("parseCampaignDirectAttributionPage", () => {
  it("preserves unavailable historical click evidence as null", () => {
    const page = parseCampaignDirectAttributionPage(
      directEvidenceFixture,
      directEvidenceFixture.campaign_id,
    );
    expect(page.items[0]?.linked_without_recorded_assignment_click).toBeNull();
    expect(page.summary.click_evidence_unavailable).toBe(1);
  });

  it("fails closed on an overstated or malformed response", () => {
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          items: [
            { ...directEvidenceFixture.items[0], readership_proven: true },
          ],
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/readership/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          summary: { ...directEvidenceFixture.summary, code_allocations: "1" },
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/summary/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          items: [
            {
              ...directEvidenceFixture.items[0],
              attributed_via: "campaign_vanity_path",
            },
          ],
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/provenance/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          page_info: {
            ...directEvidenceFixture.page_info,
            total: 2,
            has_more: false,
          },
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/pagination/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          items: [
            {
              ...directEvidenceFixture.items[0],
              subscriber_email: "must-not-cross-the-contract@example.test",
            },
          ],
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/fields/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          items: [{ ...directEvidenceFixture.items[0], currency: "usd" }],
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/currency/i);
    expect(() =>
      parseCampaignDirectAttributionPage(
        {
          ...directEvidenceFixture,
          summary: {
            ...directEvidenceFixture.summary,
            no_click_redemptions: 1,
          },
        },
        directEvidenceFixture.campaign_id,
      ),
    ).toThrow(/summary/i);
  });

  it("rejects evidence for a different requested campaign", () => {
    expect(() =>
      parseCampaignDirectAttributionPage(
        directEvidenceFixture,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).toThrow(/requested campaign/i);
  });
});

describe("vanity-path transport", () => {
  it("keeps slash-bearing campaign identifiers inside one encoded segment", async () => {
    apiMocks.get.mockResolvedValue({ items: [] });
    apiMocks.post.mockResolvedValue({});

    await listVanityPaths("campaign/team A");
    await createVanityPath("campaign/team A", {
      slug: "spring",
      destinationHost: "shop.example.test",
      destinationPath: "/spring",
    });

    const path = "/api/v1/campaigns/campaign%2Fteam%20A/vanity-paths";
    expect(apiMocks.get).toHaveBeenCalledWith(path);
    expect(apiMocks.post).toHaveBeenCalledWith(path, {
      slug: "spring",
      destination_host: "shop.example.test",
      destination_path: "/spring",
    });
  });
});
