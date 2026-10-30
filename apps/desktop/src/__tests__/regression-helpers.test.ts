// Tests for the pure logic behind the AI-output regression harness surfaces.
// severityFromScore is load-bearing for honest-UI: the band must match the
// backend exactly so the badge and the server-side gate never disagree on a
// boundary value.

import { describe, expect, it } from "vitest";

import {
  advisoryEvidenceContext,
  aggregateBySurface,
  evidenceStateLabel,
  evidenceStateTone,
  gateLabel,
  gateTone,
  parseFidelityBreakdown,
  regressionFreshnessReason,
  regressionEvidenceState,
  runIsStale,
  severityFromScore,
  summarizeRegressionResults,
  summarizeRegressionReceipt,
  surfaceReceiptIsCoherent,
  surfaceLabel,
  type RegressionResultLike,
} from "../lib/regression-helpers";

describe("severityFromScore", () => {
  it("bands a score relative to the warn threshold (inclusive at top)", () => {
    expect(severityFromScore(60, 60)).toBe("ok"); // exactly warn => ok
    expect(severityFromScore(61, 60)).toBe("ok");
    expect(severityFromScore(59, 60)).toBe("warn");
    expect(severityFromScore(59.999, 60)).toBe("warn");
  });
  it("keeps the fallback critical band fixed at 40", () => {
    expect(severityFromScore(40, 60)).toBe("warn"); // exactly crit => warn
    expect(severityFromScore(39, 60)).toBe("critical");
    expect(severityFromScore(39.999, 60)).toBe("critical");
    expect(severityFromScore(0, 60)).toBe("critical");
    expect(severityFromScore(39, 90)).toBe("critical");
    expect(severityFromScore(40, 90)).toBe("warn");
  });
  it("honours an explicit critical threshold", () => {
    expect(severityFromScore(45, 60, 50)).toBe("critical");
    expect(severityFromScore(50, 60, 50)).toBe("warn");
  });
  it("checks the frozen pass boundary before the fixed critical boundary", () => {
    expect(severityFromScore(0, 0)).toBe("ok");
    expect(severityFromScore(35, 30)).toBe("ok");
    expect(severityFromScore(30, 30)).toBe("ok");
    expect(severityFromScore(29, 30)).toBe("critical");
  });
  it("keeps non-finite and missing scores unscored instead of inventing zero", () => {
    expect(severityFromScore(Number.NaN, 60)).toBe("unscored");
    expect(severityFromScore(-1, 60)).toBe("unscored");
    expect(severityFromScore(101, 60)).toBe("unscored");
    expect(severityFromScore(null, 60)).toBe("unscored");
    expect(severityFromScore(undefined, 60)).toBe("unscored");
  });
});

describe("surfaceLabel", () => {
  it("maps known surface kinds to human strings", () => {
    expect(surfaceLabel("campaign_draft")).toBe("Campaign draft");
    expect(surfaceLabel("subject_line")).toBe("Subject line");
    expect(surfaceLabel("sequence_draft")).toBe("Sequence draft");
    expect(surfaceLabel("campaign_summary")).toBe("Campaign summary");
    expect(surfaceLabel("reply_intent")).toBe("Reply intent");
  });
  it("humanises an unknown kind without inventing meaning", () => {
    expect(surfaceLabel("brand_new_surface")).toBe("Brand New Surface");
  });
  it("falls back to 'Unknown' for empty/missing", () => {
    expect(surfaceLabel("")).toBe("Unknown");
    expect(surfaceLabel(null)).toBe("Unknown");
    expect(surfaceLabel(undefined)).toBe("Unknown");
  });
});

