// Growth sources mapping (full-surface wiring #24): summary buckets →
// Donut slices aggregated per consent_source, timeseries points →
// aligned MultiLineChart series, and 0..1 rate formatting that never
// rounds a real complaint rate down to a dishonest "0%".

import { describe, expect, it } from "vitest";

import type { GrowthSourceBucket } from "../../lib/api/growth-sources";
import {
  type GrowthTimeseriesPoint,
  donutSlicesFromSummary,
  fmtRate01,
  seriesFromTimeseries,
  sourceLabel,
} from "../../components/lists/growth-sources-helpers";

describe("sourceLabel", () => {
  it("labels empty consent_source as untracked instead of dropping it", () => {
    expect(sourceLabel("")).toBe("untracked");
    expect(sourceLabel("  ")).toBe("untracked");
    expect(sourceLabel("import")).toBe("import");
  });

  it("treats a null/undefined consent_source as untracked (no .trim crash)", () => {
    // The wire types `consent_source` as a non-null string, but the Go
    // handler can emit a null/absent bucket field. It must label
    // "untracked" rather than throwing "Cannot read .trim of undefined".
    expect(
      sourceLabel(null as unknown as Parameters<typeof sourceLabel>[0]),
    ).toBe("untracked");
    expect(
      sourceLabel(undefined as unknown as Parameters<typeof sourceLabel>[0]),
    ).toBe("untracked");
  });
});

describe("donutSlicesFromSummary", () => {
  it("sums across source_platform per consent_source and sorts by count desc", () => {
    const slices = donutSlicesFromSummary([
      { consent_source: "form", source_platform: "web", count: 5 },
      { consent_source: "form", source_platform: "mobile", count: 7 },
      { consent_source: "import", source_platform: "", count: 20 },
      { consent_source: "", source_platform: "", count: 1 },
    ]);
    expect(slices).toEqual([
      { label: "import", value: 20 },
      { label: "form", value: 12 },
      { label: "untracked", value: 1 },
    ]);
  });

  it("tolerates a bucket missing fields (null source / absent count)", () => {
    // A partial bucket must not crash or NaN the totals: a missing
    // consent_source rolls into "untracked" and a missing count adds 0.
    const slices = donutSlicesFromSummary([
      { consent_source: "form", source_platform: "web", count: 4 },
      // missing count → contributes 0
      {
        consent_source: "form",
        source_platform: "mobile",
      } as unknown as GrowthSourceBucket,
      // null consent_source → "untracked"
      {
        consent_source: null,
        source_platform: "web",
        count: 2,
      } as unknown as GrowthSourceBucket,
    ]);
    expect(slices).toEqual([
      { label: "form", value: 4 },
      { label: "untracked", value: 2 },
    ]);
    // No NaN leaked into any value.
    expect(slices.every((s) => Number.isFinite(s.value))).toBe(true);
  });

  it("returns no slices when the summary omits `sources` (empty window)", () => {
    // The wire sends a minimal `{window_days}` body on an empty window;
    // an undefined/non-array `sources` must yield [] instead of throwing
    // "sources is not iterable".
    expect(donutSlicesFromSummary(undefined)).toEqual([]);
    expect(donutSlicesFromSummary(null)).toEqual([]);
    expect(donutSlicesFromSummary([])).toEqual([]);
    expect(
      donutSlicesFromSummary(
        {} as unknown as Parameters<typeof donutSlicesFromSummary>[0],
      ),
    ).toEqual([]);
  });
});

describe("seriesFromTimeseries", () => {
  it("groups by source, zero-fills the union of dates, orders by total desc", () => {
    const series = seriesFromTimeseries([
      { date: "2026-06-01", consent_source: "form", count: 2 },
      { date: "2026-06-02", consent_source: "form", count: 3 },
      // import only has data on day 2 — its day-1 point must be 0,
      // not missing, so the chart x-axes stay aligned.
      { date: "2026-06-02", consent_source: "import", count: 10 },
    ]);
    expect(series.map((s) => s.label)).toEqual(["import", "form"]);
    expect(series[1]?.values).toEqual([
      { date: "2026-06-01", count: 2 },
      { date: "2026-06-02", count: 3 },
    ]);
    expect(series[0]?.values).toEqual([
      { date: "2026-06-01", count: 0 },
      { date: "2026-06-02", count: 10 },
    ]);
  });

  it("returns no series for an empty window", () => {
    expect(seriesFromTimeseries([])).toEqual([]);
  });

  it("tolerates a point missing fields (null source / absent date+count)", () => {
    // A partial point must not crash on `.trim`/`.map` or NaN the
    // totals: a missing consent_source rolls into "untracked", a missing
    // count adds 0, and a missing date collapses to the "" bucket.
    const series = seriesFromTimeseries([
      { date: "2026-06-01", consent_source: "form", count: 3 },
      // null source + missing count → "untracked" series, 0 contribution
      {
        date: "2026-06-01",
        consent_source: null,
      } as unknown as GrowthTimeseriesPoint,
    ]);
    expect(series.map((s) => s.label)).toEqual(["form", "untracked"]);
    const form = series.find((s) => s.label === "form");
    expect(form?.values).toEqual([{ date: "2026-06-01", count: 3 }]);
    // Every emitted count is a real number, never NaN.
    expect(
      series.every((s) => s.values.every((v) => Number.isFinite(v.count))),
    ).toBe(true);
  });

  it("returns no series when the response omits `points`", () => {
    // Empty window → `{window_days}` with no `points`. Must not throw on
    // `.map` of undefined.
    expect(seriesFromTimeseries(undefined)).toEqual([]);
    expect(seriesFromTimeseries(null)).toEqual([]);
    expect(
      seriesFromTimeseries(
        {} as unknown as Parameters<typeof seriesFromTimeseries>[0],
      ),
    ).toEqual([]);
  });
});

describe("fmtRate01", () => {
  it("keeps a decimal under 10% so small real rates stay visible", () => {
    expect(fmtRate01(0.004)).toBe("0.4%");
    expect(fmtRate01(0.0312)).toBe("3.1%");
  });

  it("rounds at or above 10%, handles exact zero and non-finite", () => {
    expect(fmtRate01(0.5)).toBe("50%");
    expect(fmtRate01(0)).toBe("0%");
    expect(fmtRate01(1)).toBe("100%");
    expect(fmtRate01(Number.NaN)).toBe("—");
  });
});
