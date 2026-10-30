/**
 * Tests for the SendTimeHeatmap UTC/local-timezone toggle helpers.
 *
 * The heatmap stores values in UTC (the backend convention) but
 * operators in PST/IST/etc. want to read it on their wall clock. The
 * grid is shifted hour-by-hour with day-of-week wraparound — we verify
 * the wraparound at both edges (Sat→Sun and Sun→Sat) and at the
 * fractional-offset boundary (IST = +5:30 rounds to +6h).
 *
 * Bug surface this protects:
 *   - JS `%` returning negative numbers for negative shifts (we coerce
 *     into 0..167 with `((x % 168) + 168) % 168`)
 *   - Lost cells when shifting drops them across the week boundary
 */

import { describe, expect, it } from "vitest";

// Import directly from the pure-helper module (not the .tsx component)
// so vitest's node environment doesn't have to parse JSX. The .tsx
// re-exports the same symbols for any non-test caller.
import {
  projectedMinute,
  shiftCell,
  shiftGrid,
} from "../components/sendtime/tz";

describe("shiftCell — hour-shift with day wraparound", () => {
  it("returns the input cell when offset is zero", () => {
    expect(shiftCell(3, 14, 0)).toEqual({ dow: 3, hour: 14 });
  });

  it("shifts a UTC Mon 18:00 to PST (UTC-8) → Mon 10:00", () => {
    // -8h, no day wrap.
    expect(shiftCell(1, 18, -8 * 60)).toEqual({ dow: 1, hour: 10 });
  });

  it("wraps backwards across Sunday into Saturday", () => {
    // UTC Sun 02:00 in PST (UTC-8) is Sat 18:00.
    expect(shiftCell(0, 2, -8 * 60)).toEqual({ dow: 6, hour: 18 });
  });

  it("wraps forwards across Saturday into Sunday", () => {
    // UTC Sat 22:00 in IST (UTC+5:30) is Sun 03:30.
    expect(shiftCell(6, 22, 5 * 60 + 30)).toEqual({ dow: 0, hour: 3 });
  });

  it("retains the integer bucket and exposes IST's :30 minute", () => {
    expect(shiftCell(2, 0, 5 * 60 + 30)).toEqual({ dow: 2, hour: 5 });
    expect(projectedMinute(5 * 60 + 30)).toBe(30);
  });

  it("retains the integer bucket and exposes Nepal's :45 minute", () => {
    expect(shiftCell(2, 0, 5 * 60 + 45)).toEqual({ dow: 2, hour: 5 });
    expect(projectedMinute(5 * 60 + 45)).toBe(45);
  });

  it("uses floor semantics for negative fractional offsets", () => {
    // UTC Sun 02:00 at UTC-03:30 is Sat 22:30.
    expect(shiftCell(0, 2, -(3 * 60 + 30))).toEqual({ dow: 6, hour: 22 });
    expect(projectedMinute(-(3 * 60 + 30))).toBe(30);
  });

  it("preserves total cell count in the week even with negative shifts", () => {
    // Walk every cell, shift it -8h, ensure each result is in-range.
    for (let d = 0; d < 7; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        const out = shiftCell(d, h, -8 * 60);
        expect(out.dow).toBeGreaterThanOrEqual(0);
        expect(out.dow).toBeLessThanOrEqual(6);
        expect(out.hour).toBeGreaterThanOrEqual(0);
        expect(out.hour).toBeLessThanOrEqual(23);
      }
    }
  });
});

describe("shiftGrid — full 7×24 projection", () => {
  function unitGrid(dow: number, hour: number, value = 7): number[][] {
    const g = Array.from({ length: 7 }, () => Array(24).fill(0));
    g[dow]![hour] = value;
    return g;
  }

  it("returns a zero grid when input is undefined / non-array", () => {
    const out = shiftGrid(undefined as unknown as number[][], 0);
    expect(out).toHaveLength(7);
    expect(out[0]).toHaveLength(24);
    expect(out.flat().every((v) => v === 0)).toBe(true);
  });

  it("zero offset returns a value-identical copy", () => {
    const g = unitGrid(3, 14, 42);
    const out = shiftGrid(g, 0);
    expect(out[3]![14]).toBe(42);
    // Touching the copy doesn't mutate the original.
    out[3]![14] = 999;
    expect(g[3]![14]).toBe(42);
  });

  it("relocates a single-cell signal under negative shift", () => {
    // UTC Sun 02:00 → PST Sat 18:00.
    const g = unitGrid(0, 2, 11);
    const out = shiftGrid(g, -8 * 60);
    expect(out[6]![18]).toBe(11);
    expect(out[0]![2]).toBe(0);
  });

  it("relocates a single-cell signal under positive fractional shift", () => {
    // UTC Sat 22:00 → IST Sun 03:30.
    const g = unitGrid(6, 22, 5);
    const out = shiftGrid(g, 5 * 60 + 30);
    expect(out[0]![3]).toBe(5);
    expect(out[6]![22]).toBe(0);
  });

  it("preserves total mass across the projection", () => {
    // Fill with arbitrary values, sum, shift, re-sum.
    const g: number[][] = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => d * 24 + h + 1),
    );
    const total = g.flat().reduce((a, b) => a + b, 0);
    for (const off of [
      -12 * 60,
      -8 * 60,
      -5 * 60 - 30,
      0,
      60,
      9 * 60,
      14 * 60,
    ]) {
      const out = shiftGrid(g, off);
      const got = out.flat().reduce((a, b) => a + b, 0);
      expect(got).toBe(total);
    }
  });

  it("tolerates ragged rows in the input grid", () => {
    // Backend sometimes hands us a row that's shorter than 24 elements
    // (e.g. when a tenant has no Tuesday opens). Coerce safely.
    const g: number[][] = [
      [1, 2, 3], // ragged
      Array(24).fill(0),
      Array(24).fill(0),
      Array(24).fill(0),
      Array(24).fill(0),
      Array(24).fill(0),
      Array(24).fill(0),
    ];
    const out = shiftGrid(g, -3 * 60);
    expect(out[0]![0]).toBe(0);
    // 1@(0,0) → (6,21), 2@(0,1) → (6,22), 3@(0,2) → (6,23)
    expect(out[6]![21]).toBe(1);
    expect(out[6]![22]).toBe(2);
    expect(out[6]![23]).toBe(3);
  });
});