describe("aggregateBySurface", () => {
  it("returns {} for empty / non-array input", () => {
    expect(aggregateBySurface([])).toEqual({});
    expect(aggregateBySurface(null)).toEqual({});
    expect(aggregateBySurface(undefined)).toEqual({});
  });

  it("aggregates a single surface", () => {
    const results: RegressionResultLike[] = [
      { surface_kind: "campaign_draft", fidelity_score: 80, severity: "ok" },
      { surface_kind: "campaign_draft", fidelity_score: 60, severity: "ok" },
    ];
    const agg = aggregateBySurface(results);
    expect(agg.campaign_draft.total).toBe(2);
    expect(agg.campaign_draft.scored).toBe(2);
    expect(agg.campaign_draft.errored).toBe(0);
    expect(agg.campaign_draft.meanScore).toBe(70);
  });

  it("excludes error rows from the mean but counts them in total", () => {
    const results: RegressionResultLike[] = [
      { surface_kind: "subject_line", fidelity_score: 90, severity: "ok" },
      { surface_kind: "subject_line", severity: "error" },
      {
        surface_kind: "subject_line",
        fidelity_score: undefined,
        severity: "ok",
      },
    ];
    const agg = aggregateBySurface(results);
    expect(agg.subject_line.total).toBe(3);
    expect(agg.subject_line.scored).toBe(1);
    expect(agg.subject_line.errored).toBe(2);
    expect(agg.subject_line.meanScore).toBe(90);
  });

  it("keeps an all-error surface mean null instead of rendering 0/100", () => {
    const agg = aggregateBySurface([
      { surface_kind: "subject_line", severity: "error" },
      { surface_kind: "subject_line", fidelity_score: Number.NaN },
    ]);
    expect(agg.subject_line).toMatchObject({
      total: 2,
      scored: 0,
      errored: 2,
      meanScore: null,
    });
  });

  it("splits multiple surfaces", () => {
    const results: RegressionResultLike[] = [
      { surface_kind: "campaign_draft", fidelity_score: 50, severity: "warn" },
      { surface_kind: "subject_line", fidelity_score: 100, severity: "ok" },
    ];
    const agg = aggregateBySurface(results);
    expect(Object.keys(agg).sort()).toEqual(["campaign_draft", "subject_line"]);
    expect(agg.campaign_draft.meanScore).toBe(50);
    expect(agg.subject_line.meanScore).toBe(100);
  });

  it("buckets a missing surface_kind under 'unknown' (never throws)", () => {
    const results = [
      { fidelity_score: 70 },
    ] as unknown as RegressionResultLike[];
    const agg = aggregateBySurface(results);
    expect(agg.unknown.total).toBe(1);
    expect(agg.unknown.meanScore).toBe(70);
  });
});

describe("gateLabel / gateTone", () => {
  it("labels outcomes as recorded evaluations, never deployment decisions", () => {
    expect(gateLabel("pass")).toBe("Recorded pass");
    expect(gateLabel("fail")).toBe("Recorded concern");
    expect(gateLabel("advisory")).toBe("Recorded advisory");
    expect(gateLabel(null)).toBe("No policy outcome");
  });
  it("tones gate results", () => {
    expect(gateTone("pass")).toBe("success");
    expect(gateTone("advisory")).toBe("warning");
    expect(gateTone("fail")).toBe("danger");
    expect(gateTone(undefined)).toBe("neutral");
  });
});

describe("summarizeRegressionResults", () => {
  it("uses only finite scored rows in its denominator and mean", () => {
    expect(
      summarizeRegressionResults([
        { surface_kind: "campaign_draft", fidelity_score: 80 },
        { surface_kind: "campaign_draft", severity: "error" },
        { surface_kind: "campaign_draft", fidelity_score: 60 },
      ]),
    ).toEqual({ total: 3, scored: 2, errored: 1, meanScore: 70 });
  });

  it("returns a nullable mean for zero scored rows", () => {
    expect(
      summarizeRegressionResults([
        { surface_kind: "reply_intent", severity: "error" },
      ]),
    ).toEqual({ total: 1, scored: 0, errored: 1, meanScore: null });
  });
});

describe("surfaceReceiptIsCoherent", () => {
  const advisoryPolicy = {
    warn_threshold: 60,
    hard_gate_enabled: false,
    min_examples_for_gate: 5,
  };

  it("accepts scored and all-error server surface receipts", () => {
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 5,
          scored: 4,
          errors: 1,
          passed: 3,
          mean_score: 72,
          gate_result: "advisory",
        },
        advisoryPolicy,
      ),
    ).toBe(true);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 5,
          scored: 3,
          errors: 0,
          passed: 3,
          mean_score: 74,
          gate_result: "advisory",
        },
        advisoryPolicy,
      ),
    ).toBe(true);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 2,
          scored: 0,
          errors: 2,
          passed: 0,
          mean_score: null,
          gate_result: "advisory",
        },
        advisoryPolicy,
      ),
    ).toBe(true);
  });

  it("rejects contradictory counts, boolean gates, and invented zero means", () => {
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 5,
          scored: 4,
          errors: 0,
          passed: 3,
          mean_score: 72,
          gate_result: "pass",
        },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 2,
          scored: 0,
          errors: 2,
          passed: 0,
          mean_score: 0,
          gate_result: "advisory",
        },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 1,
          scored: 1,
          errors: 0,
          passed: 1,
          mean_score: 80,
          gate_result: "true",
        },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 2,
          scored: 1,
          errors: 1,
          passed: 1,
          mean_score: 80,
          gate_result: "fail",
        },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        {
          total: 1,
          scored: 1,
          errors: 0,
          passed: 1,
          mean_score: 101,
          gate_result: "pass",
        },
        advisoryPolicy,
      ),
    ).toBe(false);
  });

  it("rejects gate outcomes that contradict the frozen policy", () => {
    const completed = {
      total: 5,
      scored: 5,
      errors: 0,
      passed: 5,
      mean_score: 72,
    };
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, gate_result: "pass" },
        advisoryPolicy,
      ),
    ).toBe(true);
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, gate_result: "fail" },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, mean_score: 50, gate_result: "pass" },
        advisoryPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, mean_score: 50, gate_result: "advisory" },
        advisoryPolicy,
      ),
    ).toBe(true);

    const hardPolicy = {
      warn_threshold: 60,
      hard_gate_enabled: true,
      hard_gate_threshold: 70,
      min_examples_for_gate: 6,
    };
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, gate_result: "fail" },
        hardPolicy,
      ),
    ).toBe(false);
    expect(
      surfaceReceiptIsCoherent(
        { ...completed, gate_result: "advisory" },
        hardPolicy,
      ),
    ).toBe(true);
  });
});

