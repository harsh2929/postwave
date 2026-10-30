/**
 * growth-helpers — pure logic behind the per-form Growth panel
 * (backlog #49, onsite_growth). JSX-free for the node vitest suite
 * (same pattern as form-metrics.ts in this directory).
 *
 * Wire notes (apps/api/internal/onsite_growth):
 *   - targeting rule groups are opaque JSON objects on the wire
 *     (`Record<string, unknown>`); the panel edits them as raw JSON
 *     and runs POST /onsite-growth/validate before PUT.
 *   - traffic weights + spin reward weights are integer BASIS POINTS
 *     (10000 = 100%).
 *   - experiment event counts live inside each variant's `metrics`
 *     bag — numeric entries only; non-numeric values are ignored.
 */

import type {
  OnsiteExperiment,
  OnsiteExperimentVariant,
  OnsiteSpinReward,
  OnsiteTargetingRules,
} from "../../lib/api-client";

/* ---------- basis points --------------------------------------------- */

/** 2500bp → "25%", 1250bp → "12.5%". Undefined → em-dash. */
export function fmtBasisPoints(bp: number | undefined | null): string {
  if (typeof bp !== "number" || Number.isNaN(bp)) return "—";
  const pct = bp / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/**
 * Spin-reward weight audit: the public spin resolver draws across the
 * reward weights, so a table that doesn't total 100% (10000bp) means
 * the displayed odds lie. We surface the total + a flag rather than
 * blocking — the server is the validator of record.
 */
export function spinWeightSummary(
  items: ReadonlyArray<OnsiteSpinReward>,
): { totalBp: number; complete: boolean } {
  const totalBp = items.reduce(
    (n, r) => n + (typeof r.weight_basis_points === "number" ? r.weight_basis_points : 0),
    0,
  );
  return { totalBp, complete: totalBp === 10_000 };
}

/* ---------- spin reward editor (PUT /spin/rewards) --------------------- */

/** The coupon linkage choices the wire shape supports: a fixed code,
 *  a coupon pool the resolver reserves from, or nothing. */
export type SpinCouponKind = "none" | "static_code" | "coupon_pool";

/** Editable projection of one OnsiteSpinReward row. `base` carries the
 *  wire fields the lightweight editor doesn't touch (id, reward_type,
 *  status, display, …) so a save round-trips them verbatim. */
export interface SpinRewardDraft {
  key: string;
  label: string;
  /** Weight in basis points, as typed (validated on build). */
  weightText: string;
  couponKind: SpinCouponKind;
  couponValue: string;
  base: OnsiteSpinReward | null;
}

export function spinRewardToDraft(r: OnsiteSpinReward): SpinRewardDraft {
  return {
    key: r.key,
    label: r.label,
    weightText: String(r.weight_basis_points ?? 0),
    couponKind: r.coupon_pool_id
      ? "coupon_pool"
      : r.static_code
        ? "static_code"
        : "none",
    couponValue: r.coupon_pool_id ?? r.static_code ?? "",
    base: r,
  };
}

export function newSpinRewardDraft(): SpinRewardDraft {
  return { key: "", label: "", weightText: "", couponKind: "none", couponValue: "", base: null };
}

/** Weight audit over the editor rows: unparsable weights count as 0 so
 *  the total reflects what would be saved. Same {totalBp, complete}
 *  contract as spinWeightSummary. */
export function spinDraftWeightSummary(
  drafts: ReadonlyArray<SpinRewardDraft>,
): { totalBp: number; complete: boolean } {
  return spinWeightSummary(
    drafts.map((d) => {
      const n = Number(d.weightText.trim());
      return {
        key: d.key,
        label: d.label,
        weight_basis_points: Number.isInteger(n) && n >= 0 ? n : 0,
      };
    }),
  );
}

export type SpinRewardsBuildResult =
  | { ok: true; items: OnsiteSpinReward[] }
  | { ok: false; index: number; error: string };

/**
 * Assemble the PUT /spin/rewards body (full replace) from the editor
 * rows. Per-row checks return the first offending index so the editor
 * can flag that row; cross-field weight balance is left to the server
 * validator (and the non-blocking ≠100% audit).
 */
export function buildSpinRewardsInput(
  drafts: ReadonlyArray<SpinRewardDraft>,
): SpinRewardsBuildResult {
  const seen = new Set<string>();
  const items: OnsiteSpinReward[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const key = d.key.trim();
    if (!key) return { ok: false, index: i, error: "Key is required (e.g. ten-off)." };
    if (seen.has(key)) return { ok: false, index: i, error: `Duplicate key "${key}".` };
    seen.add(key);
    if (!d.label.trim()) return { ok: false, index: i, error: "Label is required." };
    const weight = Number(d.weightText.trim());
    if (!Number.isInteger(weight) || weight < 0) {
      return {
        ok: false,
        index: i,
        error: "Weight must be a whole number of basis points (10000 = 100%).",
      };
    }
    const couponValue = d.couponValue.trim();
    if (d.couponKind !== "none" && !couponValue) {
      return {
        ok: false,
        index: i,
        error:
          d.couponKind === "static_code"
            ? "Enter the static coupon code."
            : "Enter the coupon pool id.",
      };
    }
    // Start from the original wire row so untouched fields (id,
    // reward_type, status, display, …) round-trip verbatim.
    const item: OnsiteSpinReward = {
      ...(d.base ?? {}),
      key,
      label: d.label.trim(),
      weight_basis_points: weight,
      sort_order: i,
    };
    delete item.static_code;
    delete item.coupon_pool_id;
    if (d.couponKind === "static_code") item.static_code = couponValue;
    if (d.couponKind === "coupon_pool") item.coupon_pool_id = couponValue;
    items.push(item);
  }
  return { ok: true, items };
}

/* ---------- experiment event counts ----------------------------------- */

export interface VariantEventCount {
  event: string;
  count: number;
}

/** Extract numeric event counters from a variant `metrics` bag, sorted
 *  by descending count for display. */
export function variantEventCounts(
  metrics: Record<string, unknown> | undefined,
): VariantEventCount[] {
  if (!metrics) return [];
  const out: VariantEventCount[] = [];
  for (const [event, v] of Object.entries(metrics)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ event, count: v });
    }
  }
  out.sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return out;
}

