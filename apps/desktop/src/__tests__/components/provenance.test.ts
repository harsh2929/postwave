// Tests for the honest-provenance primitives in
// src/components/common/Provenance.tsx.
//
// The desktop vitest suite runs in the `node` environment with no jsdom
// and no JSX transform for test files (every other component test is a
// pure-logic .test.ts). So we render with React.createElement +
// react-dom/server's renderToStaticMarkup — both work in plain node —
// and assert on the static markup. The contract under test is HONESTY:
// edge values (n > m, n = 0, interval vs no interval) must never produce
// a misleading string.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComputedFrom,
  ConfidenceNote,
  EstimateBadge,
  SampleSize,
} from "../../components/common/Provenance";

/** Render a component to static HTML; null components render to "". */
function html(
  Comp: (props: never) => unknown,
  props: Record<string, unknown> = {},
): string {
  // createElement's typing is permissive enough here; the components are
  // plain function components returning ReactElement | null.
  const node = createElement(Comp as never, props as never);
  return renderToStaticMarkup(node);
}

describe("EstimateBadge", () => {
  it("renders the default Estimate chip with a projection tooltip", () => {
    const out = html(EstimateBadge);
    expect(out).toContain("Estimate");
    expect(out).toContain("not an exact figure");
    expect(out).toContain('class="badge"');
  });

  it("honours a custom label and stays accessible", () => {
    const out = html(EstimateBadge, { label: "Projection" });
    expect(out).toContain("Projection");
    expect(out).toContain("aria-label");
  });
});

describe("ComputedFrom", () => {
  it("renders 'computed from n of m' for a real slice", () => {
    const out = html(ComputedFrom, { n: 500, m: 12345, unit: "subscribers" });
    expect(out).toContain("computed from 500 of 12,345 subscribers");
  });

  it("says 'all' when the full population is covered (n === m)", () => {
    const out = html(ComputedFrom, { n: 50, m: 50, unit: "campaigns" });
    expect(out).toContain("computed from all 50 campaigns");
    expect(out).not.toContain(" of ");
  });

  it("NEVER overstates: n > m is clamped to the population (says all)", () => {
    // Stale/raced counts must not produce "computed from 80 of 50".
    const out = html(ComputedFrom, { n: 80, m: 50, unit: "campaigns" });
    expect(out).toContain("computed from all 50 campaigns");
    expect(out).not.toContain("80");
  });

  it("falls back to just the count when m is undefined", () => {
    const out = html(ComputedFrom, { n: 7, unit: "rows" });
    expect(out).toContain("computed from 7 rows");
    expect(out).not.toContain(" of ");
  });

  it("renders nothing when there's no honest claim (m=0, or n=0 & no m)", () => {
    expect(html(ComputedFrom, { n: 10, m: 0, unit: "rows" })).toBe("");
    expect(html(ComputedFrom, { n: 0, unit: "rows" })).toBe("");
  });

  it("guards nullish n with ?? 0", () => {
    const out = html(ComputedFrom, { n: undefined, m: 100, unit: "rows" });
    expect(out).toContain("computed from 0 of 100 rows");
  });
});

describe("SampleSize", () => {
  it("renders 'based on n noun' for a real sample", () => {
    const out = html(SampleSize, { n: 1240, noun: "opens" });
    expect(out).toContain("based on 1,240 opens");
  });

  it("singularises when the sample is exactly one", () => {
    const out = html(SampleSize, { n: 1, noun: "orders" });
    expect(out).toContain("based on 1 order");
  });

  it("renders an honest 'no data yet' variant at n=0, never 'based on 0'", () => {
    const out = html(SampleSize, { n: 0, noun: "opens" });
    expect(out).toContain("no opens yet");
    expect(out).not.toContain("based on 0");
  });

  it("treats nullish n as the no-data variant", () => {
    const out = html(SampleSize, { n: null, noun: "records" });
    expect(out).toContain("no records yet");
  });
});

describe("ConfidenceNote", () => {
  it("renders nothing when there's no low flag and no interval", () => {
    expect(html(ConfidenceNote)).toBe("");
    expect(html(ConfidenceNote, { level: "ok" })).toBe("");
  });

  it("renders the caution copy only when level is low", () => {
    const out = html(ConfidenceNote, { level: "low" });
    expect(out).toContain("low sample — interpret with caution");
  });

  it("renders a range ONLY when a real interval is supplied", () => {
    const out = html(ConfidenceNote, {
      interval: { low: 12, high: 20 },
      unit: "%",
    });
    expect(out).toContain("range 12–20%");
  });

  it("never invents an interval — no interval prop means no range text", () => {
    const out = html(ConfidenceNote, { level: "low" });
    expect(out).not.toContain("range");
  });

  it("combines low caution + a supplied interval", () => {
    const out = html(ConfidenceNote, {
      level: "low",
      interval: { low: 1, high: 3 },
      unit: " orders",
    });
    expect(out).toContain("low sample");
    expect(out).toContain("range 1–3 orders");
  });

  it("ignores a non-finite interval rather than rendering garbage", () => {
    const out = html(ConfidenceNote, { interval: { low: NaN, high: 5 } });
    expect(out).toBe("");
  });
});
