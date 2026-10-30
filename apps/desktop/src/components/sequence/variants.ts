/**
 * variants.ts — pure logic for the email-step A/B variants editor.
 *
 * Mirrors the server contract in
 * services/voice/internal/generation/variants.go (ValidateVariants):
 *   - 2..4 variants per step,
 *   - unique non-empty keys (≤ 32 chars, case-insensitive uniqueness),
 *   - each arm needs a subject and a body (or body_html),
 *   - weights are basis points (1 bp = 0.01%), each ≥ 1,
 *   - weights MUST sum to exactly 10000 bp (= 100%).
 *
 * The editor works on percent strings (what the inputs hold) via
 * {@link VariantDraft}; conversion to the wire shape happens at save
 * time. Assignment is a pure deterministic hash server-side — same
 * subscriber always resolves to the same arm. Per-arm open/click stats
 * DO exist server-side now (analytics FunnelStep.variants, keyed off the
 * stamped variant_key); this editor module just doesn't render them
 * inline yet, so it exposes honest-copy constants rather than fabricated
 * metrics (see {@link VARIANT_STATS_HONESTY}).
 */

import type { SequenceEmailVariant } from "../../lib/api-client";

export const VARIANT_MIN = 2;
export const VARIANT_MAX = 4;
export const VARIANT_WEIGHT_TOTAL_BP = 10000;
export const VARIANT_KEY_MAX_CHARS = 32;

/** Auto-assigned arm keys, in order. The editor never lets the user
 *  type keys — they're positional (A/B/C/D) like the server examples. */
export const VARIANT_KEYS = ["A", "B", "C", "D"] as const;

/**
 * Honest-UI copy for the variants editor.
 *
 * D07-templates-seq-automations#12: the earlier copy claimed per-variant
 * stats "aren't available yet — delivery events don't record which arm".
 * That is no longer true: the analytics funnel now returns a per-arm
 * breakdown (FunnelStep.variants) when producers stamp
 * sequence_funnel_events.variant_key. This editor module simply doesn't
 * render that breakdown inline yet (the wiring lives in StepNode /
 * StepEditor + a SequenceFunnelStep.variants type field). So state only
 * what's true here — the inline editor doesn't surface per-arm stats —
 * without the false mechanism claim.
 */
export const VARIANT_STATS_HONESTY =
  "Per-variant open/click stats aren't shown in this editor yet — see the " +
  "sequence funnel report for per-arm results. Assignment itself is " +
  "deterministic: the same subscriber always gets the same variant of " +
  "this step.";

/** Editor-side draft of one arm. `weight_pct` is the raw input string
 *  ("50", "33.34", …) so the user can type freely; parse on save. */
export interface VariantDraft {
  key: string;
  subject: string;
  body: string;
  /** Carried through untouched — the editor only edits plain body. */
  body_html?: string;
  weight_pct: string;
}

/** 5000 → "50", 3334 → "33.34". Trims trailing zeros so the input
 *  doesn't show "50.00". */
