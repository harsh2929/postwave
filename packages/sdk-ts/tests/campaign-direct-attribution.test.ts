import { describe, expect, it, vi } from "vitest";

import {
  decodeCampaignDirectAttributionEvidencePage,
  PostwaveClient,
} from "../src/index.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";

function page(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    campaign_id: CAMPAIGN_ID,
    summary: {
      code_allocations: 6,
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
        evidence_id: EVIDENCE_ID,
        occurred_at: "2026-08-30T12:00:00Z",
        status: "redeemed",
        expires_at: null,
        redeemed_at: "2026-08-30T12:05:00Z",
        redemption_id: 41,
        conversion_id: null,
        amount_cents: null,
        currency: "",
        attributed_via: "code_redemption",
        attribution_scope: "campaign_assignment",
        linked_without_recorded_assignment_click: null,
        readership_proven: false,
      },
    ],
    page_info: { limit: 17, offset: 4, total: 6, has_more: true },
    ...overrides,
  };
}

describe("CampaignsResource direct-attribution evidence", () => {
  it("performs one bounded GET with an encoded campaign and preserves null", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(page()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new PostwaveClient({
      apiKey: "pw_test",
      tenantId: "tenant",
      fetch,
      retries: 0,
    });

    const result = await client.campaigns.listDirectAttributionEvidence(
      "campaign/a b",
      { limit: 17, offset: 4 },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaigns/campaign%2Fa%20b/direct-attribution-evidence?limit=17&offset=4",
      expect.objectContaining({ method: "GET", body: null, cache: "no-store" }),
    );
    expect(
      result.items[0]?.linked_without_recorded_assignment_click,
    ).toBeNull();
    expect(result.items[0]?.readership_proven).toBe(false);
    expect(result).toEqual(page());
  });

  it("strictly rejects identity/code fields and a readership claim", () => {
    const withIdentity = page();
    (withIdentity.items as Array<Record<string, unknown>>)[0]!.recipient_email =
      "person@example.com";
    expect(() =>
      decodeCampaignDirectAttributionEvidencePage(withIdentity),
    ).toThrow(/fields/);

    const claimingReadership = page();
    (
      claimingReadership.items as Array<Record<string, unknown>>
    )[0]!.readership_proven = true;
    expect(() =>
      decodeCampaignDirectAttributionEvidencePage(claimingReadership),
    ).toThrow(/cannot prove readership/);
  });

  it("rejects removed cross-currency aggregates and dishonest currencies", () => {
    const aggregate = page();
    (aggregate.summary as Record<string, unknown>).code_revenue_cents = -25;
    expect(() =>
      decodeCampaignDirectAttributionEvidencePage(aggregate),
    ).toThrow(/summary fields/);

    for (const currency of ["usd", "US", "USDD"]) {
      const payload = page();
      (payload.items as Array<Record<string, unknown>>)[0]!.currency = currency;
      expect(() =>
        decodeCampaignDirectAttributionEvidencePage(payload),
      ).toThrow(/currency provenance/);
    }

    const unspecified = page();
    (unspecified.items as Array<Record<string, unknown>>)[0]!.amount_cents =
      125;
    expect(
      decodeCampaignDirectAttributionEvidencePage(unspecified).items[0],
    ).toMatchObject({ amount_cents: 125, currency: "" });

    const nonMonetaryWithCurrency = page();
    (
      nonMonetaryWithCurrency.items as Array<Record<string, unknown>>
    )[0]!.currency = "USD";
    expect(
      decodeCampaignDirectAttributionEvidencePage(nonMonetaryWithCurrency)
        .items[0],
    ).toMatchObject({ amount_cents: null, currency: "USD" });
  });

  it("fails closed for hostile identifiers, time, integers, and pagination", () => {
    const cases: Array<{
      path: Array<string | number>;
      value: unknown;
    }> = [
      { path: ["campaign_id"], value: "not-a-uuid" },
      { path: ["items", 0, "evidence_id"], value: "not-a-uuid" },
      { path: ["items", 0, "status"], value: "   " },
      { path: ["items", 0, "occurred_at"], value: "2026-02-30T12:00:00Z" },
      {
        path: ["items", 0, "occurred_at"],
        value: "2026-08-30T12:00:00+24:00",
      },
      { path: ["items", 0, "occurred_at"], value: "2026-08-30T24:00:00Z" },
      {
        path: ["summary", "code_allocations"],
        value: Number.MAX_SAFE_INTEGER + 1,
      },
      { path: ["summary", "code_allocations"], value: -1 },
      { path: ["summary", "code_allocations"], value: null },
      { path: ["items", 0, "conversion_id"], value: 0 },
      {
        path: ["items", 0, "amount_cents"],
        value: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        path: ["items", 0, "linked_without_recorded_assignment_click"],
        value: 0,
      },
      { path: ["items", 0, "currency"], value: null },
      { path: ["items", 0, "readership_proven"], value: 0 },
      { path: ["page_info", "has_more"], value: false },
    ];
    for (const { path, value } of cases) {
      const payload = page();
      let target: unknown = payload;
      for (const segment of path.slice(0, -1)) {
        target = (target as Record<string | number, unknown>)[segment];
      }
      (target as Record<string | number, unknown>)[path.at(-1)!] = value;
      expect(() =>
        decodeCampaignDirectAttributionEvidencePage(payload),
      ).toThrow(/campaign direct-attribution evidence/);
    }
  });

  it("requires every closed response field", () => {
    const payload = page();
    delete (payload.items as Array<Record<string, unknown>>)[0]!.expires_at;
    expect(() => decodeCampaignDirectAttributionEvidencePage(payload)).toThrow(
      /item 1 fields/,
    );

    const nullItems = page({ items: null });
    expect(() =>
      decodeCampaignDirectAttributionEvidencePage(nullItems),
    ).toThrow(/items/);
  });

  it("rejects contradictory authoritative summary receipts", () => {
    for (const mutate of [
      (summary: Record<string, unknown>) => {
        summary.code_redemptions = 7;
      },
      (summary: Record<string, unknown>) => {
        summary.code_linked_outcomes = 7;
      },
      (summary: Record<string, unknown>) => {
        summary.no_click_redemptions = 1;
      },
      (summary: Record<string, unknown>) => {
        summary.vanity_visits = 1;
        summary.vanity_linked_outcomes = 2;
      },
    ]) {
      const payload = page();
      mutate(payload.summary as Record<string, unknown>);
      expect(() =>
        decodeCampaignDirectAttributionEvidencePage(payload),
      ).toThrow(/inconsistent campaign direct-attribution evidence summary/);
    }

    const total = page();
    (total.page_info as Record<string, unknown>).total = 7;
    (total.page_info as Record<string, unknown>).has_more = true;
    expect(() => decodeCampaignDirectAttributionEvidencePage(total)).toThrow(
      /inconsistent campaign direct-attribution evidence page_info/,
    );
  });

  it.each([
    [{ limit: 0 }],
    [{ limit: 101 }],
    [{ offset: -1 }],
    [{ offset: 10_001 }],
    [{ offset: 1.5 }],
    [{ limit: Number.NaN }],
    [{ limit: 25, unexpected: 1 }],
  ])("rejects invalid pagination before transport: %o", async (options) => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "pw_test", fetch, retries: 0 });
    await expect(
      client.campaigns.listDirectAttributionEvidence(CAMPAIGN_ID, options),
    ).rejects.toThrow(/campaign direct-attribution evidence/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
