// SPDX-License-Identifier: AGPL-3.0-only
//
// Chronological activity/audit trail for one affiliate (BILL-048). Composed
// entirely from timestamps the detail page already loads — signup, approval,
// payout initiation/settlement, and commission paid/reversed events — so it
// needs no new endpoint. Newest first.
"use client";

import { RelativeTime } from "@/components/relative-time";
import {
  formatCents,
  type Affiliate,
  type AffiliateConversion,
  type AffiliatePayout,
} from "@/lib/affiliates-types";

interface TimelineEvent {
  at: string;
  label: string;
}

export function ActivityTimeline({
  affiliate,
  payouts,
  conversions,
}: {
  affiliate: Affiliate;
  payouts: AffiliatePayout[];
  conversions: AffiliateConversion[];
}) {
  const events: TimelineEvent[] = [];
  events.push({ at: affiliate.createdAt, label: "Affiliate signed up" });
  if (affiliate.approvedAt) {
    events.push({ at: affiliate.approvedAt, label: "Application approved" });
  }
  for (const p of payouts) {
    events.push({
      at: p.createdAt,
      label: `Payout initiated — ${formatCents(p.amountCents, p.currency)}`,
    });
    if (p.sentAt) {
      events.push({
        at: p.sentAt,
        label: `Payout ${p.status}${
          p.payoutReference ? ` (${p.payoutReference})` : ""
        }`,
      });
    }
  }
  for (const c of conversions) {
    if (c.paidAt) {
      events.push({
        at: c.paidAt,
        label: `Commission paid — ${formatCents(c.commissionCents)}`,
      });
    }
    if (c.reversedAt) {
      events.push({
        at: c.reversedAt,
        label: `Commission ${c.status} — ${formatCents(c.commissionCents)}`,
      });
    }
  }
  // Newest first; string compare is safe for ISO-8601 timestamps.
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  if (events.length === 0) return null;

  return (
    <ol className="space-y-3">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-start gap-3 text-sm">
          <span
            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50"
            aria-hidden
          />
          <div className="min-w-0">
            <div>{e.label}</div>
            <div className="text-xs text-muted-foreground">
              <RelativeTime iso={e.at} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
