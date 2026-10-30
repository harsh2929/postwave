// SPDX-License-Identifier: AGPL-3.0-only
//
// A pre-send check exists to tell an operator whether it is safe to send. The
// dangerous state is not a failure — it is a pass that rests on checks which
// never ran.

import { describe, expect, it } from "vitest";

import {
  expectationsUnfounded,
  passingButIncomplete,
  unavailableComponents,
  type PresendVerdict,
  type SubjectScore,
} from "@/lib/preflight-api";

const verdict = (o: Partial<PresendVerdict> = {}): PresendVerdict => ({
  verdict: "pass",
  complete: true,
  summary: "",
  components: [],
  computed_at: "2026-08-22T07:48:30.054913Z",
  ...o,
});

describe("pre-send completeness", () => {
  it("flags a pass that rests on an incomplete run", () => {
    // Everything that executed passed, and some things did not execute. A
    // green badge here would say "safe to send" on the strength of checks
    // that never happened.
    expect(passingButIncomplete(verdict({ verdict: "pass", complete: false }))).toBe(
      true,
    );
  });

  it("does not flag a complete pass", () => {
    expect(passingButIncomplete(verdict({ complete: true }))).toBe(false);
  });

  it("does not flag a critical verdict, complete or not", () => {
    // The live state. An incomplete run that already found a blocking issue
    // is not the misleading case — the issue is real either way.
    expect(
      passingButIncomplete(verdict({ verdict: "critical", complete: false })),
    ).toBe(false);
  });

  it("separates checks that could not run from checks that ran and failed", () => {
    const v = verdict({
      components: [
        { name: "eq_score", status: "critical", score: 44 },
        { name: "voice_drift", status: "error", error: "unavailable" },
        { name: "placement", status: "error", error: "unavailable" },
      ],
    });
    expect(unavailableComponents(v).map((c) => c.name)).toEqual([
      "voice_drift",
      "placement",
    ]);
  });
});

describe("subject expectations", () => {
  const score = (o: Partial<SubjectScore> = {}): SubjectScore => ({
    subject: "Your invoice is ready",
    attributes: {},
    expected_open: 0,
    expected_click: 0,
    matched_history: 0,
    suggestions: [],
    ...o,
  });

  it("treats zero expectations with no matched history as no basis", () => {
    // Not a predicted 0% open rate — nothing resembling this subject line has
    // been sent, so there is nothing to predict from.
    expect(expectationsUnfounded(score())).toBe(true);
  });

  it("treats expectations as founded once history matched", () => {
    expect(
      expectationsUnfounded(score({ matched_history: 12, expected_open: 0.3 })),
    ).toBe(false);
  });

  it("still reports a genuine zero expectation when history exists", () => {
    // History matched and the prediction really is zero. That IS a prediction,
    // and must not be suppressed as "no basis".
    expect(
      expectationsUnfounded(score({ matched_history: 5, expected_open: 0 })),
    ).toBe(false);
  });
});
