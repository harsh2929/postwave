// RFM & predictive helpers (full-surface wiring #26): per-email RFM
// rows → R×F count grid, segment counts ordered by the server catalog,
// and honest recompute toast copy built from the {run, predictions,
// rfm_scores} response.

import { describe, expect, it } from "vitest";

import {
  buildRFMGrid,
  fmtPct01,
  parseRFMSegmentCatalog,
  profilesCaption,
  recomputeToastCopy,
  rfmSegmentCounts,
} from "../../components/segments/rfm-helpers";
import type {
  PredictiveRecomputeResult,
  RFMScoreRow,
} from "../../lib/api-client";

function row(over: Partial<RFMScoreRow>): RFMScoreRow {
  return {
    email: "a@example.com",
    frequency: 2,
    monetary_cents: 1000,
    recency_score: 3,
    frequency_score: 3,
    monetary_score: 3,
    rfm_score: "333",
    segment_key: "needs_attention",
    ...over,
  };
}

describe("buildRFMGrid", () => {
  it("buckets rows into a 5×5 grid with recency 5 on top", () => {
    const grid = buildRFMGrid([
      row({ recency_score: 5, frequency_score: 5 }),
      row({ recency_score: 5, frequency_score: 5 }),
      row({ recency_score: 1, frequency_score: 2 }),
    ]);
    expect(grid.columns).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    expect(grid.rows).toHaveLength(5);
    // Top row is R5; its F5 cell holds the two champions.
    expect(grid.rows[0]?.label).toContain("R5");
    expect(grid.rows[0]?.values[4]).toBe(2);
    expect(grid.rows[0]?.size).toBe(2);
    // Bottom row is R1; F2 holds the cold subscriber.
    expect(grid.rows[4]?.label).toContain("R1");
    expect(grid.rows[4]?.values[1]).toBe(1);
    expect(grid.counted).toBe(3);
    expect(grid.skipped).toBe(0);
  });

  it("renders empty cells as null (— in the Heatmap), not zero", () => {
    const grid = buildRFMGrid([row({ recency_score: 3, frequency_score: 3 })]);
    expect(grid.rows[2]?.values[2]).toBe(1);
    expect(grid.rows[2]?.values[0]).toBeNull();
    expect(grid.rows[0]?.values.every((v) => v === null)).toBe(true);
  });

  it("refuses to place out-of-range scores and reports them as skipped", () => {
    const grid = buildRFMGrid([
      row({ recency_score: 0, frequency_score: 3 }),
      row({ recency_score: 3, frequency_score: 6 }),
      row({ recency_score: 2, frequency_score: 2 }),
    ]);
    expect(grid.counted).toBe(1);
    expect(grid.skipped).toBe(2);
  });

  it("yields an empty grid when items is absent/non-array (empty response)", () => {
    // /predictive/rfm/segments may omit `items` before any recompute —
    // the grid must build (counted 0) rather than throw.
    for (const bad of [
      undefined,
      null,
      {} as unknown as RFMScoreRow[],
    ]) {
      const grid = buildRFMGrid(bad);
      expect(grid.counted).toBe(0);
      expect(grid.skipped).toBe(0);
      expect(grid.rows).toHaveLength(5);
    }
  });
});

describe("parseRFMSegmentCatalog / rfmSegmentCounts", () => {
  it("narrows the unknown[] catalog and orders counts by it, appending unknown keys", () => {
    const catalog = parseRFMSegmentCatalog([
      { key: "champions", label: "Champions" },
      { key: "hibernating", label: "Hibernating" },
      { bogus: true },
      "nope",
    ]);
    expect(catalog).toEqual([
      { key: "champions", label: "Champions" },
      { key: "hibernating", label: "Hibernating" },
    ]);

    const counts = rfmSegmentCounts(
      [
        row({ segment_key: "hibernating" }),
        row({ segment_key: "hibernating" }),
        row({ segment_key: "mystery_key" }),
      ],
      catalog,
    );
    expect(counts).toEqual([
      { key: "champions", label: "Champions", count: 0 },
      { key: "hibernating", label: "Hibernating", count: 2 },
      // Not in the catalog — surfaced verbatim, never dropped.
      { key: "mystery_key", label: "mystery_key", count: 1 },
    ]);
  });

  it("tolerates absent/non-array items and an empty catalog", () => {
    expect(rfmSegmentCounts(undefined, [])).toEqual([]);
    expect(rfmSegmentCounts(null, [])).toEqual([]);
    // Catalog present but no scored rows → every segment counts 0.
    expect(
      rfmSegmentCounts(undefined, [{ key: "champions", label: "Champions" }]),
    ).toEqual([{ key: "champions", label: "Champions", count: 0 }]);
    // The catalog narrower also no-ops on a missing `rfm_segments`.
    expect(parseRFMSegmentCatalog(undefined)).toEqual([]);
  });
});

describe("recomputeToastCopy", () => {
  const result = (
    over: Partial<PredictiveRecomputeResult["run"]>,
    predictions = 0,
    rfmScores = 0,
  ): PredictiveRecomputeResult => ({
    run: {
      id: "run-1",
      tenant_id: "t-1",
      model_key: "clv",
      model_version: "heuristic-v1",
      status: "completed",
      input_window_days: 365,
      scored_profiles: 0,
      insufficient_profiles: 0,
      created_at: "2026-06-11T00:00:00Z",
      ...over,
    },
    predictions,
    rfm_scores: rfmScores,
  });

  it("reports server-confirmed counts on success", () => {
    const copy = recomputeToastCopy(
      result({ scored_profiles: 120, insufficient_profiles: 4 }, 120, 120),
    );
    expect(copy.ok).toBe(true);
    expect(copy.message).toBe("Scored 120 profiles");
    expect(copy.detail).toContain("120 predictions and 120 RFM scores stored");
    expect(copy.detail).toContain("4 skipped (insufficient data)");
  });

  it("a zero-profile run is honest, not celebratory", () => {
    const copy = recomputeToastCopy(result({}));
    expect(copy.ok).toBe(true);
    expect(copy.message).toBe("Recompute ran — no profiles scored");
    expect(copy.detail).toContain("No subscriber order history");
  });

  it("a failed run surfaces as an error even though HTTP succeeded", () => {
    const copy = recomputeToastCopy(
      result({ status: "failed", error: "store unavailable" }),
    );
    expect(copy.ok).toBe(false);
    expect(copy.message).toBe("Predictive recompute failed");
    expect(copy.detail).toBe("store unavailable");
  });
});

describe("fmtPct01", () => {
  it("formats fractions and guards non-finite values", () => {
    expect(fmtPct01(0.37)).toBe("37%");
    expect(fmtPct01(0.123, 1)).toBe("12.3%");
    expect(fmtPct01(Number.NaN)).toBe("—");
  });
});

describe("profilesCaption", () => {
  it("states the segment scope", () => {
    expect(profilesCaption(3, 50, "Champions")).toBe(
      '3 profiles in "Champions".',
    );
    expect(profilesCaption(1, 50, null)).toBe(
      "1 profile across all segments.",
    );
  });

  it("admits truncation when the page comes back full (wire has no offset/total)", () => {
    const caption = profilesCaption(50, 50, null);
    expect(caption).toContain("first 50 profiles");
    expect(caption).toContain("raise the limit");
  });

  it("handles the empty case", () => {
    expect(profilesCaption(0, 25, "At risk")).toBe(
      'No scored profiles in "At risk".',
    );
    expect(profilesCaption(0, 25, null)).toBe(
      "No scored profiles across all segments.",
    );
  });
});
