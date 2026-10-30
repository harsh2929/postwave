// SPDX-License-Identifier: AGPL-3.0-only
//
// Substantive in-memory mocks for the affiliate admin UI. Five sample
// affiliates with realistic conversion histories so the UI looks alive when
// NEXT_PUBLIC_USE_MOCKS=1.

import type {
  Affiliate,
  AffiliateConversion,
  AffiliateDetail,
  AffiliatePayout,
  AffiliateStats,
  AffiliateUpdateInput,
} from "./affiliates-types";

const NOW = Date.parse("2026-04-30T12:00:00Z");

function daysAgo(d: number): string {
  return new Date(NOW - d * 86_400_000).toISOString();
}

const AFFILIATES: Affiliate[] = [
  {
    id: "aff_jane_doe",
    slug: "janedoe",
    email: "jane@example.com",
    name: "Jane Doe",
    country: "US",
    status: "approved",
    payoutMethod: "paypal",
    payoutEmail: "jane@example.com",
    taxFormStatus: "submitted",
    taxFormType: "w9",
    notes: "Top earner — runs the 80K-subscriber Saturday Letters newsletter.",
    website: "https://saturdayletters.example.com",
    audienceSize: 80_000,
    audienceDesc: "Weekly newsletter for indie creators.",
    createdAt: daysAgo(180),
    approvedAt: daysAgo(178),
    updatedAt: daysAgo(2),
  },
  {
    id: "aff_creator_pro",
    slug: "creatorpro",
    email: "team@creatorpro.io",
    name: "Creator Pro Media",
    country: "GB",
    status: "approved",
    payoutMethod: "wise",
    payoutEmail: "billing@creatorpro.io",
    taxFormStatus: "submitted",
    taxFormType: "w8ben",
    website: "https://creatorpro.io",
    audienceSize: 250_000,
    audienceDesc: "Substack for SaaS founders in EU.",
    createdAt: daysAgo(120),
    approvedAt: daysAgo(118),
    updatedAt: daysAgo(7),
  },
  {
    id: "aff_marcus_blog",
    slug: "marcusblog",
    email: "marcus@example.in",
    name: "Marcus Patel",
    country: "IN",
    status: "approved",
    payoutMethod: "wise",
    payoutEmail: "marcus@example.in",
    taxFormStatus: "not_required",
    taxFormType: "none",
    website: "https://marcuswrites.example.in",
    audienceSize: 18_000,
    audienceDesc: "Tech reviews + email-marketing tutorials.",
    createdAt: daysAgo(75),
    approvedAt: daysAgo(74),
    updatedAt: daysAgo(14),
  },
  {
    id: "aff_pending_one",
    slug: "newsletter-school",
    email: "hi@newsletter-school.example",
    name: "Newsletter School",
    country: "DE",
    status: "pending",
    notes: "Applied last week — needs audience verification.",
    website: "https://newsletter-school.example",
    audienceSize: 12_000,
    audienceDesc: "Course teaching newsletter writers.",
    createdAt: daysAgo(6),
    updatedAt: daysAgo(6),
  },
  {
    id: "aff_terminated",
    slug: "spammyguy",
    email: "void@example.com",
    name: "Anonymous Spammer",
    country: "US",
    status: "terminated",
    payoutMethod: "paypal",
    payoutEmail: "void@example.com",
    taxFormStatus: "expired",
    taxFormType: "w9",
    notes:
      "Terminated 2026-02-15 — repeated unsolicited cold-email referrals violating ToS §6 (Acceptable promotion).",
    createdAt: daysAgo(220),
    approvedAt: daysAgo(218),
    updatedAt: daysAgo(75),
  },
];

const CONVERSIONS: Record<string, AffiliateConversion[]> = {
  aff_jane_doe: makeConversions("aff_jane_doe", 47),
  aff_creator_pro: makeConversions("aff_creator_pro", 22),
  aff_marcus_blog: makeConversions("aff_marcus_blog", 11),
  aff_pending_one: [],
  aff_terminated: makeConversions("aff_terminated", 4, true),
};

const PAYOUTS: Record<string, AffiliatePayout[]> = {
  aff_jane_doe: [
    {
      id: "po_jane_2",
      affiliateId: "aff_jane_doe",
      amountCents: 32_400,
      currency: "USD",
      payoutMethod: "paypal",
      payoutReference: "PAYID-XYZ-2026-04",
      status: "sent",
      sentAt: daysAgo(28),
      createdAt: daysAgo(30),
    },
    {
      id: "po_jane_1",
      affiliateId: "aff_jane_doe",
      amountCents: 28_700,
      currency: "USD",
      payoutMethod: "paypal",
      payoutReference: "PAYID-XYZ-2026-03",
      status: "sent",
      sentAt: daysAgo(58),
      createdAt: daysAgo(60),
    },
  ],
  aff_creator_pro: [
    {
      id: "po_cp_1",
      affiliateId: "aff_creator_pro",
      amountCents: 11_900,
      currency: "USD",
      payoutMethod: "wise",
      payoutReference: "WISE-998877",
      status: "sent",
      sentAt: daysAgo(28),
      createdAt: daysAgo(30),
    },
  ],
  aff_marcus_blog: [],
  aff_pending_one: [],
  aff_terminated: [],
};

