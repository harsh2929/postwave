// SPDX-License-Identifier: AGPL-3.0-only
//
// Small statistics helpers for analytics surfaces — a port of desktop
// lib/stats.ts. Today this is the two-proportion z-test the campaign compare
// card uses to say whether a column's "best" campaign is really ahead of the
// runner-up or just ahead on noise. It sits in its own file because the math
// is easy to get wrong and there should be one source of truth for it.
//
// No React, no DOM: safe to import from anywhere.

/**
 * Standard normal cumulative distribution function Φ(z), via the Abramowitz &
 * Stegun 26.2.17 polynomial (max absolute error ~7.5e-8) — plenty for
 * "99% vs 95% vs not significant" decisions whose thresholds sit at
 * z ≈ 2.576 / 1.96.
 */
export function normalCdf(z: number): number {
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228; // 1 / sqrt(2π)

  const az = Math.abs(z);
  // Beyond |z| ≈ 8 the float rounds anyway.
  if (az > 8) return z > 0 ? 1 : 0;

  const t = 1 / (1 + p * az);
  const phi = c * Math.exp((-az * az) / 2);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const tail = phi * poly;
  return z >= 0 ? 1 - tail : tail;
}

export interface ZTestResult {
  /** Test statistic. Positive when p1 > p2, negative when p1 < p2. */
  z: number;
  /** Two-sided p-value. */
  p: number;
  /** True when either sample is degenerate and the test can't run. */
  degenerate: boolean;
}

/**
 * Two-proportion z-test (pooled variance, two-sided):
 *
 *     p̂  = (x1 + x2) / (n1 + n2)
 *     SE = sqrt( p̂ (1 − p̂) (1/n1 + 1/n2) )
 *     z  = (p1 − p2) / SE
 *
 * `p1`/`p2` are proportions in [0, 1] — callers holding percentages divide
 * first. Degenerate inputs (n ≤ 0, non-finite values, zero standard error)
 * return { z: 0, p: 1, degenerate: true } rather than NaN.
 */
export function ztest(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): ZTestResult {
  if (
    !Number.isFinite(p1) ||
    !Number.isFinite(p2) ||
    !Number.isFinite(n1) ||
    !Number.isFinite(n2) ||
    n1 <= 0 ||
    n2 <= 0
  ) {
    return { z: 0, p: 1, degenerate: true };
  }
  // Clamp: upstream rates occasionally carry -1e-9 or >1 rounding.
  const a = Math.min(1, Math.max(0, p1));
  const b = Math.min(1, Math.max(0, p2));
  const pooled = (a * n1 + b * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se === 0) {
    return { z: 0, p: 1, degenerate: true };
  }
  const z = (a - b) / se;
  // Two-sided: P(|Z| ≥ |z|) = 2 · (1 − Φ(|z|))
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p: pValue, degenerate: false };
}

/**
 * Confidence label for a compare column's leader:
 *   - "low_sample" — either side has fewer than `minSample` recipients; no
 *     winner is called at all, whatever the p-value says;
 *   - "99"         — p < 0.01
 *   - "95"         — p < 0.05
 *   - "ns"         — not significant (or a degenerate test).
 * The 100-recipient floor is a UX guard, not statistical magic.
 */
export type ConfidenceLabel = "99" | "95" | "ns" | "low_sample";

export function confidenceLabel(
  result: ZTestResult,
  n1: number,
  n2: number,
  minSample = 100,
): ConfidenceLabel {
  if (n1 < minSample || n2 < minSample) return "low_sample";
  if (result.degenerate) return "ns";
  if (result.p < 0.01) return "99";
  if (result.p < 0.05) return "95";
  return "ns";
}

/** A p-value for tooltips; tiny values collapse to "< 0.001". */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p < 0.001) return "< 0.001";
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(2);
}
