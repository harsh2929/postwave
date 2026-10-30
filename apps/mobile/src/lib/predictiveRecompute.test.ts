/**
 * The recompute's result contract, pinned against `RunResult`
 * (apps/api/internal/predictive/predictive.go:106) and `ModelRun` (:75).
 *
 * The rule under test everywhere here: the sentence an admin reads after
 * pressing the button is assembled ONLY from numbers the server sent. A count
 * the payload did not carry is omitted, never printed as zero — and a zero the
 * payload DID carry is printed, because "recomputed" without a count is how a
 * reader concludes coverage improved when the run had nothing to score.
 */
import { describe, expect, it } from "vitest";

import {
  RECOMPUTE_ROLE_NOTE,
  parseRunResult,
  recomputeFailureCopy,
  runErrorText,
  runResultSummary,
  runWindowNote,
} from "./predictiveRecompute";

const RESULT = {
  run: {
    id: "run-1",
    model_key: "predictive_profile_suite",
    model_version: "heuristic-v1",
    status: "completed",
    input_window_days: 365,
    scored_profiles: 1284,
    insufficient_profiles: 907,
    error: "",
    completed_at: "2026-09-03T08:00:00Z",
  },
  predictions: 1284,
  rfm_scores: 1284,
};

describe("parseRunResult", () => {
  it("reads the run row and both write counts", () => {
    expect(parseRunResult(RESULT)).toEqual({
      run: {
        status: "completed",
        modelVersion: "heuristic-v1",
        windowDays: 365,
        scoredProfiles: 1284,
        insufficientProfiles: 907,
        completedAt: "2026-09-03T08:00:00Z",
        error: "",
      },
      predictions: 1284,
      rfmScores: 1284,
    });
  });

  it("never throws on a payload it cannot read", () => {
    for (const raw of [null, undefined, 4, "no", [], { run: 7 }]) {
      const parsed = parseRunResult(raw);
      expect(parsed.run.status).toBe("");
      expect(parsed.predictions).toBeNull();
    }
  });

  it("keeps an unreported count NULL rather than reading it as zero", () => {
    const parsed = parseRunResult({ run: { status: "completed" } });
    expect(parsed.run.scoredProfiles).toBeNull();
    expect(parsed.rfmScores).toBeNull();
  });
});

describe("runResultSummary", () => {
  it("states the server's status and every count it sent", () => {
    const line = runResultSummary(parseRunResult(RESULT));
    expect(line).toContain("Run completed");
    expect(line).toContain("1,284 profiles scored");
    expect(line).toContain("907 with too little data");
    expect(line).toContain("1,284 predictions written");
    expect(line).toContain("1,284 RFM scores written");
  });

  it("prints a REPORTED zero — a run that scored nothing must say so", () => {
    const line = runResultSummary(
      parseRunResult({
        run: { status: "completed", scored_profiles: 0 },
        predictions: 0,
        rfm_scores: 0,
      }),
    );
    expect(line).toContain("0 profiles scored");
  });

  it("omits a count the payload never carried instead of inventing 0", () => {
    const line = runResultSummary(
      parseRunResult({ run: { status: "completed", scored_profiles: 12 } }),
    );
    expect(line).toContain("12 profiles scored");
    expect(line).not.toContain("predictions");
    expect(line).not.toContain("RFM");
  });

  it("says the run returned no counts rather than claiming a result", () => {
    expect(runResultSummary(parseRunResult({ run: { status: "failed" } }))).toBe(
      "The run reported failed and returned no counts.",
    );
  });
});

describe("run provenance", () => {
  it("names the history window and model the server reported", () => {
    expect(runWindowNote(parseRunResult(RESULT))).toBe(
      "Read 365 days of history · model heuristic-v1.",
    );
  });

  it("says nothing about a window the run did not report", () => {
    expect(runWindowNote(parseRunResult({ run: {} }))).toBeNull();
  });

  it("surfaces the server's own error string, verbatim", () => {
    expect(
      runErrorText(
        parseRunResult({ run: { status: "completed", error: "clv fit skipped" } }),
      ),
    ).toBe("clv fit skipped");
    expect(runErrorText(parseRunResult(RESULT))).toBeNull();
  });
});

describe("recomputeFailureCopy", () => {
  it("reads a 403 as the admin-only RULE the manifest states, not a fault", () => {
    const denied = Object.assign(new Error("forbidden"), { status: 403 });
    expect(recomputeFailureCopy(denied)).toBe(RECOMPUTE_ROLE_NOTE);
  });

  it("sends an expired session to sign-in instead of to an admin", () => {
    const expired = Object.assign(new Error("unauthorized"), { status: 401 });
    expect(recomputeFailureCopy(expired)).toContain("session expired");
  });

  it("keeps the server's message for anything else, and never renders empty", () => {
    expect(
      recomputeFailureCopy(Object.assign(new Error("db down"), { status: 500 })),
    ).toBe("db down");
    expect(recomputeFailureCopy(null)).toBe("Couldn't recompute the model.");
  });
});
