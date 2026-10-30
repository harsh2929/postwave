// Forms metrics (desktop audit task: visit-weighted conversion +
// visits-vs-submissions). computeAggregateConversion powers the
// FormsStatStrip KPI; alignVisitCounts/windowConversion power the
// SubmissionsAnalytics visits block.

import { describe, expect, it } from "vitest";

import {
  alignVisitCounts,
  computeAggregateConversion,
  windowConversion,
} from "../../components/forms/form-metrics";
import type { FormSummary } from "../../lib/api-client";

function form(partial: Partial<FormSummary>): FormSummary {
  return {
    id: "f1",
    slug: "f1",
    name: "Form",
    optInMode: "single",
    status: "published",
    submissions30d: 0,
    conversionRate: 0,
    ...partial,
  };
}

describe("computeAggregateConversion", () => {
  it("returns empty for no rows", () => {
    expect(computeAggregateConversion([])).toEqual({ mode: "empty" });
  });

  it("computes the true visit-weighted aggregate when all rows carry visits", () => {
    const rows = [
      form({ submissions30d: 10, visits30d: 100, conversionRate: 10 }),
      form({ submissions30d: 1, visits30d: 300, conversionRate: 0.33 }),
    ];
    const out = computeAggregateConversion(rows);
    expect(out.mode).toBe("weighted");
    if (out.mode !== "weighted") return;
    // 11 subs / 400 visits = 2.75% — NOT the (10 + 0.33)/2 ≈ 5.17%
    // unweighted mean. This is the inflation the weighted mode fixes.
    expect(out.rate).toBeCloseTo(2.75, 5);
    expect(out.submissions).toBe(11);
    expect(out.visits).toBe(400);
    expect(out.covered).toBe(2);
    expect(out.total).toBe(2);
  });

  it("stays weighted at exactly half coverage and reports the covered count", () => {
    const rows = [
      form({ submissions30d: 5, visits30d: 50 }),
      form({ submissions30d: 99 }), // no visits — excluded from sums
    ];
    const out = computeAggregateConversion(rows);
    expect(out.mode).toBe("weighted");
    if (out.mode !== "weighted") return;
    expect(out.rate).toBeCloseTo(10, 5);
    expect(out.covered).toBe(1);
    expect(out.total).toBe(2);
    // The uncovered form's submissions must NOT leak into the sums.
    expect(out.submissions).toBe(5);
  });

  it("falls back to the unweighted mean when too few rows carry visits", () => {
    const rows = [
      form({ visits30d: 100, submissions30d: 10, conversionRate: 10 }),
      form({ conversionRate: 4 }),
      form({ conversionRate: 1 }),
    ];
    const out = computeAggregateConversion(rows);
    expect(out.mode).toBe("unweighted");
    if (out.mode !== "unweighted") return;
    expect(out.rate).toBeCloseTo(5, 5);
    expect(out.total).toBe(3);
  });

  it("falls back to the unweighted mean when visits sum to zero", () => {
    const rows = [
      form({ visits30d: 0, conversionRate: 3 }),
      form({ visits30d: 0, conversionRate: 5 }),
    ];
    const out = computeAggregateConversion(rows);
    expect(out.mode).toBe("unweighted");
    if (out.mode !== "unweighted") return;
    expect(out.rate).toBeCloseTo(4, 5);
  });

  it("treats visits30d: 0 as present for coverage (an honest zero)", () => {
    const rows = [
      form({ visits30d: 200, submissions30d: 4 }),
      form({ visits30d: 0, submissions30d: 0 }),
    ];
    const out = computeAggregateConversion(rows);
    expect(out.mode).toBe("weighted");
    if (out.mode !== "weighted") return;
    expect(out.covered).toBe(2);
    expect(out.rate).toBeCloseTo(2, 5);
  });

  it("falls back instead of showing an impossible rate when submissions exceed hosted visits", () => {
    const rows = [
      form({ visits30d: 4, submissions30d: 8, conversionRate: 100 }),
      form({ visits30d: 10, submissions30d: 2, conversionRate: 20 }),
    ];
    const out = computeAggregateConversion(rows);
    expect(out).toEqual({ mode: "unweighted", rate: 60, total: 2 });
  });

  it("bounds malformed fallback rates to the representable 0–100 range", () => {
    const rows = [form({ conversionRate: 180 }), form({ conversionRate: -20 })];
    expect(computeAggregateConversion(rows)).toEqual({
      mode: "unweighted",
      rate: 50,
      total: 2,
    });
  });
});

describe("alignVisitCounts", () => {
  const isoDates = ["2026-06-08", "2026-06-09", "2026-06-10"];

  it("aligns visit rows to the bucket dates, zero-filling gaps", () => {
    const out = alignVisitCounts(
      [
        { date: "2026-06-10", count: 7 },
        { date: "2026-06-08", count: 2 },
      ],
      isoDates,
    );
    expect(out).toEqual([2, 0, 7]);
  });

  it("ignores rows outside the window", () => {
    const out = alignVisitCounts([{ date: "2026-05-01", count: 99 }], isoDates);
    expect(out).toEqual([0, 0, 0]);
  });

  it("matches timestamps on their calendar-day prefix", () => {
    const out = alignVisitCounts(
      [{ date: "2026-06-09T00:00:00Z", count: 3 }],
      isoDates,
    );
    expect(out).toEqual([0, 3, 0]);
  });

  it("sums duplicate rows for the same day", () => {
    const out = alignVisitCounts(
      [
        { date: "2026-06-09", count: 1 },
        { date: "2026-06-09", count: 4 },
      ],
      isoDates,
    );
    expect(out).toEqual([0, 5, 0]);
  });
});

describe("windowConversion", () => {
  it("returns the percentage when visits exist", () => {
    expect(windowConversion(5, 200)).toBeCloseTo(2.5, 5);
  });

  it("returns null (undefined conversion) when there are no visits", () => {
    expect(windowConversion(0, 0)).toBeNull();
    expect(windowConversion(10, 0)).toBeNull();
  });

  it("returns null when hosted visits are not a complete denominator", () => {
    expect(windowConversion(11, 10)).toBeNull();
  });
});
