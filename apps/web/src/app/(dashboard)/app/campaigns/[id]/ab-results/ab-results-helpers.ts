// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers for the A/B statistical report. Keeps the label-mapping logic
// (backend comparison keys → human "B vs A" labels) unit-testable and out of
// the render path. CAMP-051.

import type { ABResultsVariant } from "@/lib/ab-results-api";

/**
 * Map a backend comparison key (e.g. "1_vs_0", "B_vs_A", "var_b:var_a") to a
 * human label describing the variant pairing, using the variants array to
 * resolve labels. Falls back to the raw key when it can't be parsed so a novel
 * key format is never hidden.
 *
 * The backend keys the bayesian/frequentist maps by a challenger-vs-control
 * comparison id; formats vary, so we extract the two operands defensively.
 */
export function comparisonLabel(
  key: string,
  variants: readonly ABResultsVariant[],
): string {
  const [left, right] = splitComparison(key);
  if (left === null || right === null) return key;

  const leftLabel = resolveOperand(left, variants);
  const rightLabel = resolveOperand(right, variants);
  if (!leftLabel || !rightLabel) return key;

  const rightIsControl = variants.some(
    (v) => matchesOperand(v, right) && v.is_control,
  );
  return `${leftLabel} vs ${rightLabel}${rightIsControl ? " (control)" : ""}`;
}

/** Split a comparison key into its two operands. Handles "A_vs_B", "A vs B",
 *  "A:B" and returns [null,null] when there aren't exactly two operands. */
function splitComparison(key: string): [string | null, string | null] {
  const parts = key
    .split(/_vs_|\s+vs\s+|:|__/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 2) return [parts[0], parts[1]];
  return [null, null];
}

function matchesOperand(v: ABResultsVariant, operand: string): boolean {
  const idx = Number(operand);
  if (Number.isInteger(idx) && v.variant_index === idx) return true;
  if (v.id && v.id === operand) return true;
  if (
    v.variant_label &&
    v.variant_label.toLowerCase() === operand.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function resolveOperand(
  operand: string,
  variants: readonly ABResultsVariant[],
): string | null {
  const match = variants.find((v) => matchesOperand(v, operand));
  if (match) {
    return match.variant_label ?? `Variant ${match.variant_index + 1}`;
  }
  // Numeric operand with no matching variant: still render a stable label.
  const idx = Number(operand);
  if (Number.isInteger(idx)) return `Variant ${idx + 1}`;
  return null;
}