function makeConversions(
  affiliateId: string,
  count: number,
  reversedHeavy = false,
): AffiliateConversion[] {
  const out: AffiliateConversion[] = [];
  for (let i = 0; i < count; i++) {
    const ageDays = i * 4 + Math.floor(Math.random() * 3);
    const which = i % 5;
    let kind: AffiliateConversion["kind"];
    let amount = 0;
    let commission = 0;
    let rate = 0;
    if (which === 0) {
      kind = "ltd_purchase";
      amount = 34_900;
      commission = 5000;
      rate = (commission * 100) / amount;
    } else if (which === 1) {
      kind = "pro_subscription";
      amount = 7900;
      commission = 1975;
      rate = 25;
    } else {
      kind = "sending_subscription";
      amount = 2900;
      commission = 870;
      rate = 30;
    }
    let status: AffiliateConversion["status"] = "approved";
    if (i === 0) status = "pending";
    if (i % 11 === 0 && i !== 0) status = "paid";
    if (reversedHeavy && i % 2 === 0) status = "reversed";
    out.push({
      id: i + 1,
      affiliateId,
      tenantId: `tenant_${affiliateId}_${i}`,
      cookieId: `cookie_${affiliateId}_${i}`,
      kind,
      amountCents: amount,
      commissionCents: commission,
      commissionRatePct: rate,
      status,
      stripePaymentIntentId: `pi_mock_${affiliateId}_${i}`,
      createdAt: daysAgo(ageDays),
      paidAt: status === "paid" ? daysAgo(Math.max(0, ageDays - 1)) : undefined,
      reversedAt:
        status === "reversed" ? daysAgo(Math.max(0, ageDays - 2)) : undefined,
    });
  }
  return out;
}

function statsFor(affiliateId: string, days: number): AffiliateStats {
  const cutoff = NOW - days * 86_400_000;
  const convs = CONVERSIONS[affiliateId] ?? [];
  const window = convs.filter((c) => Date.parse(c.createdAt) >= cutoff);
  const totalCommissionCents = window
    .filter((c) => c.status !== "reversed" && c.status !== "disputed")
    .reduce((s, c) => s + c.commissionCents, 0);
  const pendingPayoutCents = (CONVERSIONS[affiliateId] ?? [])
    .filter((c) => c.status === "approved" || c.status === "pending")
    .reduce((s, c) => s + c.commissionCents, 0);
  return {
    clicks: window.length * 12 + 30,
    signups: window.length,
    conversions: window.length,
    totalCommissionCents,
    pendingPayoutCents,
  };
}

export function mockListAffiliates(): Affiliate[] {
  return [...AFFILIATES];
}

export function mockGetAffiliate(id: string): AffiliateDetail {
  const a = AFFILIATES.find((x) => x.id === id);
  if (!a) throw new Error(`mock: no affiliate ${id}`);
  return {
    affiliate: a,
    stats: {
      last30: statsFor(id, 30),
      last90: statsFor(id, 90),
      last365: statsFor(id, 365),
      lifetime: statsFor(id, 36500),
    },
  };
}

export function mockListConversions(id: string): AffiliateConversion[] {
  return CONVERSIONS[id] ?? [];
}

export function mockListPayouts(id: string): AffiliatePayout[] {
  return PAYOUTS[id] ?? [];
}

export function mockUpdateAffiliate(
  id: string,
  patch: AffiliateUpdateInput,
): Affiliate {
  const idx = AFFILIATES.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`mock: no affiliate ${id}`);
  AFFILIATES[idx] = {
    ...AFFILIATES[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return AFFILIATES[idx];
}

export function mockCreateAffiliate(input: {
  email: string;
  name: string;
  country?: string;
  slug?: string;
  website?: string;
  audienceSize?: number;
  audienceDesc?: string;
}): Affiliate {
  const now = new Date().toISOString();
  const a: Affiliate = {
    id: `aff_${Math.random().toString(36).slice(2, 10)}`,
    slug:
      input.slug?.trim() ||
      input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    country: input.country?.trim().toUpperCase() || undefined,
    status: "approved",
    website: input.website?.trim() || undefined,
    audienceSize: input.audienceSize,
    audienceDesc: input.audienceDesc?.trim() || undefined,
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
  };
  AFFILIATES.unshift(a);
  CONVERSIONS[a.id] = [];
  PAYOUTS[a.id] = [];
  return a;
}

export function mockCreatePayout(id: string): AffiliatePayout {
  const conv = (CONVERSIONS[id] ?? []).filter(
    (c) => c.status === "approved" || c.status === "pending",
  );
  const total = conv.reduce((s, c) => s + c.commissionCents, 0);
  const p: AffiliatePayout = {
    id: `po_${Math.random().toString(36).slice(2, 8)}`,
    affiliateId: id,
    amountCents: total,
    currency: "USD",
    payoutMethod: AFFILIATES.find((a) => a.id === id)?.payoutMethod,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  PAYOUTS[id] = [p, ...(PAYOUTS[id] ?? [])];
  for (const c of conv) c.status = "paid";
  return p;
}
