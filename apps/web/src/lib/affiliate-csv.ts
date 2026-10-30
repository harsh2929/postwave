// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure CSV builders for the affiliate conversions/payouts exports. Kept
// dependency-free and unit-tested so the reconciliation/accounting extract has
// stable columns and correctly-escaped cells. Amounts are emitted as decimal
// currency units (cents/100) so a spreadsheet sums them without a ×100 fixup;
// the on-screen tables keep the localized display strings.

import type {
  AffiliateConversion,
  AffiliatePayout,
} from "./affiliates-types";

import { safeCsvCell } from "./csv-safe";

/** RFC-4180 cell escaping plus the spreadsheet formula guard. Affiliate names,
 * emails, and payout references are partner-supplied, so an export opened in
 * Excel must not evaluate them as formulas. */
export function csvCell(value: string | number | null | undefined): string {
  return safeCsvCell(value == null ? "" : String(value));
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(","));
  return lines.join("\r\n");
}

function dollars(cents: number): string {
  return (Number.isFinite(cents) ? cents / 100 : 0).toFixed(2);
}

export function conversionsToCsv(rows: AffiliateConversion[]): string {
  return toCsv(
    [
      "id",
      "created_at",
      "kind",
      "status",
      "sale_amount",
      "commission",
      "commission_rate_pct",
      "stripe_payment_intent_id",
    ],
    rows.map((r) => [
      r.id,
      r.createdAt,
      r.kind,
      r.status,
      dollars(r.amountCents),
      dollars(r.commissionCents),
      r.commissionRatePct,
      r.stripePaymentIntentId ?? "",
    ]),
  );
}

export function payoutsToCsv(rows: AffiliatePayout[]): string {
  return toCsv(
    ["id", "created_at", "amount", "currency", "method", "reference", "status", "sent_at"],
    rows.map((r) => [
      r.id,
      r.createdAt,
      dollars(r.amountCents),
      r.currency,
      r.payoutMethod ?? "",
      r.payoutReference ?? "",
      r.status,
      r.sentAt ?? "",
    ]),
  );
}
