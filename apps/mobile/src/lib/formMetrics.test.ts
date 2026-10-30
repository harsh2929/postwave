import { describe, expect, it } from "vitest";

import {
  alignVisitCounts,
  computeAggregateConversion,
  computeFormsKpis,
  conversionCaption,
  formFieldCount,
  formStepCount,
  utcDayBuckets,
  windowConversion,
  type FormMetricRow,
} from "./formMetrics";

describe("computeAggregateConversion", () => {
  it("is empty for an empty tenant", () => {
    expect(computeAggregateConversion([])).toEqual({ mode: "empty" });
  });

  it("uses Σ submissions ÷ Σ visits when coverage and comparability hold", () => {
    const rows: FormMetricRow[] = [
      { submissions30d: 10, visits30d: 100, conversionRate: 10 },
      { submissions30d: 40, visits30d: 100, conversionRate: 40 },
    ];
    expect(computeAggregateConversion(rows)).toEqual({
      mode: "weighted",
      rate: 25,
      submissions: 50,
      visits: 200,
      covered: 2,
      total: 2,
    });
  });

  it("never weights a rate by its own numerator (the inflation bug)", () => {
    // 1 form converts 50% on 2 visits, another 10% on 1000 visits. The honest
    // visit-weighted answer is ~10.1%, NOT the ~46% you get by weighting each
    // rate by its submissions.
    const rows: FormMetricRow[] = [
      { submissions30d: 1, visits30d: 2, conversionRate: 50 },
      { submissions30d: 100, visits30d: 1000, conversionRate: 10 },
    ];
    const conv = computeAggregateConversion(rows);
    expect(conv.mode).toBe("weighted");
    expect(conv.mode === "weighted" && conv.rate).toBeCloseTo(10.08, 1);
  });

  it("falls back to a labelled unweighted mean below the coverage floor", () => {
    const rows: FormMetricRow[] = [
      { submissions30d: 5, visits30d: 100, conversionRate: 5 },
      { submissions30d: 5, conversionRate: 25 },
      { submissions30d: 5, conversionRate: 45 },
    ];
    expect(computeAggregateConversion(rows)).toEqual({
      mode: "unweighted",
      rate: 25,
      total: 3,
    });
  });

  it("refuses a weighted rate when submissions exceed the visit denominator", () => {
    // Embed submissions do not appear in hosted-page visits, so this pair is
    // not comparable — a weighted percentage would exceed 100%.
    const rows: FormMetricRow[] = [
      { submissions30d: 500, visits30d: 10, conversionRate: 100 },
      { submissions30d: 1, visits30d: 10, conversionRate: 10 },
    ];
    const conv = computeAggregateConversion(rows);
    expect(conv.mode).toBe("unweighted");
    expect(conv.mode === "unweighted" && conv.rate).toBe(55);
  });

  it("does not divide by a zero visit total", () => {
    const rows: FormMetricRow[] = [
      { submissions30d: 0, visits30d: 0, conversionRate: 0 },
    ];
    expect(computeAggregateConversion(rows).mode).toBe("unweighted");
  });

  it("ignores non-finite server values instead of producing NaN", () => {
    const rows = [
      { submissions30d: Number.NaN, visits30d: 100, conversionRate: 10 },
      { submissions30d: 10, visits30d: 100, conversionRate: Number.NaN },
    ] as unknown as FormMetricRow[];
    const conv = computeAggregateConversion(rows);
    expect(conv.mode === "weighted" && Number.isFinite(conv.rate)).toBe(true);
  });

  it("clamps out-of-range per-form rates in the unweighted fallback", () => {
    const rows: FormMetricRow[] = [
      { conversionRate: 500 },
      { conversionRate: -50 },
    ];
    const conv = computeAggregateConversion(rows);
    expect(conv.mode === "unweighted" && conv.rate).toBe(50);
  });
});