describe("summarizeRegressionReceipt", () => {
  it("counts only scored and persisted errors as processed", () => {
    expect(
      summarizeRegressionReceipt({
        total_examples: 8,
        scored_examples: 3,
        error_examples: 2,
      }),
    ).toEqual({
      total: 8,
      scored: 3,
      errored: 2,
      processed: 5,
      remaining: 3,
      complete: false,
    });
  });

  it("rejects impossible receipt counts", () => {
    expect(
      summarizeRegressionReceipt({
        total_examples: 2,
        scored_examples: 2,
        error_examples: 1,
      }),
    ).toBeNull();
  });
});

describe("parseFidelityBreakdown", () => {
  it("preserves Voice's historically named stylistic similarity value", () => {
    expect(
      parseFidelityBreakdown(
        {
          embedding_similarity: 0.8,
          stylistic_distance: 0.9,
          vocabulary_overlap: 0.7,
          structural_match: 0.6,
          combined: 82,
        },
        82,
      ),
    ).toEqual({
      embeddingSimilarity: 0.8,
      stylisticMatch: 0.9,
      vocabularyOverlap: 0.7,
      structuralMatch: 0.6,
      combined: 82,
    });
  });

  it("does not infer missing, extra, out-of-range, or mismatched diagnostics", () => {
    expect(parseFidelityBreakdown({ combined: 80 }, 80)).toBeNull();
    expect(
      parseFidelityBreakdown(
        {
          embedding_similarity: 0.8,
          stylistic_distance: 0.9,
          vocabulary_overlap: 0.7,
          structural_match: 0.6,
          combined: 81,
        },
        80,
      ),
    ).toBeNull();
    expect(
      parseFidelityBreakdown(
        {
          embedding_similarity: 1.1,
          stylistic_distance: 0.9,
          vocabulary_overlap: 0.7,
          structural_match: 0.6,
          combined: 80,
        },
        80,
      ),
    ).toBeNull();
  });
});

