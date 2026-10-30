/**
 * EQ score lookup card pure logic (#20). The load-bearing contracts:
 *
 *   1. subScoreRows honors the camelCase `skippedSubScores` wire field
 *      — a skipped bucket renders null ("not scored"), NEVER the
 *      meaningless score the wire happens to carry;
 *   2. gradeBadgeClass covers the full A+..F ladder;
 *   3. canSubmitEqScore mirrors what the scorer can meaningfully grade
 *      (From address + at least one of subject/html).
 */

import { describe, expect, it } from "vitest";

import {
  canSubmitEqScore,
  gradeBadgeClass,
  reasonBadgeClass,
  subScoreRows,
} from "../../components/deliverability/eq-score-helpers";
import type { EQScoreResult } from "../../lib/api-client";

function result(overrides: Partial<EQScoreResult> = {}): EQScoreResult {
  const sub = (score: number) => ({ score, weight: 0.4, reasons: [] });
  return {
    score: 82,
    grade: "B",
    content: sub(80),
    auth: sub(90),
    reputation: sub(0),
    reasons: [],
    skippedSubScores: [],
    ...overrides,
  };
}

describe("subScoreRows — skippedSubScores honesty", () => {
  it("returns the three buckets in order with real scores", () => {
    const rows = subScoreRows(result());
    expect(rows.map((r) => r.key)).toEqual([
      "content",
      "auth",
      "reputation",
    ]);
    expect(rows[0]?.score).toBe(80);
    expect(rows[2]?.score).toBe(0);
  });

  it("nulls the score of a skipped bucket (wire value is meaningless)", () => {
    const rows = subScoreRows(
      result({ skippedSubScores: ["reputation"] }),
    );
    expect(rows[2]?.score).toBeNull();
    expect(rows[0]?.score).toBe(80); // others untouched
  });

  it("tolerates a missing skippedSubScores array", () => {
    const r = result();
    delete (r as Partial<EQScoreResult>).skippedSubScores;
    expect(subScoreRows(r)[2]?.score).toBe(0);
  });
});

describe("gradeBadgeClass — full ladder", () => {
  it("maps every grade the scorer emits", () => {
    expect(gradeBadgeClass("A+")).toBe("badge success");
    expect(gradeBadgeClass("A")).toBe("badge success");
    expect(gradeBadgeClass("B")).toBe("badge accent");
    expect(gradeBadgeClass("C")).toBe("badge warning");
    expect(gradeBadgeClass("D")).toBe("badge danger");
    expect(gradeBadgeClass("F")).toBe("badge danger");
  });

  it("unknown grades stay neutral", () => {
    expect(gradeBadgeClass("Z")).toBe("badge");
  });
});

describe("reasonBadgeClass", () => {
  it("fail → danger, warning → warning, info → neutral", () => {
    expect(reasonBadgeClass("fail")).toBe("badge danger");
    expect(reasonBadgeClass("warning")).toBe("badge warning");
    expect(reasonBadgeClass("info")).toBe("badge");
  });
});

describe("canSubmitEqScore — submit gate", () => {
  it("requires a plausible From address", () => {
    expect(canSubmitEqScore({ from: "", subject: "Hi", html: "" })).toBe(
      false,
    );
    expect(
      canSubmitEqScore({ from: "not-an-email", subject: "Hi", html: "" }),
    ).toBe(false);
  });

  it("requires at least one of subject / html", () => {
    expect(
      canSubmitEqScore({ from: "a@b.com", subject: "", html: "" }),
    ).toBe(false);
    expect(
      canSubmitEqScore({ from: "a@b.com", subject: "  ", html: " " }),
    ).toBe(false);
  });

  it("passes with from + subject, or from + html", () => {
    expect(
      canSubmitEqScore({ from: "a@b.com", subject: "Hi", html: "" }),
    ).toBe(true);
    expect(
      canSubmitEqScore({ from: "a@b.com", subject: "", html: "<p>x</p>" }),
    ).toBe(true);
  });
});
