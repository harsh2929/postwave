import { describe, expect, it } from "vitest";

import {
  regressionErrorMessage,
  regressionPresentation,
  regressionSpoken,
} from "./aiRegression";

describe("regressionPresentation", () => {
  it("never reports a pass when the harness has never run", () => {
    // GET /runs/latest answers 200 {"run": null} for this case, not a 404.
    const p = regressionPresentation(null);
    expect(p.verdict).toBe("none");
    expect(p.tone).toBe("neutral");
    expect(p.score).toBeNull();
  });

  it("reports an in-flight run as having no verdict yet", () => {
    expect(regressionPresentation({ status: "running" }).verdict).toBe(
      "in_flight",
    );
    expect(regressionPresentation({ status: "pending" }).label).toBe("Queued");
    expect(regressionPresentation({ status: "running" }).score).toBeNull();
  });

  it("separates a broken harness from a failing model", () => {
    const p = regressionPresentation({
      status: "failed",
      error_message: "voice service timeout",
    });
    expect(p.verdict).toBe("harness_failed");
    expect(p.detail).toBe("voice service timeout");
  });

  it("treats advisory as NOT a pass", () => {
    const p = regressionPresentation({
      status: "completed",
      gate_result: "advisory",
      fidelity_score_mean: 91,
      total_examples: 3,
      passed_examples: 3,
    });
    expect(p.verdict).toBe("advisory");
    expect(p.tone).toBe("warning");
    expect(p.detail).toContain("not enough golden examples");
  });

  it("reads pass and fail from the gate, not from the score", () => {
    expect(
      regressionPresentation({
        status: "completed",
        gate_result: "pass",
        fidelity_score_mean: 61.4,
        total_examples: 20,
        passed_examples: 17,
      }),
    ).toMatchObject({
      verdict: "pass",
      tone: "success",
      score: "61 / 100",
      examples: "17 of 20 examples passed",
    });
    expect(
      regressionPresentation({
        status: "completed",
        gate_result: "fail",
        fidelity_score_mean: 99,
      }).verdict,
    ).toBe("fail");
  });

  it("says 'no verdict' for a completed run without a gate result", () => {
    const p = regressionPresentation({ status: "completed" });
    expect(p.verdict).toBe("unknown");
    expect(p.label).toBe("No verdict");
  });

  it("drops a non-numeric score rather than rendering NaN", () => {
    const p = regressionPresentation({
      status: "completed",
      gate_result: "pass",
      fidelity_score_mean: null,
      total_examples: 0,
    });
    expect(p.score).toBeNull();
    expect(p.examples).toBeNull();
  });
});

describe("regressionSpoken", () => {
  it("says the compacted score out loud", () => {
    const p = regressionPresentation({
      status: "completed",
      gate_result: "pass",
      fidelity_score_mean: 80,
      total_examples: 10,
      passed_examples: 9,
    });
    expect(regressionSpoken(p)).toBe(
      "AI regression: Passing. The latest run met the fidelity gate. Mean fidelity 80 / 100. 9 of 10 examples passed.",
    );
  });
});

describe("regressionErrorMessage", () => {
  it("names the reporting scope for a 403", () => {
    expect(regressionErrorMessage(403)).toContain("reporting access");
  });

  it("calls an unmounted harness unavailable", () => {
    expect(regressionErrorMessage(404)).toContain("doesn't run");
  });

  it("falls back to the transport message", () => {
    expect(regressionErrorMessage(500, "boom")).toBe("boom");
    expect(regressionErrorMessage(0)).toBe(
      "Couldn't load the regression status.",
    );
  });
});
