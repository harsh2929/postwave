/**
 * variants-helpers — pure logic behind the per-form Variants panel
 * (form_variants). JSX-free for the node vitest suite (same pattern as
 * growth-helpers.ts in this directory).
 *
 * Wire notes (apps/api/internal/form_variants — see ROADMAP-WRAPPERS
 * T1): this package alone is camelCase on the wire (formId,
 * displayConfig, trafficPct, …). conversionRate and the promotion
 * winner/runner-up rates are 0..1 fractions. trafficPct is a plain
 * percentage (not basis points). displayConfig is opaque jsonb — the
 * panel edits it as raw JSON, mirroring the Growth panel's rule-group
 * editors.
 */

import type {
  FormVariant,
  FormVariantCreateInput,
  FormVariantPatch,
} from "../../lib/api-client";

/* ---------- formatting ------------------------------------------------- */

/** 0..1 fraction → "12.5%" (one decimal, trailing zeros trimmed).
 *  Non-numbers → em-dash. */
export function fmtFraction(rate: number | undefined | null): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "—";
  const pct = rate * 100;
  if (Number.isInteger(pct)) return `${pct}%`;
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/* ---------- traffic split audit ---------------------------------------- */

/**
 * Sum of trafficPct across the variants that still receive traffic
 * (paused rows are excluded — the server stops serving them). A split
 * that doesn't total 100 means the displayed odds don't match the
 * serve weights, so the panel surfaces the total without blocking —
 * the server is the validator of record.
 */
export function trafficSplitSummary(
  variants: ReadonlyArray<Pick<FormVariant, "trafficPct" | "status">>,
): { totalPct: number; balanced: boolean; activeCount: number } {
  const live = variants.filter(
    (v) => (v.status ?? "active").toLowerCase() !== "paused",
  );
  const totalPct = live.reduce(
    (n, v) => n + (typeof v.trafficPct === "number" ? v.trafficPct : 0),
    0,
  );
  return { totalPct, balanced: totalPct === 100, activeCount: live.length };
}

/* ---------- significance ------------------------------------------------ */

/**
 * Two-sided normal-approximation read of a variant's stored z-score
 * (the server computes lastZScore from its own counters; we only
 * interpret it). Thresholds: 2.576 → 99%, 1.96 → 95%, 1.645 → 90%.
 */
export function significanceLabel(z: number | undefined | null): {
  label: string;
  significant: boolean;
} {
  if (typeof z !== "number" || !Number.isFinite(z) || z === 0) {
    return { label: "no significance data", significant: false };
  }
  const a = Math.abs(z);
  if (a >= 2.576) return { label: "99% confidence", significant: true };
  if (a >= 1.96) return { label: "95% confidence", significant: true };
  if (a >= 1.645) return { label: "90% confidence", significant: false };
  return { label: "not significant yet", significant: false };
}

/**
 * Honest sample-size context line for the panel header. Uses the
 * form's hosted-page visits (FormSummary.visits30d — optional, older
 * API builds don't compute it) plus the variants' own impression
 * counters. Returns null when there is nothing real to say.
 */
export function sampleContextLine(
  visits30d: number | undefined,
  variants: ReadonlyArray<Pick<FormVariant, "impressions">>,
): string | null {
  const impressions = variants.reduce(
    (n, v) => n + (typeof v.impressions === "number" ? v.impressions : 0),
    0,
  );
  const parts: string[] = [];
  if (impressions > 0) {
    parts.push(`${impressions.toLocaleString()} variant impressions recorded`);
  }
  if (typeof visits30d === "number" && visits30d > 0) {
    parts.push(`${visits30d.toLocaleString()} hosted-page visits in 30d`);
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/* ---------- editor drafts ----------------------------------------------- */

/** Editable projection of a FormVariant. displayConfig is edited as
 *  raw JSON text (opaque jsonb on the wire). */
export interface VariantDraft {
  /** null → creating; the variant id → editing that row. */
  id: string | null;
  label: string;
  trafficPctText: string;
  displayConfigText: string;
}

export function newVariantDraft(): VariantDraft {
  return { id: null, label: "", trafficPctText: "", displayConfigText: "" };
}

export function variantToDraft(v: FormVariant): VariantDraft {
  return {
    id: v.id,
    label: v.label,
    trafficPctText: String(v.trafficPct ?? 0),
    displayConfigText:
      v.displayConfig && Object.keys(v.displayConfig).length > 0
        ? JSON.stringify(v.displayConfig, null, 2)
        : "",
  };
}

export type VariantBuildResult =
  | { ok: true; create: FormVariantCreateInput; patch: FormVariantPatch }
  | { ok: false; field: "label" | "trafficPct" | "displayConfig"; error: string };

/**
 * Validate + assemble the wire body from a draft. Empty displayConfig
 * text means `{}` (the create endpoint requires the field). The same
 * validated fields serve as a PATCH body when editing.
 */
export function buildVariantInput(d: VariantDraft): VariantBuildResult {
  const label = d.label.trim();
  if (!label) {
    return { ok: false, field: "label", error: "Label is required." };
  }
  const tText = d.trafficPctText.trim();
  let trafficPct: number | undefined;
  if (tText) {
    const n = Number(tText);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return {
        ok: false,
        field: "trafficPct",
        error: "Traffic must be a percentage between 0 and 100.",
      };
    }
    trafficPct = n;
  }
  let displayConfig: Record<string, unknown> = {};
  const cfgText = d.displayConfigText.trim();
  if (cfgText) {
    try {
      const parsed: unknown = JSON.parse(cfgText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          field: "displayConfig",
          error: "Display config must be a JSON object.",
        };
      }
      displayConfig = parsed as Record<string, unknown>;
    } catch (e) {
      return {
        ok: false,
        field: "displayConfig",
        error: `Display config JSON: ${e instanceof Error ? e.message : "invalid"}`,
      };
    }
  }
  const create: FormVariantCreateInput = { label, displayConfig };
  if (trafficPct !== undefined) create.trafficPct = trafficPct;
  const patch: FormVariantPatch = { label, displayConfig };
  if (trafficPct !== undefined) patch.trafficPct = trafficPct;
  return { ok: true, create, patch };
}

/* ---------- status ------------------------------------------------------ */

/** The only user-driven status switch the panel offers: active↔paused.
 *  "promoted" is server-assigned (auto-promotion) — never settable. */
export function toggledStatus(status: string | undefined): "active" | "paused" | null {
  const s = (status ?? "").toLowerCase();
  if (s === "active") return "paused";
  if (s === "paused") return "active";
  return null; // promoted (or unknown) — no toggle offered
}

/** Render-only weight map from an evaluate() decision, sorted by
 *  descending weight. Tolerates non-numeric junk. */
export function decisionWeightRows(
  weights: Record<string, number> | undefined,
): Array<{ id: string; weight: number }> {
  if (!weights) return [];
  return Object.entries(weights)
    .filter(([, w]) => typeof w === "number" && Number.isFinite(w))
    .map(([id, weight]) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}
