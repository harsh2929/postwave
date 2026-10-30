/**
 * overlap-helpers — pure geometry + formatting for the segment overlap
 * visualizer (R11: GET /api/v1/segments/overlap?a=&b=).
 *
 * The wire gives `{a, b, a_count, b_count, intersection, jaccard}`.
 * We render a proportional two-circle (Euler) diagram: each circle's
 * AREA is proportional to its member count, and the circles are pulled
 * together until the lens (intersection) area is proportional to the
 * intersection count — solved by bisection on the centre distance
 * using the exact circle-circle lens-area formula.
 */

export interface OverlapCircle {
  cx: number;
  cy: number;
  r: number;
}

export interface OverlapLayout {
  a: OverlapCircle;
  b: OverlapCircle;
  width: number;
  height: number;
  /** True when one or both sets are empty — render the empty note. */
  degenerate: boolean;
}

/** Area of the lens shared by two circles with radii r1, r2 at centre
 * distance d. Standard formula; exported for tests. */
export function lensArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  const rMin = Math.min(r1, r2);
  const rMax = Math.max(r1, r2);
  if (d <= rMax - rMin) return Math.PI * rMin * rMin; // containment
  const d1 = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const d2 = d - d1;
  const seg = (r: number, x: number): number =>
    r * r * Math.acos(Math.min(1, Math.max(-1, x / r))) -
    x * Math.sqrt(Math.max(0, r * r - x * x));
  return seg(r1, d1) + seg(r2, d2);
}

/**
 * Solve the centre distance so the lens area hits `target` (same area
 * units as the circles). Monotonic decreasing in d → bisection.
 */
export function solveDistance(
  r1: number,
  r2: number,
  target: number,
): number {
  const lo0 = Math.abs(r1 - r2);
  const hi0 = r1 + r2;
  const maxLens = lensArea(r1, r2, lo0);
  if (target <= 0) return hi0;
  if (target >= maxLens) return lo0;
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lensArea(r1, r2, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Build the two-circle layout for an SVG of `width`×`height`.
 * Radii scale with sqrt(count) (area ∝ count); the pair is centred
 * horizontally and vertically. Zero-member sets get a degenerate
 * layout — the caller should render the counts as text instead of a
 * misleading dot.
 */
export function overlapLayout(
  aCount: number,
  bCount: number,
  intersection: number,
  width = 320,
  height = 160,
): OverlapLayout {
  const safeA = Math.max(0, aCount);
  const safeB = Math.max(0, bCount);
  if (safeA === 0 || safeB === 0) {
    const r = Math.min(width, height) / 4;
    return {
      a: { cx: width / 3, cy: height / 2, r: safeA > 0 ? r : 0 },
      b: { cx: (2 * width) / 3, cy: height / 2, r: safeB > 0 ? r : 0 },
      width,
      height,
      degenerate: true,
    };
  }
  // Clamp the intersection to what's mathematically possible — the
  // server should never exceed min(a,b) but we don't trust blindly.
  const inter = Math.min(intersection, safeA, safeB);

  // Unit radii, then scale to fit the viewport with padding.
  const uA = Math.sqrt(safeA);
  const uB = Math.sqrt(safeB);
  const uD = solveDistance(uA, uB, Math.PI * Math.max(0, inter));
  // Disjoint sets: leave a visible gap instead of kissing circles.
  const gap = inter <= 0 ? Math.min(uA, uB) * 0.25 : 0;
  const span = uD + uA + uB + gap;
  const pad = 8;
  const scale = Math.min(
    (width - pad * 2) / span,
    (height - pad * 2) / (2 * Math.max(uA, uB)),
  );
  const rA = uA * scale;
  const rB = uB * scale;
  const d = (uD + gap) * scale;
  const totalW = d + rA + rB;
  const left = (width - totalW) / 2 + rA;
  const cy = height / 2;
  return {
    a: { cx: left, cy, r: rA },
    b: { cx: left + d, cy, r: rB },
    width,
    height,
    degenerate: false,
  };
}

/** Jaccard ∈ [0,1] → "37.5%" (one decimal, trailing .0 stripped). */
export function fmtJaccard(j: number): string {
  if (!Number.isFinite(j)) return "—";
  const pct = (Math.min(1, Math.max(0, j)) * 100).toFixed(1);
  return `${pct.endsWith(".0") ? pct.slice(0, -2) : pct}%`;
}

/** Honest one-liner under the diagram. */
export function overlapSummary(
  aCount: number,
  bCount: number,
  intersection: number,
): string {
  if (aCount === 0 && bCount === 0) {
    return "Both segments are empty — nothing to compare.";
  }
  if (intersection === 0) {
    return "No subscribers in common.";
  }
  return `${intersection.toLocaleString()} subscriber${intersection === 1 ? "" : "s"} in both segments.`;
}
