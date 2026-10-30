/**
 * lib/flowAbPolicy.ts — what the numbers on the in-flow A/B screen are allowed
 * to SAY. Import-free, so every rule here is driven directly by node tests.
 *
 * The shapes live in lib/flowAbTests.ts; this file is the judgement, and the
 * judgement is deliberately timid for two reasons.
 *
 * ONE: THE SERVER OWNS SIGNIFICANCE. `evaluateWinner`
 * (apps/api/internal/flowabtests/flowabtests.go:243) runs a two-proportion
 * z-test at alpha 0.05 against the CONFIGURED control (`Variants[0].ID`), and
 * requires both legs to have data. Re-implementing that here would produce a
 * second opinion that eventually contradicts the recorded verdict shown three
 * lines above it on the same screen. So nothing in this file computes a
 * p-value or uses the word "winner" for anything but the STORED verdict.
 *
 * TWO: A LEAD IS NOT A RESULT. What a phone can honestly answer at 2am is "is
 * this test collecting, and is anything pulling ahead" — so `flowAbLeader`
 * reports the observed leader, refuses to name one until both compared arms
 * clear a sample floor, and says "level" rather than inventing a leader from a
 * rounding difference.
 *
 * ABSENCE IS NOT ZERO (house rule 8). The counters table only gains a row when
 * the automation runtime buckets somebody into that variant
 * (services/automation/internal/runtime/postgres_store.go:466). A configured
 * variant with no row has NOT converted at 0% — it has not been measured, and
 * `measured: false` is what forces the renderer to spend an em-dash on it.
 */
import type {
  MobileFlowAbResult,
  MobileFlowAbTest,
  MobileFlowAbWinner,
} from "@/lib/flowAbTests";

/**
 * Both compared arms must have at least this many assignments before the
 * screen names a leader.
 *
 * It is a DISPLAY floor, not a statistical test — there is no sample size at
 * which "ahead" becomes "significant", which is what the server's evaluation
 * is for. 100 is the point below which a single conversion moves a rate by a
 * whole percentage point, i.e. the point below which the ordering is noise.
 */
export const FLOW_AB_SAMPLE_FLOOR = 100;

export interface FlowAbVariantRow {
  variantID: string;
  label: string;
  /** Traffic split as authored, 0..100; null when the server omitted it. */
  percentage: number | null;
  /** The server treats `Variants[0]` as the control (controlVariantID:295). */
  isControl: boolean;
  /**
   * False when the runtime has never bucketed anybody into this variant, so
   * there is no counter row. Every number below is meaningless in that case.
   */
  measured: boolean;
  assigned: number;
  converted: number;
  /** 0..1 FRACTION, as the server computes it. */
  conversionRate: number;
  /**
   * True when this row came from the RESULTS and not from the config — the
   * runtime bucketed subscribers into a variant the stored config no longer
   * lists. Rare, and worth saying out loud rather than dropping the counts.
   */
  unconfigured: boolean;
}

/**
 * Join the configured variants to the live counters.
 *
 * Config order is preserved (it is the authored order, and index 0 is the
 * control). Counter rows with no matching config are appended, flagged, so a
 * renamed or removed variant's traffic is never silently discarded.
 */
export function flowAbVariantRows(
  test: MobileFlowAbTest | null | undefined,
  results: readonly MobileFlowAbResult[] | null | undefined,
): readonly FlowAbVariantRow[] {
  const counters = new Map<string, MobileFlowAbResult>();
  // `?? []` guards null/undefined only; a truthy non-array reaches for-of and
  // throws "object is not iterable".
  for (const r of Array.isArray(results) ? results : []) {
    counters.set(r.variantID, r);
  }
  const rows: FlowAbVariantRow[] = [];
  const seen = new Set<string>();
  (Array.isArray(test?.variants) ? test.variants : []).forEach((variant, index) => {
    seen.add(variant.id);
    const counter = counters.get(variant.id);
    rows.push({
      variantID: variant.id,
      label: variant.label,
      percentage: variant.percentage,
      isControl: index === 0,
      measured: counter !== undefined,
      assigned: counter?.assigned ?? 0,
      converted: counter?.converted ?? 0,
      conversionRate: counter?.conversionRate ?? 0,
      unconfigured: false,
    });
  });
  // Same guard as above: `?? []` admits a truthy non-array into for-of.
  for (const r of Array.isArray(results) ? results : []) {
    if (seen.has(r.variantID)) continue;
    rows.push({
      variantID: r.variantID,
      label: r.variantID,
      percentage: null,
      isControl: false,
      measured: true,
      assigned: r.assigned,
      converted: r.converted,
      conversionRate: r.conversionRate,
      unconfigured: true,
    });
  }
  return rows;
}

