/**
 * segmentCompareRows — pure parsing/policy for the two segment-comparison
 * reads (desktop anchors: pages/Segments.tsx SegmentOverlapCard + "Compare
 * audiences" / segmentPnlClient.ts):
 *
 *   GET /api/v1/segments/overlap?a=&b=        (overlap.go)
 *       {a, b, a_count, b_count, intersection, jaccard}
 *   GET /api/v1/segments/pnl/compare?ids=&days= (pnl_handlers.go)
 *       {items:[SegmentPnLResponse], window_days, days}
 *
 * Both viewer reads (read:subscribers / read:reports). Holdout CONFIG
 * (POST/DELETE /segments/{id}/holdout) is deliberately not wired on mobile —
 * the compare view is read-only, matching the parity row's scope call.
 *
 * The P&L row keeps only what a phone-width comparison can honestly show:
 * members, conversions, revenue, unsubs/complaints, and net contribution
 * WHEN the server could compute one (cost config present). A missing net is
 * rendered as "no cost config", never as zero.
 */
import { money } from "./format";

export interface SegmentOverlap {
  aCount: number;
  bCount: number;
  intersection: number;
  jaccard: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseSegmentOverlap(res: unknown): SegmentOverlap {
  const row = (res ?? {}) as Record<string, unknown>;
  return {
    aCount: num(row.a_count),
    bCount: num(row.b_count),
    intersection: num(row.intersection),
    jaccard: num(row.jaccard),
  };
}

export interface SegmentPnlRow {
  segmentId: string;
  memberCount: number;
  conversions: number;
  revenueCents: number;
  currency: string;
  unsubCount: number;
  complaintCount: number;
  /** null = the server had no cost config, NOT "zero contribution". */
  netContributionCents: number | null;
  windowDays: number;
}

export function parseSegmentPnlCompare(res: unknown): SegmentPnlRow[] {
  const envelope = (res ?? {}) as Record<string, unknown>;
  const items = Array.isArray(envelope.items) ? envelope.items : [];
  const out: SegmentPnlRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.segment_id == null) continue;
    out.push({
      segmentId: String(r.segment_id),
      memberCount: num(r.member_count),
      conversions: num(r.revenue_conversions),
      revenueCents: num(r.revenue_cents),
      currency: typeof r.currency === "string" ? r.currency : "",
      unsubCount: num(r.unsub_count),
      complaintCount: num(r.complaint_count),
      netContributionCents:
        typeof r.net_contribution_cents === "number" &&
        Number.isFinite(r.net_contribution_cents)
          ? r.net_contribution_cents
          : null,
      windowDays: num(r.window_days),
    });
  }
  return out;
}

/** Server bounds on the compare read (pnl_handlers.go: 2..5 ids). */
export const COMPARE_MIN_SEGMENTS = 2;
export const COMPARE_MAX_SEGMENTS = 5;

/**
 * Selection policy for the compare sheet. Answers, for a given selection,
 * whether one more id may be added and whether the compare may fire — so the
 * UI can withhold the checkbox/button instead of letting the server 400.
 */
export function compareSelection(selected: readonly string[]): {
  canAddMore: boolean;
  canCompare: boolean;
  /** Overlap is pairwise; offered only for exactly two segments. */
  canOverlap: boolean;
} {
  const n = new Set(selected).size;
  return {
    canAddMore: n < COMPARE_MAX_SEGMENTS,
    canCompare: n >= COMPARE_MIN_SEGMENTS && n <= COMPARE_MAX_SEGMENTS,
    canOverlap: n === 2,
  };
}

/** "$12.34"-style rendering for integer cents; falls back to a bare number
 * when the server sent no currency. Pure so the rounding is testable. */
export function formatCents(cents: number, currency: string): string {
  const units = cents / 100;
  if (!currency) return units.toFixed(2);
  try {
    // `money` owns the cached currency formatter for the whole app; `cents:
    // true` keeps the two decimals this line has always shown, so a P&L
    // column cannot round a figure differently from the tile above it.
    return money(units, currency, { cents: true });
  } catch {
    // A currency code the engine does not know throws inside Intl. The number
    // is still worth showing, so it degrades to the bare units plus the code.
    return `${units.toFixed(2)} ${currency}`;
  }
}
