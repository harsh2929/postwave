// Engagement-score helpers (R2 full-surface wiring): decile-strip
// view building, score-range parsing (mirrors the server's
// bad_min/bad_max/bad_range 400s), honest paging captions, and the
// scored/unscored display copy. Also pins the segment-creation
// decision note (browse-only — the segment compiler has no
// engagement_score field).

import { describe, expect, it } from "vitest";

import {
  SCORE_SEGMENT_NOTE,
  browseCaption,
  buildDistributionView,
  engagementScoreDisplay,
  parseScoreRange,
} from "../../components/subscribers/engagement-score-helpers";

describe("buildDistributionView", () => {
  it("computes shares against the bucket total, preserving order", () => {
    const v = buildDistributionView([
      { range: "0–10", min: 0, max: 10, count: 30 },
      { range: "11–40", min: 11, max: 40, count: 60 },
      { range: "41–90", min: 41, max: 90, count: 10 },
    ]);
    expect(v.total).toBe(100);
    expect(v.slices.map((s) => s.share)).toEqual([0.3, 0.6, 0.1]);
    expect(v.slices.map((s) => s.range)).toEqual(["0–10", "11–40", "41–90"]);
  });

  it("drops zero/garbage-count buckets and handles the empty tenant", () => {
    const v = buildDistributionView([
      { range: "0–0", min: 0, max: 0, count: 0 },
      { range: "x", min: 0, max: 0, count: Number.NaN },
    ]);
    expect(v.slices).toEqual([]);
    expect(v.total).toBe(0);
  });

  it("fewer than 10 buckets (NTILE on small tenants) pass through verbatim", () => {
    const v = buildDistributionView([
      { range: "5–5", min: 5, max: 5, count: 2 },
    ]);
    expect(v.slices).toHaveLength(1);
    expect(v.slices[0]!.share).toBe(1);
  });
});

describe("parseScoreRange", () => {
  it("blank bounds mean unbounded (omitted, not zero)", () => {
    expect(parseScoreRange("", "")).toEqual({ ok: true });
    expect(parseScoreRange(" 10 ", "")).toEqual({ ok: true, min: 10 });
    expect(parseScoreRange("", "55")).toEqual({ ok: true, max: 55 });
  });

  it("accepts negative integers (rule weights can be negative)", () => {
    expect(parseScoreRange("-5", "5")).toEqual({ ok: true, min: -5, max: 5 });
  });

  it("rejects non-integers, mirroring bad_min/bad_max", () => {
    expect(parseScoreRange("3.5", "")).toMatchObject({ ok: false });
    expect(parseScoreRange("abc", "")).toMatchObject({ ok: false });
    const r = parseScoreRange("", "1e3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/max/i);
  });

  it("rejects min > max, mirroring bad_range", () => {
    const r = parseScoreRange("10", "5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/min must be/i);
  });
});

describe("browseCaption", () => {
  it("is honest about empty ranges", () => {
    expect(browseCaption(0, 1, 25, 0)).toMatch(/no scored subscribers/i);
  });

  it("reports page-of-pages and shown-of-total", () => {
    expect(browseCaption(120, 2, 25, 25)).toBe(
      "Page 2 of 5 · 25 shown of 120 in range",
    );
  });

  it("clamps to at least one page", () => {
    expect(browseCaption(3, 1, 25, 3)).toMatch(/Page 1 of 1/);
  });
});

describe("engagementScoreDisplay", () => {
  it("null score → honest unscored copy, never a fake zero", () => {
    const d = engagementScoreDisplay(null);
    expect(d.scored).toBe(false);
    expect(d.label).toBe("Not scored yet");
    expect(d.detail).toMatch(/scoring worker/i);
  });

  it("scored → bare integer (no invented denominator) + computed stamp", () => {
    const d = engagementScoreDisplay(62, "2026-06-01");
    expect(d.scored).toBe(true);
    expect(d.label).toBe("62");
    expect(d.detail).toBe("computed 2026-06-01");
  });

  it("scored without a stamp → no fabricated detail", () => {
    expect(engagementScoreDisplay(7).detail).toBeNull();
  });
});

describe("segment-creation decision", () => {
  it("the browse-only note explains WHY ranges can't become segments", () => {
    expect(SCORE_SEGMENT_NOTE).toMatch(/can't be saved as segments/i);
    expect(SCORE_SEGMENT_NOTE).toMatch(/no engagement-score field/i);
  });
});
