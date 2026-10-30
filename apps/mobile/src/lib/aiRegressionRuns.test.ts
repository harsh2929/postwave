import { describe, expect, it } from "vitest";

import { surfaceKindLabel } from "./aiRegressionAdmin";
import {
  parseRegressionResults,
  parseRegressionRunDetail,
  parseRegressionRuns,
  regressionRunsErrorMessage,
  resultPresentation,
  runHistoryCounts,
  runHistoryTitle,
  runSurfaceLines,
} from "./aiRegressionRuns";

describe("the three wire shapes", () => {
  it("reads the list from its {items} envelope", () => {
    // ListRuns answers {"items": [...]}. Reading it as a bare array — the
    // shape the SIBLING /voice/templates route uses — would empty the screen.
    const runs = parseRegressionRuns({ items: [{ id: "r1" }, { id: "r2" }] });
    expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("reads the single run as a BARE object, not an envelope", () => {
    // GetRun answers the run itself. Looking for `.items` here would render
    // every drill-in as "no evidence".
    expect(parseRegressionRunDetail({ id: "r1", status: "completed" })?.id).toBe(
      "r1",
    );
    expect(parseRegressionRunDetail({ items: [{ id: "r1" }] })).toBeNull();
    expect(parseRegressionRunDetail(null)).toBeNull();
  });

  it("reads the results from their {items} envelope", () => {
    expect(parseRegressionResults({ items: [{ id: "x" }] })).toHaveLength(1);
    expect(parseRegressionResults({})).toEqual([]);
    expect(parseRegressionResults(null)).toEqual([]);
  });

  it("drops runs with no id and survives junk rows", () => {
    const runs = parseRegressionRuns({
      items: [{ id: "keep" }, { id: "  " }, {}, null, 7],
    });
    expect(runs.map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("resultPresentation", () => {
  it("never renders an unscored example as a zero", () => {
    // severity 'error' means the replay produced no output and fidelity_score
    // is NULL. Showing 0 would read as "the model scored 0 on this example".
    const p = resultPresentation(
      {
        id: "e1",
        surface_kind: "subject_line",
        severity: "error",
        fidelity_score: null,
        error_message: "provider timed out",
      },
      0,
      surfaceKindLabel,
    );
    expect(p.score).toBeNull();
    expect(p.errored).toBe(true);
    expect(p.label).toBe("Replay failed");
    expect(p.tone).toBe("danger");
    expect(p.detail).toBe("provider timed out");
  });

  it("treats a missing score as unscored even when severity says otherwise", () => {
    const p = resultPresentation({ severity: "ok" }, 0, surfaceKindLabel);
    expect(p.score).toBeNull();
    expect(p.errored).toBe(true);
  });

  it("maps the four CHECK-constrained severities to distinct readings", () => {
    const tone = (severity: string) =>
      resultPresentation({ severity, fidelity_score: 84 }, 0, surfaceKindLabel);
    expect(tone("ok").tone).toBe("success");
    expect(tone("warn").tone).toBe("warning");
    expect(tone("critical").tone).toBe("danger");
    expect(tone("critical").label).toBe("Critical");
    expect(tone("ok").score).toBe("84 / 100");
    // An unrecognised severity is neutral, not a silent pass.
    expect(tone("brand_new").tone).toBe("neutral");
    expect(tone("brand_new").label).toBe("Not scored");
  });

  it("falls back through error message → brief → an honest blank", () => {
    expect(
      resultPresentation(
        { severity: "warn", fidelity_score: 40, brief: "Write a subject" },
        0,
        surfaceKindLabel,
      ).detail,
    ).toBe("Write a subject");
    expect(
      resultPresentation({ severity: "warn", fidelity_score: 40 }, 0, surfaceKindLabel)
        .detail,
    ).toContain("No brief recorded");
    expect(
      resultPresentation({ severity: "error" }, 0, surfaceKindLabel).detail,
    ).toContain("no output");
  });

  it("keys a row even when the server sent neither id", () => {
    expect(resultPresentation({}, 3, surfaceKindLabel).key).toBe("result-3");
    expect(
      resultPresentation({ example_id: "ex1" }, 3, surfaceKindLabel).key,
    ).toBe("ex1");
  });
});

describe("runSurfaceLines", () => {
  it("counts unscored examples SEPARATELY from failures", () => {
    // errors are missing evidence, not a model failure — the run-level gate
    // treats them that way, so the per-surface line must too.
    const lines = runSurfaceLines(
      {
        by_surface: {
          subject_line: {
            total: 5,
            scored: 4,
            errors: 1,
            passed: 4,
            mean_score: 82.4,
          },
          campaign_draft: { total: 2, scored: 2, errors: 0, passed: 1 },
        },
      },
      surfaceKindLabel,
    );
    expect(lines).toHaveLength(2);
    // Sorted by label: Campaign draft before Subject line.
    expect(lines[0]?.surface).toBe("Campaign draft");
    expect(lines[0]?.summary).toBe("1 of 2 passed");
    expect(lines[0]?.score).toBeNull();
    expect(lines[1]?.summary).toBe("4 of 5 passed · 1 not scored");
    expect(lines[1]?.score).toBe("82 / 100");
  });

  it("answers nothing when the run carries no rollup", () => {
    expect(runSurfaceLines(null, surfaceKindLabel)).toEqual([]);
    expect(runSurfaceLines({}, surfaceKindLabel)).toEqual([]);
    expect(
      runSurfaceLines({ by_surface: [] as never }, surfaceKindLabel),
    ).toEqual([]);
  });
});

describe("run history lines", () => {
  it("leads with the operator's own label, since it is what tells two runs apart", () => {
    expect(runHistoryTitle({ model_version_tag: "v3-canary", model_id: "m" })).toBe(
      "v3-canary",
    );
    expect(runHistoryTitle({ model_id: "m-1" })).toBe("m-1");
    expect(runHistoryTitle({})).toBe("Untitled run");
  });

  it("reports unscored examples in the count line, never hides them", () => {
    expect(runHistoryCounts({ total_examples: 12, error_examples: 3 })).toBe(
      "12 examples · 3 not scored",
    );
    expect(runHistoryCounts({ total_examples: 1 })).toBe("1 example");
    expect(runHistoryCounts({ total_examples: 0 })).toBeNull();
    expect(runHistoryCounts({})).toBeNull();
  });
});

describe("regressionRunsErrorMessage", () => {
  it("separates access, a deleted run and an absent harness", () => {
    expect(regressionRunsErrorMessage(403)).toContain("reporting access");
    expect(regressionRunsErrorMessage(404)).toContain("no longer exists");
    expect(regressionRunsErrorMessage(501)).toContain("doesn't run");
    expect(regressionRunsErrorMessage(500, "boom")).toBe("boom");
    expect(regressionRunsErrorMessage(500, " ")).toContain("Couldn't load");
  });
});
