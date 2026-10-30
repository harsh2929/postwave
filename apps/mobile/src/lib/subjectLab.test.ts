import { describe, expect, it } from "vitest";

import {
  parseSubjectCandidates,
  rankSubjectScoreRows,
  readSubjectBuckets,
  readSubjectLabScore,
  subjectBucketTakeaway,
  subjectCandidateError,
  SUBJECT_LAB_MAX_CANDIDATES,
} from "@/lib/subjectLab";

describe("parseSubjectCandidates", () => {
  it("splits on lines, trims, drops blanks and collapses duplicates", () => {
    expect(
      parseSubjectCandidates("  Spring sale \n\nSpring Sale\n\n Last call \n"),
    ).toEqual(["Spring sale", "Last call"]);
  });

  it("is empty for empty input", () => {
    expect(parseSubjectCandidates("")).toEqual([]);
    expect(parseSubjectCandidates(null)).toEqual([]);
    expect(parseSubjectCandidates("   \n  ")).toEqual([]);
  });
});

describe("subjectCandidateError", () => {
  it("refuses an empty list and a list past the server's cap", () => {
    expect(subjectCandidateError([])).toContain("at least one");
    const tooMany = Array.from(
      { length: SUBJECT_LAB_MAX_CANDIDATES + 1 },
      (_, i) => `subject ${i}`,
    );
    expect(subjectCandidateError(tooMany)).toContain(
      String(SUBJECT_LAB_MAX_CANDIDATES),
    );
    expect(subjectCandidateError(["one"])).toBeNull();
  });
});

/**
 * subject_lab.go's `scoringModel` swallows an empty or unreadable corpus to
 * `baseline=0, buckets={}`, and every variant then comes back low_confidence
 * with a baseline-derived point estimate. That is the response this reader
 * exists to refuse to render as a measurement.
 */
const EMPTY_CORPUS_RESPONSE = {
  baseline_open: 0,
  window_days: 180,
  variants: [
    {
      text: "Spring sale",
      axis: "",
      predicted_open: 0,
      ci_low: 0,
      ci_high: 0.15,
      matched_n: 0,
      low_confidence: true,
      below_baseline: false,
    },
  ],
};

const REAL_RESPONSE = {
  baseline_open: 0.184,
  window_days: 180,
  variants: [
    {
      text: "Your April report is ready",
      axis: "",
      predicted_open: 0.231,
      ci_low: 0.198,
      ci_high: 0.264,
      matched_n: 14,
      low_confidence: false,
      below_baseline: false,
    },
    {
      text: "ACT NOW!!!",
      axis: "",
      predicted_open: 0.101,
      ci_low: 0.062,
      ci_high: 0.14,
      matched_n: 7,
      low_confidence: false,
      below_baseline: true,
    },
    {
      text: "A quiet one",
      axis: "",
      predicted_open: 0.19,
      ci_low: 0.04,
      ci_high: 0.34,
      matched_n: 2,
      low_confidence: true,
      below_baseline: false,
    },
  ],
};

describe("readSubjectLabScore", () => {
  it("never renders an empty corpus as a measured 0%", () => {
    const reading = readSubjectLabScore(EMPTY_CORPUS_RESPONSE);
    expect(reading.baselineOpen).toBeNull();
    expect(reading.baselineLabel).toBe("—");
    expect(reading.insufficient).toBe(true);
    const row = reading.rows[0]!;
    expect(row.predictedOpen).toBeNull();
    expect(row.predictedLabel).toBe("—");
    expect(row.bandLabel).toBe("—");
    expect(row.verdict).toBe("unknown");
    expect(row.deltaLabel).toBeNull();
    expect(row.caveat).toContain("No past send matches");
  });

  it("reads a real corpus, classifies each row against the baseline", () => {
    const reading = readSubjectLabScore(REAL_RESPONSE);
    expect(reading.baselineOpen).toBeCloseTo(0.184);
    expect(reading.baselineLabel).toBe("18.4%");
    expect(reading.windowDays).toBe(180);
    expect(reading.insufficient).toBe(false);

    const [good, bad, thin] = reading.rows;
    expect(good?.verdict).toBe("above");
    expect(good?.predictedLabel).toBe("23.1%");
    expect(good?.bandLabel).toBe("19.8%–26.4%");
    expect(good?.deltaLabel).toBe("+4.7 pts vs your baseline");
    expect(good?.caveat).toBeNull();

    expect(bad?.verdict).toBe("below");
    expect(bad?.deltaLabel).toBe("−8.3 pts vs your baseline");

    // Estimate present but weak: still shown, still caveated, never ranked
    // as if it were as solid as the others.
    expect(thin?.lowConfidence).toBe(true);
    expect(thin?.verdict).toBe("inline");
    expect(thin?.caveat).toContain("Only 2 past sends");
  });

  it("survives a garbage or truncated body", () => {
    for (const raw of [null, undefined, {}, [], "nope", 7]) {
      const reading = readSubjectLabScore(raw);
      expect(reading.rows).toEqual([]);
      expect(reading.baselineOpen).toBeNull();
    }
    // A variant with no text is not a row.
    expect(
      readSubjectLabScore({ variants: [{ predicted_open: 0.5 }] }).rows,
    ).toEqual([]);
  });
});

