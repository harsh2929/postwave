/**
 * segment-pnl-helpers — pure formatting + ranking logic behind the
 * Segment P&L panel and compare view (feature #4; the P&L surface in
 * apps/api/internal/segments/pnl.go). JSX-free so the node vitest suite
 * can exercise the money/lift/ratio formatters and the compare ranking
 * directly.
 *
 * Honest-UI contract: nothing here invents data. Missing figures (null
 * lift, null AOV, null CLV ratio, zero members) format to explicit
 * "not configured" / "no data" strings, NEVER a fabricated 0% or $0 that
 * would read as a real measurement. Net-contribution colour falls back
 * to the muted token when the figure is null (cross-currency / no
 * denominator), never green/red on a number we don't actually have.
 */

/** A subset of the server SegmentPnLResponse the helpers rank/format. */
export interface PnLCompareItem {
  segment_id: string;
  member_count: number;
  net_contribution_per_member_cents?: number | null;
}

/** Money formatting for a *_cents value in a 3-letter currency code.
 *  Uses Intl when available; falls back to a plain "<code> <amount>" so
 *  an unknown/blank code never throws. Any Unicode spaces Intl inserts
 *  (NBSP U+00A0 / narrow NBSP U+202F) are normalised to a plain space so
 *  the output is stable across engines/locales. */
export function fmtMoneyCents(
  cents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const amount = cents / 100;
  const code = (currency ?? "").trim().toUpperCase();
  if (code.length === 3) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
      })
        .format(amount)
        .replace(/[  ]/g, " ");
    } catch {
      /* unknown ISO code → fall through to plain form */
    }
  }
  const plain = amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return code ? `${code} ${plain}` : plain;
}

/**
 * Net contribution PER MEMBER, signed, e.g. "+$12.50/member" /
 * "−$3.00/member" / "$0.00/member". null (cross-currency / no
 * denominator) → an honest "not available". Uses a real minus sign
 * (U+2212) for negatives and never prefixes "+" on zero.
 */
export function fmtNetContribution(
  centsPerMember: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (centsPerMember == null || !Number.isFinite(centsPerMember)) {
    return "not available";
  }
  const abs = Math.abs(centsPerMember);
  const body = fmtMoneyCents(abs, currency);
  let sign = "";
  if (centsPerMember > 0) sign = "+";
  else if (centsPerMember < 0) sign = "−"; // − minus sign
  return `${sign}${body}/member`;
}

/** CSS-var colour token for a net-contribution figure. null → muted
 *  (we never colour a number we don't have); positive → success;
 *  negative → danger; exactly zero → muted (neither win nor loss). */
export function colourForNetContribution(
  centsPerMember: number | null | undefined,
): string {
  if (
    centsPerMember == null ||
    !Number.isFinite(centsPerMember) ||
    centsPerMember === 0
  ) {
    return "var(--pw-fg-muted)";
  }
  return centsPerMember > 0 ? "var(--pw-success)" : "var(--pw-danger)";
}

/** Result of formatting a SegmentLiftResult-ish shape for display. */
export interface LiftDisplay {
  /** Human sentence, e.g. "↑ 8.3% incremental lift". */
  label: string;
  /** Direction for colour/icon: up | down | flat | none. */
  direction: "up" | "down" | "flat" | "none";
}

/**
 * Format the holdout lift pillar. Accepts the lift object (or
 * null/undefined when no holdout is configured) plus the optional
 * skipped-reason from the server.
 *
 * - no lift + reason "segment_too_large_for_in_process_lift" → honest
 *   "segment too large for in-process lift".
 * - no lift (any other case) → "holdout not configured".
 * - lift_percent > 0 → "↑ X% incremental lift".
 * - lift_percent < 0 → "↓ X% (negative — treated converted less)".
 * - lift_percent === 0 → "no incremental lift detected".
 */
export function fmtLift(
  lift: { lift_percent?: number | null } | null | undefined,
  skippedReason?: string | null,
): LiftDisplay {
  if (lift == null) {
    if (skippedReason === "segment_too_large_for_in_process_lift") {
      return {
        label: "segment too large for in-process lift",
        direction: "none",
      };
    }
    return { label: "holdout not configured", direction: "none" };
  }
  const pct = lift.lift_percent;
  if (pct == null || !Number.isFinite(pct) || pct === 0) {
    return { label: "no incremental lift detected", direction: "flat" };
  }
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  if (pct > 0) {
    return { label: `↑ ${rounded}% incremental lift`, direction: "up" };
  }
  return {
    label: `↓ ${rounded}% (negative — treated converted less)`,
    direction: "down",
  };
}

/**
 * Format the realised-vs-predicted CLV ratio. null (predicted=0 / no
 * scored members) → null so the caller renders a SampleSize "no data"
 * note rather than a fabricated percentage. Ratio >= 1 reads as
 * "realised X% of predicted"; < 1 appends "(under)".
 */
export function fmtCLVRatio(ratio: number | null | undefined): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const pct = Math.round(ratio * 100);
  if (ratio < 1) {
    return `realised ${pct}% of predicted (under)`;
  }
  return `realised ${pct}% of predicted`;
}

/** A ranked compare item: the input plus a 1-based rank and winner flag. */
export interface RankedPnLItem extends PnLCompareItem {
  rank: number;
  isWinner: boolean;
}

/**
 * Rank compare items by net_contribution_per_member_cents descending.
 * Deterministic: ties (including null-vs-null) break by segment_id
 * ascending. null net contribution sorts LAST (an unknown figure can't
 * win). Only the single highest non-null item is flagged isWinner; if
 * every item is null, there is no winner.
 */
export function compareRank(items: PnLCompareItem[]): RankedPnLItem[] {
  const sorted = [...items].sort((a, b) => {
    const av = a.net_contribution_per_member_cents;
    const bv = b.net_contribution_per_member_cents;
    const aNull = av == null || !Number.isFinite(av);
    const bNull = bv == null || !Number.isFinite(bv);
    if (aNull && bNull) {
      return a.segment_id < b.segment_id ? -1 : a.segment_id > b.segment_id ? 1 : 0;
    }
    if (aNull) return 1; // nulls last
    if (bNull) return -1;
    if (av !== bv) return (bv as number) - (av as number);
    return a.segment_id < b.segment_id ? -1 : a.segment_id > b.segment_id ? 1 : 0;
  });

  // Winner = the top item, only when its figure is a real (non-null) value.
  const top = sorted[0];
  const topVal = top?.net_contribution_per_member_cents;
  const hasWinner = top != null && topVal != null && Number.isFinite(topVal);

  return sorted.map((item, idx) => ({
    ...item,
    rank: idx + 1,
    isWinner: hasWinner && idx === 0,
  }));
}