/** Roll variant metrics up across the experiment (event → total). */
export function experimentEventTotals(
  exp: OnsiteExperiment,
): VariantEventCount[] {
  const totals = new Map<string, number>();
  for (const v of exp.variants ?? []) {
    for (const { event, count } of variantEventCounts(v.metrics)) {
      totals.set(event, (totals.get(event) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
}

/* ---------- experiment variant editor (up to 7 variants) ------------- */

/** Klaviyo parity (ONS-02): an A/B experiment supports up to seven
 *  variants. The editor enforces the cap; the server is the validator
 *  of record. */
export const MAX_EXPERIMENT_VARIANTS = 7;

/** Editable projection of one OnsiteExperimentVariant row. `base` carries
 *  the wire fields the structured editor doesn't surface (id,
 *  form_snapshot, success_behavior, coupon_pool_id, metrics, …) so a save
 *  round-trips them verbatim — mirrors SpinRewardDraft. */
export interface VariantDraft {
  key: string;
  name: string;
  /** Weight in basis points, as typed (validated on build). */
  weightText: string;
  isControl: boolean;
  base: OnsiteExperimentVariant | null;
}

export function variantToDraft(v: OnsiteExperimentVariant): VariantDraft {
  return {
    key: v.key,
    name: v.name,
    weightText: String(v.traffic_weight_basis_points ?? 0),
    isControl: Boolean(v.is_control),
    base: v,
  };
}

export function newVariantDraft(): VariantDraft {
  return { key: "", name: "", weightText: "", isControl: false, base: null };
}

/** Weight audit over the variant rows: unparsable weights count as 0 so
 *  the total reflects what would be saved. Same {totalBp, complete}
 *  contract as spinDraftWeightSummary (10000bp = 100%). */
export function variantDraftWeightSummary(
  drafts: ReadonlyArray<VariantDraft>,
): { totalBp: number; complete: boolean } {
  const totalBp = drafts.reduce((n, d) => {
    const w = Number(d.weightText.trim());
    return n + (Number.isInteger(w) && w >= 0 ? w : 0);
  }, 0);
  return { totalBp, complete: totalBp === 10_000 };
}

export type VariantsBuildResult =
  | { ok: true; items: OnsiteExperimentVariant[] }
  | { ok: false; index: number; error: string };

/**
 * Assemble experiment.variants from the editor rows (mirrors
 * buildSpinRewardsInput): first offending row index on failure; the
 * 7-variant cap is enforced by the editor and the ≠100% balance is a
 * non-blocking audit (the server validates of record). Untouched wire
 * fields round-trip via `base`.
 */
export function buildVariantsInput(
  drafts: ReadonlyArray<VariantDraft>,
): VariantsBuildResult {
  const seen = new Set<string>();
  const items: OnsiteExperimentVariant[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const key = d.key.trim();
    if (!key) {
      return { ok: false, index: i, error: "Variant key is required (e.g. control)." };
    }
    if (seen.has(key)) {
      return { ok: false, index: i, error: `Duplicate variant key "${key}".` };
    }
    seen.add(key);
    if (!d.name.trim()) {
      return { ok: false, index: i, error: "Variant name is required." };
    }
    const weight = Number(d.weightText.trim());
    if (!Number.isInteger(weight) || weight < 0) {
      return {
        ok: false,
        index: i,
        error: "Weight must be a whole number of basis points (10000 = 100%).",
      };
    }
    const item: OnsiteExperimentVariant = {
      ...(d.base ?? {}),
      key,
      name: d.name.trim(),
      traffic_weight_basis_points: weight,
    };
    if (d.isControl) item.is_control = true;
    else delete item.is_control;
    items.push(item);
  }
  return { ok: true, items };
}

/* ---------- targeting rule groups ------------------------------------- */

/**
 * The JSON-edited rule groups on OnsiteTargetingRules, in wire order.
 * `compiled` is intentionally excluded — it's a server-derived
 * artifact, read-only.
 */
export const TARGETING_RULE_GROUPS: ReadonlyArray<{
  key: keyof OnsiteTargetingRules & string;
  label: string;
  hint: string;
}> = [
  { key: "trigger", label: "Trigger", hint: "When the form appears (exit intent, scroll depth, delay…)." },
  { key: "frequency", label: "Frequency", hint: "How often a visitor can see it (once per session, cooldown…)." },
  { key: "audience", label: "Audience", hint: "Subscriber/visitor segments the form targets." },
  { key: "url_rules", label: "URL rules", hint: "Path / query matching for the pages it renders on." },
  { key: "utm_rules", label: "UTM rules", hint: "Campaign-source gating from UTM parameters." },
  { key: "cart_rules", label: "Cart rules", hint: "Commerce cart-state conditions (value, item count…)." },
  { key: "geo_rules", label: "Geo rules", hint: "Country / region targeting." },
  { key: "device_rules", label: "Device rules", hint: "Desktop vs mobile vs tablet gating." },
  { key: "visitor_state_rules", label: "Visitor state", hint: "New vs returning vs subscribed visitors." },
  { key: "custom_trigger_rules", label: "Custom triggers", hint: "Site-defined JS trigger events." },
];

export type JsonParseResult =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

/**
 * Parse a rule-group JSON editor's text. Empty / whitespace-only text
 * means "no rules for this group" (undefined — omitted from the PUT
 * body). Non-object JSON (arrays, scalars) is rejected because the
 * wire shape for every group is an object.
 */
export function parseRuleGroup(text: string): JsonParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "Must be a JSON object (e.g. {\"...\": ...})." };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid JSON.",
    };
  }
}

/** Pretty-print a rule group for the editor; empty string when unset. */
export function ruleGroupText(v: Record<string, unknown> | undefined): string {
  if (!v || Object.keys(v).length === 0) return "";
  return JSON.stringify(v, null, 2);
}

/**
 * Assemble the PUT body for targeting from the per-group editor texts.
 * Returns the first parse error keyed by group so the panel can focus
 * the offending editor instead of sending garbage to validate.
 */
export function buildTargetingInput(
  base: { status: string; priority: number },
  groupTexts: Record<string, string>,
): { ok: true; input: OnsiteTargetingRules } | { ok: false; group: string; error: string } {
  const input: OnsiteTargetingRules = {
    status: base.status,
    priority: base.priority,
  };
  for (const g of TARGETING_RULE_GROUPS) {
    const res = parseRuleGroup(groupTexts[g.key] ?? "");
    if (!res.ok) return { ok: false, group: g.key, error: res.error };
    if (res.value !== undefined) {
      (input as Record<string, unknown>)[g.key] = res.value;
    }
  }
  return { ok: true, input };
}
