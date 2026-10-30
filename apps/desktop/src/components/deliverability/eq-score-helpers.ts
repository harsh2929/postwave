/**
 * eq-score-helpers — pure logic behind the EqScoreLookupCard (#20,
 * POST /api/v1/deliverability/eq-score).
 *
 * Sender authentication and reputation are server-authored; the request only
 * carries draft content plus optional persistence breadcrumbs. The response
 * carries camelCase `skippedSubScores`; these helpers consume that wire shape.
 */

import type { EQScoreResult, EQSubScore } from "../../lib/api-client";

/** Badge class per letter grade (A+/A/B/C/D/F). */
export function gradeBadgeClass(grade: string): string {
  switch (grade) {
    case "A+":
    case "A":
      return "badge success";
    case "B":
      return "badge accent";
    case "C":
      return "badge warning";
    case "D":
    case "F":
      return "badge danger";
    default:
      return "badge";
  }
}

export interface SubScoreRow {
  key: "content" | "auth" | "reputation";
  label: string;
  /** Null when the server listed the bucket in skippedSubScores —
   *  render "not scored", never a fake 0. */
  score: number | null;
  weight: number;
  reasons: EQSubScore["reasons"];
}

/**
 * Sub-score rows honoring `skippedSubScores`: a skipped bucket (e.g.
 * "reputation" for a tenant with no send history) has a meaningless
 * score field on the wire, so we surface null instead.
 */
export function subScoreRows(result: EQScoreResult): SubScoreRow[] {
  const skipped = new Set(result.skippedSubScores ?? []);
  const make = (
    key: SubScoreRow["key"],
    label: string,
    sub: EQSubScore,
  ): SubScoreRow => ({
    key,
    label,
    score: skipped.has(key) ? null : sub.score,
    weight: sub.weight,
    reasons: sub.reasons ?? [],
  });
  return [
    make("content", "Content", result.content),
    make("auth", "Authentication", result.auth),
    make("reputation", "Reputation", result.reputation),
  ];
}

/** Badge class per reason severity (info | warning | fail). */
export function reasonBadgeClass(severity: string): string {
  switch (severity) {
    case "fail":
      return "badge danger";
    case "warning":
      return "badge warning";
    default:
      return "badge";
  }
}

/**
 * Submit gate: the scorer needs a From address (the domain feeds the
 * auth sub-score) and at least one of subject/html to grade content.
 * Mirrors what the handler will accept without returning a useless
 * all-zero grade.
 */
export function canSubmitEqScore(input: {
  from: string;
  subject: string;
  html: string;
}): boolean {
  if (!input.from.trim() || !input.from.includes("@")) return false;
  return input.subject.trim().length > 0 || input.html.trim().length > 0;
}
