/**
 * decay-helpers — pure logic for Segment Decay Radar (feature #5).
 *
 * Backs SegmentDecaySection.tsx. No React imports. Covers:
 *   - anomalyKindLabel / anomalyKindTone : humanise the four anomaly
 *     kinds (size_cliff | zero_match | everyone_match | definition_changed).
 *   - cliffPercent : prior→new drop as a percentage, guarded against
 *     divide-by-zero (prior=0 → 0, never NaN/Infinity).
 *   - attributionBars : normalise a {clause_index: leaver_count} map into
 *     sorted, percentage-weighted bars (handles all-zero gracefully).
 *   - definitionDiffSummary : a short plain-English line for a
 *     before/after segment definition diff.
 *   - boundedLeaverNote : honest "showing N of M logged leavers" copy for
 *     the per-direction log cap (ComputedFrom companion).
 *
 * Honest-UI: attribution is structurally an ESTIMATE (clauses overlap in
 * AND predicates) — the component renders an EstimateBadge alongside
 * these bars; this module only computes the numbers, it never decides
 * they are authoritative.
 */

export type AnomalyKind =
  | "size_cliff"
  | "zero_match"
  | "everyone_match"
  | "definition_changed";

/** Human label for an anomaly kind. Unknown kinds echo a cleaned string. */
export function anomalyKindLabel(kind: string): string {
  switch (kind) {
    case "size_cliff":
      return "Membership cliff";
    case "zero_match":
      return "Matches nobody";
    case "everyone_match":
      return "Matches everyone";
    case "definition_changed":
      return "Definition changed";
    default: {
      const cleaned = (kind || "Anomaly").replace(/[._-]+/g, " ").trim();
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }
}

/** Tone hint for the chip colour. All decay events are advisory, never
 *  errors — "warn" for the severe collapses, "info" otherwise. */
export function anomalyKindTone(kind: string): "warn" | "info" {
  return kind === "zero_match" || kind === "size_cliff" ? "warn" : "info";
}

/**
 * Drop percentage from prior→new, rounded to one decimal. Guards:
 *   - prior <= 0 → 0 (can't compute a drop fraction; never NaN/Infinity)
 *   - new >= prior (grew/stable) → 0 (this is not a drop)
 * Returns a non-negative number (the magnitude of the drop).
 */
export function cliffPercent(priorCount: number, newCount: number): number {
  const prior = Number.isFinite(priorCount) ? priorCount : 0;
  const next = Number.isFinite(newCount) ? newCount : 0;
  if (prior <= 0) return 0;
  if (next >= prior) return 0;
  const pct = ((prior - next) / prior) * 100;
  return Math.round(pct * 10) / 10;
}

/** A signed delta label, e.g. "−600 (−60.0%)" / "+5". */
export function deltaLabel(priorCount: number, newCount: number): string {
  const prior = Number.isFinite(priorCount) ? priorCount : 0;
  const next = Number.isFinite(newCount) ? newCount : 0;
  const delta = next - prior;
  if (delta === 0) return "no change";
  const sign = delta > 0 ? "+" : "−";
  const mag = Math.abs(delta).toLocaleString();
  if (prior <= 0) return `${sign}${mag}`;
  const pct = cliffPercent(prior, next);
  // pct is the drop magnitude; only meaningful for a decrease.
  if (delta < 0 && pct > 0) return `−${mag} (−${pct.toFixed(1)}%)`;
  return `${sign}${mag}`;
}

export interface AttributionBar {
  /** Clause index (0-based, as stored in clause_attrs). */
  clauseIndex: number;
  /** Raw leaver count attributed to this clause. */
  count: number;
  /** Share of the total attributed leavers, 0–100, rounded to integer. */
  pct: number;
}

/**
 * Normalise a {clause_index: leaver_count} map into sorted bars (highest
 * count first), with each bar's pct = count / sum * 100. All-zero or
 * empty input yields []. No divide-by-zero: when the sum is 0 every pct
 * is 0. clause_index keys arrive as strings over the wire — both string
 * and number keys are accepted.
 */
export function attributionBars(
  clauseAttrs: Record<string, number> | undefined | null,
): AttributionBar[] {
  if (!clauseAttrs) return [];
  const entries = Object.entries(clauseAttrs)
    .map(([k, v]) => ({
      clauseIndex: Number.parseInt(k, 10),
      count: Number.isFinite(v) ? Math.max(0, v) : 0,
    }))
    .filter((e) => Number.isFinite(e.clauseIndex));
  if (entries.length === 0) return [];
  const sum = entries.reduce((acc, e) => acc + e.count, 0);
  const bars = entries.map((e) => ({
    clauseIndex: e.clauseIndex,
    count: e.count,
    pct: sum > 0 ? Math.round((e.count / sum) * 100) : 0,
  }));
  // Highest count first; ties broken by clause index for stable order.
  bars.sort((a, b) => b.count - a.count || a.clauseIndex - b.clauseIndex);
  return bars;
}

/**
 * Whether the attribution sample is too small to trust (drives a
 * ConfidenceNote level="low"). Threshold mirrors the spec's < 10 leavers.
 */
export function attributionLowConfidence(leaverCount: number): boolean {
  return (Number.isFinite(leaverCount) ? leaverCount : 0) < 10;
}

/**
 * Short plain-English summary of a before/after segment-definition diff.
 * Both sides are opaque AST objects; we report shape-level facts only
 * (name change, predicate change presence) — never fabricate specifics.
 */
export function definitionDiffSummary(
  before: unknown,
  after: unknown,
): string {
  if (before == null && after == null) return "No definition change recorded.";
  if (before == null) return "Segment definition created.";
  if (after == null) return "Segment deleted.";
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const parts: string[] = [];
  if ("name" in b || "name" in a) {
    if (b.name !== a.name) {
      parts.push(`renamed "${String(b.name ?? "")}" → "${String(a.name ?? "")}"`);
    }
  }
  const bAst = JSON.stringify(b.queryAst ?? b.query_ast ?? null);
  const aAst = JSON.stringify(a.queryAst ?? a.query_ast ?? null);
  if (bAst !== aAst) {
    parts.push("predicate changed");
  }
  if (parts.length === 0) return "Definition updated (no field-level diff detected).";
  return `Definition ${parts.join(", ")}.`;
}

/**
 * Honest copy for the per-direction membership-log cap. When
 * boundedByLogCap is true the full exit set may be larger than what was
 * logged. Pairs with the ComputedFrom provenance primitive.
 */
export function boundedLeaverNote(
  shown: number,
  totalInLog: number,
  boundedByLogCap: boolean,
  unit = "leavers",
): string {
  const n = Math.max(0, Number.isFinite(shown) ? shown : 0);
  const m = Math.max(n, Number.isFinite(totalInLog) ? totalInLog : 0);
  if (boundedByLogCap) {
    return `Showing ${n.toLocaleString()} of ${m.toLocaleString()} logged ${unit} — the full exit set may be larger (per-day log cap reached).`;
  }
  if (m === 0) return `No ${unit} logged for this event.`;
  return `Showing ${n.toLocaleString()} of ${m.toLocaleString()} logged ${unit}.`;
}
