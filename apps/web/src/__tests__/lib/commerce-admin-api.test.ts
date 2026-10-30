// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgencyChild,
  getAgencyInvoicePreview,
  listAgencyChildrenPage,
  normalizeAgencyBranding,
  normalizeAgencyChild,
  normalizeAgencyChildrenPage,
  removeAgencyChild,
  setAgencyBillingMode,
  updateAgencyBranding,
} from "@/lib/agency-api";
import {
  normalizeBillingPlanSummary,
  normalizeBillingState,
  normalizeInvoices,
  normalizeLimitsUsage,
  normalizeUsage,
} from "@/lib/billing-api";
import {
  listDiscountRedemptionEvents,
  normalizeCouponAssignmentsPage,
  normalizeCouponCodesPage,
} from "@/lib/discounts-api";
import {
  normalizeReferralLeaderboard,
  normalizeReferralPayoutPage,
  normalizeReferralProgram,
  normalizeReferralStats,
  saveReferralProgram,
  updateReferralPayout,
  type ReferralMilestone,
} from "@/lib/referrals-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agency administration contracts", () => {
  const branding = {
    whitelabel_enabled: false,
    brand_name: "Acme Studio",
    custom_domain: "legacy.acme.co",
    logo_url: "https://cdn.acme.co/logo.svg",
    primary_color: "#123ABC",
    support_email: "support@acme.co",
    legal_entity: "Acme LLC",
    updated_at: "2026-09-10T00:00:00Z",
    etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v1"',
  } as const;

  it.each([
    [
      "create",
      () =>
        createAgencyChild({
          billing_mode: "parent",
          name: "Northwind Europe",
          reseller_markup_bps: 750,
          slug: "northwind-eu",
          tier: "sending",
        }),
      "agency_child_create_release_hold",
    ],
    [
      "unlink",
      () => removeAgencyChild("11111111-1111-4111-8111-111111111111"),
      "agency_child_unlink_release_hold",
    ],
    [
      "billing owner",
      () =>
        setAgencyBillingMode({
          target_tenant_id: "11111111-1111-4111-8111-111111111111",
          mode: "parent",
          reason: "Consolidate billing",
        }),
      "agency_billing_mode_release_hold",
    ],
    [
      "invoice preview",
      () => getAgencyInvoicePreview(30),
      "agency_invoice_preview_release_hold",
    ],
    [
      "branding publish",
      () => updateAgencyBranding({ brand_name: branding.brand_name }),
      "agency_branding_update_release_hold",
    ],
  ])("holds %s locally without transport", async (_label, invoke, code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(invoke()).rejects.toMatchObject({
      ambiguous: false,
      code,
      committed: false,
      retryable: false,
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests one bounded roster page and validates terminal cursor absence", async () => {
    const child = {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "northwind-eu",
      name: "Northwind Europe",
      tier: "sending",
      parent_tenant_id: "22222222-2222-4222-8222-222222222222",
      billing_mode: "parent",
      reseller_markup_bps: 750,
      whitelabel_enabled: false,
      created_at: "2026-09-10T00:00:00Z",
      updated_at: "2026-09-10T00:00:00Z",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ children: [child], count: 1, has_more: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listAgencyChildrenPage("22222222-2222-4222-8222-222222222222", undefined),
    ).resolves.toMatchObject({
      children: [{ id: child.id }],
      count: 1,
      has_more: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/agency/children?limit=100",
    );
    expect(() =>
      normalizeAgencyChildrenPage({
        children: [child],
        count: 1,
        has_more: false,
        next_cursor: "must-not-exist",
      }),
    ).toThrow(/malformed/i);
    expect(
      normalizeAgencyChildrenPage({
        children: [child],
        count: 1,
        has_more: true,
        next_cursor: "opaque-cursor",
      }),
    ).toMatchObject({ has_more: true, next_cursor: "opaque-cursor" });
  });

  it("rejects missing identifiers and enforces branding legal-entity bounds", () => {
    expect(
      normalizeAgencyChild({ slug: "child", billing_mode: "self" }),
    ).toBeNull();
    expect(() =>
      normalizeAgencyBranding({ whitelabel_enabled: "yes" }),
    ).toThrow(/malformed/i);
    expect(
      normalizeAgencyBranding({ ...branding, legal_entity: "a".repeat(200) })
        .legal_entity,
    ).toHaveLength(200);
    expect(() =>
      normalizeAgencyBranding({ ...branding, legal_entity: "a".repeat(201) }),
    ).toThrow(/malformed/i);
  });

  it("accepts the 63-character roster contract and rejects hostile projections", () => {
    const child = {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "a".repeat(63),
      name: "Qualified child",
      tier: "studio",
      parent_tenant_id: "22222222-2222-4222-8222-222222222222",
      billing_mode: "self",
      reseller_markup_bps: 0,
      whitelabel_enabled: false,
      created_at: "2026-09-10T00:00:00Z",
      updated_at: "2026-09-10T00:00:00Z",
    };
    expect(normalizeAgencyChild(child)?.slug).toHaveLength(63);
    expect(normalizeAgencyChild({ ...child, slug: "a".repeat(64) })).toBeNull();
    expect(
      normalizeAgencyChild({ ...child, name: "spoof\u061cname" }),
    ).toBeNull();
    expect(
      normalizeAgencyChild({ ...child, created_at: "2026-02-31T00:00:00Z" }),
    ).toBeNull();
  });

  it("rejects non-base64url cursors and browser-interpreted IP branding hosts", () => {
    expect(() =>
      normalizeAgencyChildrenPage({
        children: [],
        count: 0,
        has_more: true,
        next_cursor: "cursor with spaces",
      }),
    ).toThrow(/malformed/i);
    for (const host of ["127.0.0.1", "127.1", "0177.0.0.1", "0x7f.0.0.1"]) {
      expect(() =>
        normalizeAgencyBranding({ ...branding, custom_domain: host }),
      ).toThrow(/malformed/i);
      expect(() =>
        normalizeAgencyBranding({
          ...branding,
          logo_url: `https://${host}/logo.svg`,
        }),
      ).toThrow(/malformed/i);
    }
    expect(() =>
      normalizeAgencyBranding({
        ...branding,
        etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v00"',
      }),
    ).toThrow(/malformed/i);
  });
});

describe("referral administration contracts", () => {
  it("fails closed before issuing a held fulfillment PATCH", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      Promise.resolve().then(() =>
        updateReferralPayout("reward/1", "approved"),
      ),
    ).rejects.toThrow(/review-gated/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes the mounted masked leaderboard and fulfillment rows", () => {
    expect(
      normalizeReferralLeaderboard({
        window_days: 90,
        items: [
          {
            referrer_email_masked: "a***@example.com",
            conversions: 8,
            milestone: 5,
            rank: 1,
          },
        ],
      }),
    ).toEqual({
      window_days: 90,
      items: [
        {
          referrer_email_masked: "a***@example.com",
          conversions: 8,
          milestone: 5,
          rank: 1,
        },
      ],
    });
    expect(
      normalizeReferralPayoutPage({
        total: 1,
        items: [
          {
            id: "reward-1",
            referrer_id: "subscriber-1",
            milestone: 5,
            reward_label: "Five free sends",
            status: "approved",
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        ],
      }).items[0],
    ).toMatchObject({ id: "reward-1", status: "approved", milestone: 5 });
  });

  it("rejects old leaderboard fields and partial stats instead of showing zero", () => {
    expect(() =>
      normalizeReferralLeaderboard({
        items: [{ email: "raw@example.com", referrals: 5 }],
      }),
    ).toThrow(/invalid row/i);
    expect(() =>
      normalizeReferralStats({
        funnel: { conversions_7d: 1, conversions_30d: 2, conversions_90d: 3 },
        top_referrers: [],
        recent: [],
      }),
    ).toThrow(/malformed/i);
  });

  it("preserves full program metadata but fails closed before a held save", async () => {
    const milestones: ReferralMilestone[] = [
      { count: 3, reward_kind: "custom", reward_label: "Coffee voucher" },
    ];
    const response = {
      id: "program-2",
      active: true,
      expires_at: "2027-01-01T00:00:00Z",
      referee_reward_kind: "custom",
      referee_reward_label: "10% off",
      verification_window_days: 14,
      milestones,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      Promise.resolve().then(() =>
        saveReferralProgram(
          {
            expires_at: response.expires_at,
            referee_reward_kind: response.referee_reward_kind,
            referee_reward_label: response.referee_reward_label,
            verification_window_days: response.verification_window_days,
            milestones: response.milestones,
          },
          { expectedProgramId: "program-1" },
        ),
      ),
    ).rejects.toThrow(/review-gated/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(normalizeReferralProgram(response).verification_window_days).toBe(
      14,
    );
  });
});

describe("discount and coupon pagination contracts", () => {
  it("uses the opaque record ID and the server's bounded event page", async () => {
    const recordId = "11111111-1111-4111-8111-111111111111";
    const rows = [1, 2].map((day) => ({
      redeemed_at: `2026-08-0${day}T00:00:00Z`,
      subscriber_linked: day === 1,
    }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ items: rows, has_more: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listDiscountRedemptionEvents(recordId, { limit: 2, offset: 4 }),
    ).resolves.toEqual({ items: rows, hasMore: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      `http://localhost:8080/api/v1/discounts/${recordId}/redemptions?limit=2&offset=4`,
    );
  });

  it("fails malformed coupon rows rather than presenting a false empty list", () => {
    expect(() => normalizeCouponCodesPage({ items: [{}] })).toThrow(
      /invalid row/i,
    );
    expect(() =>
      normalizeCouponAssignmentsPage({ items: [{ id: "a" }] }),
    ).toThrow(/invalid row/i);
  });
});

describe("billing normalization", () => {
  it("rejects unsupported or partial billing envelopes", () => {
    expect(() => normalizeBillingState({ tier: "enterprise" })).toThrow(
      /malformed/i,
    );
    expect(() =>
      normalizeBillingState({ tier: "studio_ltd", card: {} }),
    ).toThrow(/malformed/i);
    expect(() => normalizeInvoices([{ id: "inv-1", status: "draft" }])).toThrow(
      /invalid row/i,
    );
    expect(() => normalizeUsage([{ date: "yesterday", sent: 4 }])).toThrow(
      /invalid row/i,
    );
    expect(() =>
      normalizeBillingPlanSummary({ tier: "studio", resources: [{}] }),
    ).toThrow(/invalid resource/i);
    expect(() => normalizeLimitsUsage({ tier: "studio", rows: [{}] })).toThrow(
      /invalid resource/i,
    );
  });

  it("sorts usage and derives a missing resource percent from real counts", () => {
    expect(
      normalizeUsage([
        { date: "2026-08-02", sent: 2.9 },
        { date: "2026-08-01", sent: 1 },
      ]),
    ).toEqual([
      { date: "2026-08-01", sent: 1 },
      { date: "2026-08-02", sent: 2 },
    ]);
    expect(
      normalizeBillingPlanSummary({
        tier: "studio",
        resources: [{ resource: "contacts", current: 25, limit: 100 }],
      }).resources[0]?.percent,
    ).toBe(25);
  });
});
