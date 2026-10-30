/**
 * Small statistics helpers for analytics surfaces. Right now this is just
 * the two-proportion z-test used by `CampaignCompareCard` to label the
 * "best" chip with a real confidence badge — but it sits in its own file
 * because (a) the math is easy to get wrong and we want one source of
 * truth, and (b) it keeps the component readable.
 *
 * No deps on purpose: this must be safe to import from any surface,
 * including future workers / SSR contexts where DOM/React are absent.
 */

/**
 * Standard normal cumulative distribution function — Φ(z).
 *
 * We don't depend on a stats library for one function. This is the
 * classic Abramowitz & Stegun 26.2.17 polynomial approximation (max
 * absolute error ~7.5e-8), which is plenty for "95% vs 99% vs NS"
 * decisions where the threshold lives at z ≈ 1.96 / 2.576.
 */
function normalCdf(z: number): number {
  // Constants from A&S 26.2.17.
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228; // 1/sqrt(2π)

  const az = Math.abs(z);
  // Saturate far tails — beyond |z|≈8 the float rounds anyway and we'd
  // just be computing exp(-32) noise.
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
 * Two-proportion z-test (pooled variance, two-sided).
 *
 * Returns the z-statistic and the two-sided p-value so callers can
 * threshold at any α they like. We pool the proportion to estimate
 * the common standard error — the standard textbook formulation:
 *
 *     p̂ = (x1 + x2) / (n1 + n2)
 *     SE = sqrt( p̂ (1 - p̂) (1/n1 + 1/n2) )
 *     z  = (p1 - p2) / SE
 *
 * Note: `p1` / `p2` are proportions in [0, 1]; callers that have
 * percentages (0–100) must divide first.
 *
 * Degenerate inputs (n ≤ 0, identical proportions with zero SE) return
 * { z: 0, p: 1, degenerate: true } rather than NaN — the UI treats
 * "degenerate" the same as "not significant" but can still warn.
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
  // Clamp proportions to [0, 1] — upstream APIs occasionally send tiny
  // negative rounding (-1e-9) or > 1 due to retro-corrections.
  const a = Math.min(1, Math.max(0, p1));
  const b = Math.min(1, Math.max(0, p2));
  const pooled = (a * n1 + b * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se === 0) {
    return { z: 0, p: 1, degenerate: true };
  }
  const z = (a - b) / se;
  // Two-sided: P(|Z| ≥ |z|) = 2 · (1 - Φ(|z|))
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p: pValue, degenerate: false };
}

/**
 * Confidence label for the "best" chip on a compare card.
 *
 * The four states map directly to UI badges:
 *   - "low_sample" — either side has < `minSample` recipients; we
 *      refuse to call a winner at all (the test would be too noisy to
 *      trust regardless of p-value).
 *   - "99"         — p < 0.01
 *   - "95"         — p < 0.05
 *   - "ns"         — not significant
 *
 * `minSample` defaults to 100, matching the acceptance criteria. That
 * threshold isn't statistically magic — it's a UX guard so we don't
 * flash a confidence badge for a list of 12.
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

/**
 * Pretty-print a p-value for tooltips. Tiny values collapse to
 * "< 0.001" so the tooltip stays readable.
 */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p < 0.001) return "< 0.001";
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(2);
}