export function bpToPctString(bp: number): string {
  const s = (bp / 100).toFixed(2);
  return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

/** "33.34" → 3334. Returns null for blank / non-numeric input. The
 *  result is rounded to the nearest basis point (the server's unit). */
export function pctStringToBp(pct: string): number | null {
  const trimmed = pct.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Split 10000 bp across `n` arms as evenly as possible; the remainder
 * goes to the first arms so the sum is always exactly 10000.
 * evenWeightsBp(3) → [3334, 3333, 3333].
 */
export function evenWeightsBp(n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(VARIANT_WEIGHT_TOTAL_BP / n);
  const remainder = VARIANT_WEIGHT_TOTAL_BP - base * n;
  return Array.from({ length: n }, (_, i) => (i < remainder ? base + 1 : base));
}

/** Seed a fresh 2-arm split from the step's current content (arm A is
 *  the current email; arm B starts as a copy for the user to edit). */
export function seedVariantDrafts(
  subject: string,
  body: string,
  bodyHtml?: string,
): VariantDraft[] {
  const weights = evenWeightsBp(2);
  return [
    {
      key: VARIANT_KEYS[0],
      subject,
      body,
      body_html: bodyHtml,
      weight_pct: bpToPctString(weights[0]),
    },
    {
      key: VARIANT_KEYS[1],
      subject,
      body,
      body_html: bodyHtml,
      weight_pct: bpToPctString(weights[1]),
    },
  ];
}

/** Re-assign positional keys (A, B, C, D) after an add/remove. */
function relabel(drafts: VariantDraft[]): VariantDraft[] {
  return drafts.map((d, i) => ({ ...d, key: VARIANT_KEYS[i] ?? `V${i + 1}` }));
}

/** Reset every arm to an even split. Used after add/remove so the
 *  weights always re-sum to 100% without manual fixing. */
function reEven(drafts: VariantDraft[]): VariantDraft[] {
  const weights = evenWeightsBp(drafts.length);
  return drafts.map((d, i) => ({ ...d, weight_pct: bpToPctString(weights[i]) }));
}

/** Append a new empty arm (no-op at the 4-arm cap). Keys are relabelled
 *  positionally and weights are redistributed evenly. */
export function addVariantDraft(drafts: VariantDraft[]): VariantDraft[] {
  if (drafts.length >= VARIANT_MAX) return drafts;
  const next = [...drafts, { key: "", subject: "", body: "", weight_pct: "" }];
  return reEven(relabel(next));
}

/** Remove the arm at `index` (no-op below the 2-arm floor). Keys are
 *  relabelled positionally and weights are redistributed evenly. */
export function removeVariantDraft(
  drafts: VariantDraft[],
  index: number,
): VariantDraft[] {
  if (drafts.length <= VARIANT_MIN) return drafts;
  if (index < 0 || index >= drafts.length) return drafts;
  const next = drafts.filter((_, i) => i !== index);
  return reEven(relabel(next));
}

/** Sum of all arms in basis points, or null when any weight doesn't
 *  parse. Drives the live "Weights total N%" indicator. */
export function weightsSumBp(drafts: VariantDraft[]): number | null {
  let sum = 0;
  for (const d of drafts) {
    const bp = pctStringToBp(d.weight_pct);
    if (bp == null) return null;
    sum += bp;
  }
  return sum;
}

/**
 * Validate the editor drafts against the server's rules. Returns the
 * first human-readable error, or null when the split is persistable.
 */
export function validateVariantDrafts(drafts: VariantDraft[]): string | null {
  if (drafts.length < VARIANT_MIN) {
    return `An A/B split needs at least ${VARIANT_MIN} variants.`;
  }
  if (drafts.length > VARIANT_MAX) {
    return `At most ${VARIANT_MAX} variants are allowed.`;
  }
  for (const d of drafts) {
    const label = d.key || "?";
    if (!d.subject.trim()) {
      return `Variant ${label}: subject is required.`;
    }
    if (!d.body.trim() && !(d.body_html ?? "").trim()) {
      return `Variant ${label}: body is required.`;
    }
    const bp = pctStringToBp(d.weight_pct);
    if (bp == null) {
      return `Variant ${label}: weight must be a number.`;
    }
    if (bp < 1) {
      return `Variant ${label}: weight must be at least 0.01%.`;
    }
  }
  const sum = weightsSumBp(drafts);
  if (sum !== VARIANT_WEIGHT_TOTAL_BP) {
    return `Variant weights must total 100% (currently ${bpToPctString(sum ?? 0)}%).`;
  }
  return null;
}

/** Convert validated drafts to the wire shape. Returns null when
 *  {@link validateVariantDrafts} would reject them. */
export function draftsToVariants(
  drafts: VariantDraft[],
): SequenceEmailVariant[] | null {
  if (validateVariantDrafts(drafts) != null) return null;
  return drafts.map((d) => {
    const out: SequenceEmailVariant = {
      key: d.key,
      subject: d.subject.trim(),
      body: d.body,
      // The validator guarantees this parses (it returned null above
      // otherwise); ?? 0 is just the type-level fallback.
      weight_bp: pctStringToBp(d.weight_pct) ?? 0,
    };
    const html = (d.body_html ?? "").trim();
    if (html) out.body_html = d.body_html;
    return out;
  });
}

/** Hydrate editor drafts from stored variants. */
export function variantsToDrafts(
  variants: SequenceEmailVariant[],
): VariantDraft[] {
  return variants.map((v) => ({
    key: v.key,
    subject: v.subject,
    body: v.body,
    body_html: v.body_html,
    weight_pct: bpToPctString(v.weight_bp),
  }));
}

/**
 * Mirror of the server's ValidateVariants for already-stored variants
 * (services/voice/internal/generation/variants.go). Used by the canvas
 * persist gate so a step carrying a malformed split is never PATCHed —
 * the server would 400 the whole steps array otherwise. An empty /
 * absent list is valid ("no A/B test on this step").
 */
export function variantsAreValid(
  variants: SequenceEmailVariant[] | undefined,
): boolean {
  if (!variants || variants.length === 0) return true;
  if (variants.length < VARIANT_MIN || variants.length > VARIANT_MAX) {
    return false;
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const v of variants) {
    const key = v.key.trim();
    if (!key || key.length > VARIANT_KEY_MAX_CHARS) return false;
    const lower = key.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    if (!v.subject.trim()) return false;
    if (!v.body.trim() && !(v.body_html ?? "").trim()) return false;
    if (!Number.isInteger(v.weight_bp) || v.weight_bp < 1) return false;
    sum += v.weight_bp;
  }
  return sum === VARIANT_WEIGHT_TOTAL_BP;
}