describe("conversionCaption", () => {
  it("always discloses which of the two claims is on screen", () => {
    expect(
      conversionCaption({
        mode: "weighted",
        rate: 10,
        submissions: 1,
        visits: 10,
        covered: 3,
        total: 4,
      }),
    ).toBe("Visit-weighted · 3 of 4 forms report visits");
    expect(conversionCaption({ mode: "unweighted", rate: 10, total: 4 })).toBe(
      "Unweighted mean of 4 per-form rates",
    );
    expect(conversionCaption({ mode: "empty" })).toBe("No forms yet");
  });
});

describe("computeFormsKpis", () => {
  it("buckets statuses and treats a missing status as draft", () => {
    const kpis = computeFormsKpis([
      { status: "published", submissions30d: 3 },
      { status: "ARCHIVED", submissions30d: 1 },
      { submissions30d: 2 },
      { status: "draft" },
    ]);
    expect(kpis).toMatchObject({
      total: 4,
      draft: 2,
      published: 1,
      archived: 1,
      submissions30d: 6,
    });
  });
});

describe("alignVisitCounts", () => {
  it("zero-fills missing days and sums duplicate buckets", () => {
    expect(
      alignVisitCounts(
        [
          { date: "2026-07-01T00:00:00Z", count: 2 },
          { date: "2026-07-01", count: 3 },
        ],
        ["2026-06-30", "2026-07-01", "2026-07-02"],
      ),
    ).toEqual([0, 5, 0]);
  });

  it("tolerates a missing or malformed series", () => {
    expect(alignVisitCounts(undefined, ["2026-07-01"])).toEqual([0]);
    expect(
      alignVisitCounts(
        [{ date: 5 as unknown as string, count: 2 }],
        ["2026-07-01"],
      ),
    ).toEqual([0]);
  });
});

describe("windowConversion", () => {
  it("is null with no visits — undefined is not 0%", () => {
    expect(windowConversion(0, 0)).toBeNull();
    expect(windowConversion(5, 0)).toBeNull();
  });

  it("is null when submissions exceed visits", () => {
    expect(windowConversion(11, 10)).toBeNull();
  });

  it("returns a percentage otherwise", () => {
    expect(windowConversion(5, 20)).toBe(25);
  });
});

describe("utcDayBuckets", () => {
  it("returns `days` ordered UTC days ending today", () => {
    const now = Date.parse("2026-07-25T10:00:00Z");
    expect(utcDayBuckets(3, now)).toEqual([
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
    ]);
  });

  it("clamps the window to the server's 1..90 contract", () => {
    expect(utcDayBuckets(0)).toHaveLength(1);
    expect(utcDayBuckets(365)).toHaveLength(90);
  });
});

describe("formFieldCount", () => {
  it("counts inputs and ignores chrome", () => {
    expect(
      formFieldCount({
        fields: [
          { id: "h1", kind: "heading" },
          { id: "f_email", kind: "email" },
          { id: "f_name", kind: "name" },
          { id: "f_consent", kind: "checkbox" },
          { id: "f_hp", kind: "honeypot" },
          { id: "f_submit", kind: "submit" },
        ],
      }),
    ).toBe(3);
  });

  it("returns null rather than substituting another number", () => {
    // A null tells the caller "you do not know the field count" — the whole
    // point, since the alternative was labelling the PAGE count "Fields".
    expect(formFieldCount(null)).toBeNull();
    expect(formFieldCount(undefined)).toBeNull();
    expect(formFieldCount({})).toBeNull();
    expect(formFieldCount({ fields: "nope" })).toBeNull();
  });

  it("skips malformed entries instead of throwing", () => {
    expect(
      formFieldCount({ fields: [null, 7, { kind: 5 }, { kind: "email" }] }),
    ).toBe(1);
  });
});

describe("formStepCount", () => {
  it("reports an empty steps list as the single page it is", () => {
    expect(formStepCount(0)).toBe(1);
    expect(formStepCount(undefined)).toBe(1);
    expect(formStepCount(3)).toBe(3);
    expect(formStepCount(-2)).toBe(1);
  });
});
