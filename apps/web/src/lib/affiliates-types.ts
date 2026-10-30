// SPDX-License-Identifier: AGPL-3.0-only
//
// Affiliate program domain types — mirror of apps/api/internal/affiliates/affiliates.go
// on the wire. Field names are camelCase to match the Go JSON tags.

export type AffiliateStatus =
  | "pending"
  | "approved"
  | "suspended"
  | "terminated";

export type AffiliatePayoutMethod = "paypal" | "wise" | "stripe_connect";

export type AffiliateTaxFormStatus =
  | "not_required"
  | "pending"
  | "submitted"
  | "expired";

export type AffiliateTaxFormType = "w9" | "w8ben" | "none";

export type ConversionKind =
  | "ltd_purchase"
  | "sending_subscription"
  | "pro_subscription";

export type ConversionStatus =
  | "pending"
  | "approved"
  | "paid"
  | "reversed"
  | "disputed";

export type PayoutStatus = "pending" | "sent" | "failed";

export interface Affiliate {
  id: string;
  slug: string;
  email: string;
  name: string;
  country?: string;
  status: AffiliateStatus;
  payoutMethod?: AffiliatePayoutMethod;
  payoutEmail?: string;
  taxFormStatus?: AffiliateTaxFormStatus;
  taxFormType?: AffiliateTaxFormType;
  notes?: string;
  website?: string;
  audienceSize?: number;
  audienceDesc?: string;
  createdAt: string;
  approvedAt?: string;
  updatedAt: string;
}

export interface AffiliateClick {
  id: number;
  affiliateId: string;
  ip?: string;
  userAgent?: string;
  landingPage?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  cookieId: string;
  clickedAt: string;
}

export interface AffiliateConversion {
  id: number;
  affiliateId: string;
  tenantId?: string;
  cookieId: string;
  kind: ConversionKind;
  amountCents: number;
  commissionCents: number;
  commissionRatePct: number;
  recurringPeriodEnd?: string;
  status: ConversionStatus;
  stripePaymentIntentId?: string;
  createdAt: string;
  paidAt?: string;
  reversedAt?: string;
}

export interface AffiliatePayout {
  id: string;
  affiliateId: string;
  amountCents: number;
  currency: string;
  payoutMethod?: AffiliatePayoutMethod;
  payoutReference?: string;
  status: PayoutStatus;
  sentAt?: string;
  notes?: string;
  createdAt: string;
}

export interface AffiliateStats {
  clicks: number;
  signups: number;
  conversions: number;
  totalCommissionCents: number;
  pendingPayoutCents: number;
}

export interface AffiliateDetail {
  affiliate: Affiliate;
  stats: {
    last30: AffiliateStats;
    last90: AffiliateStats;
    last365: AffiliateStats;
    lifetime: AffiliateStats;
  };
  /** 12 zero-filled monthly commission buckets for the chart (BILL-018),
      so the detail page no longer loads every conversion up front. */
  monthly?: { label: string; commissionCents: number }[];
}

export interface AffiliateUpdateInput {
  status?: AffiliateStatus;
  payoutMethod?: AffiliatePayoutMethod;
  payoutEmail?: string;
  taxFormStatus?: AffiliateTaxFormStatus;
  taxFormType?: AffiliateTaxFormType;
  notes?: string;
}

/** Commission rate constants — kept in lockstep with the Go consts. */
export const COMMISSION_RATES = {
  ltdFlatCents: 5000, // $50 flat per LTD sale
  sendingPct: 30, // 30% recurring on the Sending tier
  proPct: 25, // 25% recurring on the Pro tier
} as const;

/**
 * Pretty-print cents → "$X.YY". Re-exported from the shared money formatter so
 * the affiliate surface and billing stay byte-identical; kept here as a named
 * export so existing call sites (`@/lib/affiliates-types`) don't have to move.
 */
export { formatCents } from "./format-currency";