describe("regression evidence lifecycle", () => {
  const now = Date.parse("2026-08-09T10:00:00.000Z");
  const completed = {
    status: "completed",
    total_examples: 5,
    passed_examples: 4,
    scored_examples: 5,
    error_examples: 0,
    fidelity_score_mean: 78,
    gate_result: "pass",
    warn_threshold: 60,
    hard_gate_enabled: false,
    min_examples_for_gate: 5,
    created_at: "2026-08-09T09:00:00.000Z",
    completed_at: "2026-08-09T09:05:00.000Z",
  };

  it.each([
    ["queued", { status: "pending", created_at: "2026-08-09T09:50:00.000Z" }],
    [
      "running",
      {
        status: "running",
        created_at: "2026-08-09T09:45:00.000Z",
        started_at: "2026-08-09T09:50:00.000Z",
      },
    ],
    ["stale", { status: "pending", created_at: "2026-08-09T09:30:00.000Z" }],
    ["failed", { status: "failed" }],
    ["incomplete", { ...completed, gate_result: undefined }],
    [
      "unscored",
      {
        ...completed,
        passed_examples: 0,
        scored_examples: 0,
        error_examples: 5,
        fidelity_score_mean: undefined,
        gate_result: "advisory",
      },
    ],
    ["completed", completed],
  ] as const)("classifies %s without conflating policy tone", (state, run) => {
    expect(regressionEvidenceState(run, now)).toBe(state);
  });

  it("treats freshness as an elapsed-time observation only", () => {
    const run = {
      status: "running",
      created_at: "2026-08-09T09:00:00.000Z",
      started_at: "2026-08-09T09:50:00.000Z",
    };
    expect(runIsStale(run, now)).toBe(false);
    expect(runIsStale(run, now + 6 * 60 * 1000)).toBe(true);
    expect(evidenceStateLabel("stale")).toBe("Freshness warning");
  });

  it("prefers the server lease receipt and does not age a scheduled retry", () => {
    expect(
      regressionFreshnessReason(
        {
          status: "running",
          started_at: "2026-08-09T09:00:00.000Z",
          lease_expires_at: "2026-08-09T10:01:00.000Z",
        },
        now,
      ),
    ).toBeNull();
    expect(
      regressionFreshnessReason(
        {
          status: "running",
          heartbeat_at: "2026-08-09T09:59:59.000Z",
          lease_expires_at: "2026-08-09T09:59:00.000Z",
        },
        now,
      ),
    ).toBe("server-lease-expired");
    expect(
      regressionFreshnessReason(
        {
          status: "pending",
          created_at: "2026-08-09T08:00:00.000Z",
          retry_not_before: "2026-08-09T10:05:00.000Z",
          stale_at: "2026-08-09T09:59:00.000Z",
        },
        now,
      ),
    ).toBeNull();
    expect(
      regressionEvidenceState(
        {
          status: "pending",
          created_at: "2026-08-09T08:00:00.000Z",
          stale_at: "2026-08-09T09:50:00.000Z",
          updated_at: "2026-08-09T09:50:00.000Z",
        },
        now,
      ),
    ).toBe("queued");
  });

  it("keeps completed lifecycle tone neutral and gate tone separate", () => {
    expect(evidenceStateTone("completed")).toBe("neutral");
    expect(gateTone("fail")).toBe("danger");
  });

  it("requires advisory for persisted errors and rejects a below-minimum hard pass", () => {
    expect(
      regressionEvidenceState(
        {
          ...completed,
          passed_examples: 4,
          scored_examples: 4,
          error_examples: 1,
          gate_result: "pass",
        },
        now,
      ),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        {
          ...completed,
          passed_examples: 4,
          scored_examples: 4,
          error_examples: 1,
          gate_result: "advisory",
        },
        now,
      ),
    ).toBe("completed");
    expect(
      regressionEvidenceState(
        {
          ...completed,
          total_examples: 4,
          passed_examples: 4,
          scored_examples: 4,
          hard_gate_enabled: true,
          hard_gate_threshold: 70,
          min_examples_for_gate: 5,
        },
        now,
      ),
    ).toBe("incomplete");
  });

  it("rejects deterministic gate outcomes that contradict frozen thresholds", () => {
    expect(
      regressionEvidenceState({ ...completed, gate_result: "fail" }, now),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        { ...completed, fidelity_score_mean: 50, gate_result: "pass" },
        now,
      ),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        { ...completed, fidelity_score_mean: 50, gate_result: "advisory" },
        now,
      ),
    ).toBe("completed");

    const hard = {
      ...completed,
      fidelity_score_mean: 69,
      hard_gate_enabled: true,
      hard_gate_threshold: 70,
      min_examples_for_gate: 5,
    };
    expect(regressionEvidenceState({ ...hard, gate_result: "pass" }, now)).toBe(
      "incomplete",
    );
    expect(regressionEvidenceState({ ...hard, gate_result: "fail" }, now)).toBe(
      "completed",
    );
    expect(
      regressionEvidenceState(
        { ...hard, hard_gate_threshold: undefined, gate_result: "fail" },
        now,
      ),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        { ...completed, warn_threshold: Number.NaN },
        now,
      ),
    ).toBe("incomplete");
  });

  it("describes partial and below-minimum advisories as insufficient", () => {
    expect(
      advisoryEvidenceContext({
        gate_result: "advisory",
        total_examples: 5,
        scored_examples: 3,
        error_examples: 1,
        min_examples_for_gate: 5,
      }),
    ).toContain("1 snapshots remain");
    expect(
      advisoryEvidenceContext({
        gate_result: "advisory",
        total_examples: 4,
        scored_examples: 4,
        error_examples: 0,
        hard_gate_enabled: true,
        min_examples_for_gate: 5,
      }),
    ).toContain("below the configured minimum of 5");
    expect(
      advisoryEvidenceContext({
        gate_result: "advisory",
        total_examples: 5,
        scored_examples: 3,
        error_examples: 2,
        min_examples_for_gate: 5,
      }),
    ).toContain("2 persisted error receipts");
  });

  it("rejects impossible and receipt-free completed summaries", () => {
    expect(
      regressionEvidenceState({ ...completed, passed_examples: 6 }, now),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState({ ...completed, error_examples: 1 }, now),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState({ ...completed, fidelity_score_mean: 101 }, now),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        { ...completed, fidelity_score_mean: undefined },
        now,
      ),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState(
        {
          ...completed,
          passed_examples: 0,
          scored_examples: 0,
          error_examples: 5,
          fidelity_score_mean: 0,
          gate_result: "advisory",
        },
        now,
      ),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState({ ...completed, completed_at: undefined }, now),
    ).toBe("incomplete");
    expect(
      regressionEvidenceState({ ...completed, total_examples: 0 }, now),
    ).toBe("incomplete");
  });
});
