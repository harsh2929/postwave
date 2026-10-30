// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, unit-tested chart scale + path math shared by the analytics line charts
// (ANL-012). Kept dependency-free and deterministic so SSR and client render
// identical SVG (no hydration drift) and the axis/tick logic stays testable.

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * A "nice" axis domain covering [dataMin, dataMax] with roughly `tickCount`
 * evenly-spaced, rounded ticks. Guards degenerate inputs (flat/all-zero series)
 * so the domain always has a positive span.
 */
export function niceScale(dataMin: number, dataMax: number, tickCount = 4): Scale {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 0;
  if (hi < lo) [lo, hi] = [hi, lo];

  if (lo === hi) {
    // Flat series: open up a symmetric band so the line isn't glued to an edge.
    if (lo === 0) {
      hi = 1;
    } else {
      const pad = Math.abs(lo) * 0.5 || 1;
      lo -= pad;
      hi += pad;
    }
  }

  const span = hi - lo;
  const steps = Math.max(1, tickCount - 1);
  const rawStep = span / steps;
  const step = niceNum(rawStep, true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Accumulate with a small epsilon so float drift doesn't drop the last tick.
  for (let v = niceMin; v <= niceMax + step * 1e-9; v += step) {
    ticks.push(roundTo(v, step));
  }
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, ticks };
}

/** Round `value` to a "nice" 1/2/5 * 10^k number (round=true) or its ceiling. */
function niceNum(value: number, round: boolean): number {
  const safe = value > 0 ? value : 1;
  const exp = Math.floor(Math.log10(safe));
  const frac = safe / 10 ** exp;
  let niceFrac: number;
  if (round) {
    niceFrac = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return niceFrac * 10 ** exp;
}

/** Round to a sensible precision derived from the step, avoiding float fuzz. */
function roundTo(value: number, step: number): number {
  const decimals = step < 1 ? Math.min(6, Math.ceil(-Math.log10(step)) + 1) : 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface PathBox {
  width: number;
  height: number;
  /** Vertical inset (px) so line caps/circles never clip. */
  pad?: number;
  /** Explicit y-domain (e.g. from niceScale) so a line aligns to axis ticks. */
  domain?: { min: number; max: number };
}

interface Coord {
  x: number;
  y: number;
}

function coords(values: readonly number[], box: PathBox): Coord[] {
  const points = values.filter((n) => Number.isFinite(n));
  if (points.length < 2) return [];
  const { width, height } = box;
  const pad = box.pad ?? 0;
  const max = box.domain ? box.domain.max : Math.max(...points);
  const min = box.domain ? box.domain.min : Math.min(...points);
  const span = max - min;
  const stepX = width / (points.length - 1);
  const usableH = height - pad * 2;
  return points.map((value, i) => ({
    x: i * stepX,
    // A flat series (span 0) centers on the mid-line rather than gluing to the
    // baseline, so an unchanging metric still reads as a level trend.
    y: span === 0 ? pad + usableH / 2 : pad + (1 - (value - min) / span) * usableH,
  }));
}

/** SVG polyline `d` for a series scaled into the box (y-inverted). */
export function buildLinePath(values: readonly number[], box: PathBox): string {
  const cs = coords(values, box);
  if (cs.length === 0) return "";
  return cs
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
}

/** SVG `d` for the same series as a filled area closed to the baseline. */
export function buildAreaPath(values: readonly number[], box: PathBox): string {
  const cs = coords(values, box);
  if (cs.length === 0) return "";
  const line = cs
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const last = cs[cs.length - 1]!;
  const first = cs[0]!;
  return `${line} L${last.x.toFixed(1)},${box.height} L${first.x.toFixed(1)},${box.height} Z`;
}