export interface FlowAbTotals {
  /** Null when NOTHING has been measured — not 0. */
  assigned: number | null;
  converted: number | null;
  /** Variants with a counter row, over variants that exist at all. */
  measuredVariants: number;
  totalVariants: number;
}

export function flowAbTotals(
  rows: readonly FlowAbVariantRow[],
): FlowAbTotals {
  const measured = rows.filter((r) => r.measured);
  if (measured.length === 0) {
    return {
      assigned: null,
      converted: null,
      measuredVariants: 0,
      totalVariants: rows.length,
    };
  }
  return {
    assigned: measured.reduce((sum, r) => sum + r.assigned, 0),
    converted: measured.reduce((sum, r) => sum + r.converted, 0),
    measuredVariants: measured.length,
    totalVariants: rows.length,
  };
}

export type FlowAbLeader =
  /** Fewer than two variants have counters — there is nothing to compare. */
  | { kind: "no_comparison" }
  /** One of the top two arms is below the floor; `smallest` is its count. */
  | { kind: "insufficient"; smallest: number; floor: number }
  /** The top two rates are identical to the precision the screen renders. */
  | { kind: "level" }
  | {
      kind: "ahead";
      variantID: string;
      label: string;
      /** 0..1 fraction. */
      conversionRate: number;
      /** The gap over the runner-up, in PERCENTAGE POINTS. */
      marginPoints: number;
    };

/**
 * How the top two measured arms compare RIGHT NOW.
 *
 * Deliberately not a winner: no p-value is computed and the word does not
 * appear. `marginPoints` is the raw gap so the renderer can show it beside the
 * claim instead of asking the reader to trust an adjective.
 */
export function flowAbLeader(
  rows: readonly FlowAbVariantRow[],
  floor: number = FLOW_AB_SAMPLE_FLOOR,
): FlowAbLeader {
  const measured = rows
    .filter((r) => r.measured && r.assigned > 0)
    .slice()
    .sort((a, b) => b.conversionRate - a.conversionRate);
  if (measured.length < 2) return { kind: "no_comparison" };
  const [best, runnerUp] = measured as [FlowAbVariantRow, FlowAbVariantRow];
  const smallest = Math.min(best.assigned, runnerUp.assigned);
  if (smallest < floor) return { kind: "insufficient", smallest, floor };
  const marginPoints = (best.conversionRate - runnerUp.conversionRate) * 100;
  // One tenth of a point is the finest gap the screen renders, so anything
  // below it would claim a lead the reader cannot see.
  if (marginPoints < 0.1) return { kind: "level" };
  return {
    kind: "ahead",
    variantID: best.variantID,
    label: best.label,
    conversionRate: best.conversionRate,
    marginPoints,
  };
}

export type FlowAbTone = "success" | "warning" | "neutral";

export function flowAbStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    default:
      // An unknown status is shown verbatim rather than mapped onto the
      // nearest known one — a server that grows a state must not be reported
      // as one of the states this build happens to know.
      return status || "Unknown";
  }
}

export function flowAbStatusTone(status: string): FlowAbTone {
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export interface FlowAbWinnerNotice {
  headline: string;
  detail: string;
  tone: FlowAbTone;
}

/**
 * How to present a STORED verdict.
 *
 * Three cases, and the difference between them matters: significant (the
 * server's z-test cleared alpha), inconclusive (it did not, and the variant
 * named is merely the best rate), and no evaluation at all. The p-value is
 * quoted for the first two because "significant" without one is an appeal to
 * authority.
 */
export function flowAbWinnerNotice(
  winner: MobileFlowAbWinner | null | undefined,
  labelFor: (variantID: string) => string,
): FlowAbWinnerNotice | null {
  if (!winner) return null;
  const label = labelFor(winner.variantID);
  const p = formatPValue(winner.pValue);
  if (winner.significant) {
    return {
      headline: `${label} won this evaluation`,
      detail: `Two-proportion z-test against the control cleared p < 0.05 (p = ${p}).`,
      tone: "success",
    };
  }
  return {
    headline: `Inconclusive — ${label} led`,
    detail: `No arm beat the control significantly (p = ${p}). The lead is the best observed rate, not a result.`,
    tone: "warning",
  };
}

/** Two significant figures, with a floor so a tiny p never renders as "0". */
export function formatPValue(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 0.001) return "<0.001";
  return value.toFixed(3);
}

/**
 * The one sentence that keeps this surface honest about its scope.
 *
 * Authoring a split, changing traffic weights and ENDING a test all live on
 * desktop. Ending in particular: `POST /{id}/evaluate` does not just compute a
 * verdict, it writes `status='completed'` and `ended_at=now()`
 * (flowabtests.go:205) — a one-way act, on a screen whose whole purpose is
 * that you are not at your desk.
 */
export const FLOW_AB_SCOPE_NOTE =
  "Read-only. Creating a split, changing its traffic weights and ending a test — which is what declaring a winner does — stay on desktop.";