describe("rankSubjectScoreRows", () => {
  it("puts confident winners first and unmeasured rows last", () => {
    const reading = readSubjectLabScore({
      baseline_open: 0.2,
      variants: [
        { text: "thin", predicted_open: 0.9, matched_n: 1, low_confidence: true },
        { text: "mid", predicted_open: 0.25, matched_n: 20 },
        { text: "top", predicted_open: 0.4, matched_n: 30 },
      ],
    });
    expect(rankSubjectScoreRows(reading.rows).map((r) => r.text)).toEqual([
      "top",
      "mid",
      "thin",
    ]);
  });

  it("does not sort an unmeasurable row as if it scored zero", () => {
    const reading = readSubjectLabScore({
      baseline_open: 0,
      variants: [
        { text: "unknown", predicted_open: 0, matched_n: 0, low_confidence: true },
        { text: "known", predicted_open: 0.1, matched_n: 9 },
      ],
    });
    const ranked = rankSubjectScoreRows(reading.rows);
    expect(ranked[0]?.text).toBe("known");
    expect(ranked[1]?.predictedOpen).toBeNull();
  });
});

const BUCKETS_RESPONSE = {
  window_days: 180,
  campaigns_total: 42,
  buckets: [
    { attribute: "length", bucket: "short", campaigns: 12, open_rate: 0.24, click_rate: 0.03 },
    { attribute: "length", bucket: "very_long", campaigns: 6, open_rate: 0.11, click_rate: 0.01 },
    { attribute: "has_emoji", bucket: "yes", campaigns: 9, open_rate: 0.21, click_rate: 0.02 },
    { attribute: "has_emoji", bucket: "no", campaigns: 33, open_rate: 0.18, click_rate: 0.02 },
    // An attribute the client does not know about must not crash the read.
    { attribute: "future_attribute", bucket: "yes", campaigns: 3, open_rate: 0.5 },
  ],
};

describe("readSubjectBuckets", () => {
  it("groups by attribute in reading order, best bucket first", () => {
    const reading = readSubjectBuckets(BUCKETS_RESPONSE);
    expect(reading.campaignsTotal).toBe(42);
    expect(reading.windowDays).toBe(180);
    expect(reading.insufficient).toBe(false);
    expect(reading.groups.map((g) => g.attribute)).toEqual([
      "length",
      "has_emoji",
    ]);
    const length = reading.groups[0]!;
    expect(length.rows.map((r) => r.label)).toEqual([
      "Under 30 characters",
      "80+ characters",
    ]);
    expect(length.rows[0]?.openLabel).toBe("24.0%");
  });

  it("flags a corpus too small to mean anything", () => {
    const reading = readSubjectBuckets({
      campaigns_total: 2,
      buckets: [{ attribute: "length", bucket: "short", campaigns: 2, open_rate: 0.9 }],
    });
    expect(reading.insufficient).toBe(true);
  });

  it("survives a garbage body", () => {
    for (const raw of [null, undefined, {}, "nope"]) {
      const reading = readSubjectBuckets(raw);
      expect(reading.groups).toEqual([]);
      expect(reading.insufficient).toBe(true);
    }
  });
});

describe("subjectBucketTakeaway", () => {
  it("names the winning bucket and the gap", () => {
    const reading = readSubjectBuckets(BUCKETS_RESPONSE);
    expect(subjectBucketTakeaway(reading.groups[0]!)).toBe(
      "Under 30 characters opens 13.0 pts higher than 80+ characters.",
    );
  });

  it("recommends nothing off a bucket that thin", () => {
    const reading = readSubjectBuckets({
      campaigns_total: 40,
      buckets: [
        { attribute: "length", bucket: "short", campaigns: 2, open_rate: 0.9 },
        { attribute: "length", bucket: "long", campaigns: 38, open_rate: 0.2 },
      ],
    });
    expect(subjectBucketTakeaway(reading.groups[0]!)).toBeNull();
  });

  it("says so when there is no measurable difference", () => {
    const reading = readSubjectBuckets({
      campaigns_total: 40,
      buckets: [
        { attribute: "has_emoji", bucket: "yes", campaigns: 20, open_rate: 0.2 },
        { attribute: "has_emoji", bucket: "no", campaigns: 20, open_rate: 0.2 },
      ],
    });
    expect(subjectBucketTakeaway(reading.groups[0]!)).toContain(
      "No measurable difference",
    );
  });
});
