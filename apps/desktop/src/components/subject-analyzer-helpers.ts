/**
 * subject-analyzer-helpers — pure logic behind the subject-analyzer
 * wiring in SubjectLab and SubjectLineAssistant.
 *
 * The analyzer (apps/api/internal/subject_analyzer) is a heuristic —
 * NOT LLM-backed — that projects expected open/click from the
 * tenant's own history bucketed by subject attributes. The bucket
 * attribute keys here mirror the Go rollup exactly:
 * length / has_question / has_personalize / has_emoji / all_caps,
 * with boolean buckets serialized as "yes"/"no".
 */

import type {
  SubjectAttrs,
  SubjectBucket,
  SubjectScoreResponse,
} from "../lib/api-client";

/** Attribute key → operator-facing label. Mirrors the Go rollup keys. */
export const SUBJECT_BUCKET_ATTR_LABELS: Record<string, string> = {
  length: "Length",
  has_question: "Question",
  has_personalize: "Personalization",
  has_emoji: "Emoji",
  all_caps: "ALL CAPS",
};

export function bucketAttributeLabel(attribute: string): string {
  return SUBJECT_BUCKET_ATTR_LABELS[attribute] ?? attribute;
}

/** "yes"/"no" buckets read better as Yes/No; length buckets pass through. */
export function bucketValueLabel(bucket: string): string {
  if (bucket === "yes") return "Yes";
  if (bucket === "no") return "No";
  return bucket;
}

/** Percentage formatter for 0..1 rates. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Group the flat bucket rows by attribute, preserving the label
 * table's order so the display is stable across fetches (the server
 * map iteration order is random). Within a group, rows sort by
 * campaign count descending so the dominant bucket leads.
 */
export function groupSubjectBuckets(
  buckets: SubjectBucket[],
): { attribute: string; label: string; rows: SubjectBucket[] }[] {
  const known = Object.keys(SUBJECT_BUCKET_ATTR_LABELS);
  const extra = [...new Set(buckets.map((b) => b.attribute))].filter(
    (a) => !known.includes(a),
  );
  return [...known, ...extra]
    .map((attribute) => ({
      attribute,
      label: bucketAttributeLabel(attribute),
      rows: buckets
        .filter((b) => b.attribute === attribute)
        .sort((a, b) => b.campaigns - a.campaigns),
    }))
    .filter((g) => g.rows.length > 0);
}

/**
 * Human-readable attribute explanation lines for an analyzed subject.
 * Facts only — the score panel renders these next to the projected
 * rates so the operator can see WHY the heuristic matched what it did.
 */
export function explainSubjectAttributes(attrs: SubjectAttrs): string[] {
  const lines: string[] = [
    `${attrs.length} characters (${attrs.length_bucket})`,
    `${attrs.word_count} word${attrs.word_count === 1 ? "" : "s"}`,
  ];
  lines.push(
    attrs.emoji_count > 0
      ? `${attrs.emoji_count} emoji`
      : "No emoji",
  );
  lines.push(attrs.has_question ? "Asks a question" : "No question");
  lines.push(
    attrs.has_personalize ? "Uses personalization" : "No personalization",
  );
  if (attrs.all_caps) lines.push("ALL CAPS");
  return lines;
}

/**
 * One-line summary for inline display next to a candidate subject.
 * `matched_history` of 0 means the projection had nothing to anchor
 * on — flagged so the number isn't mistaken for a real estimate.
 */
export function scoreSummaryLine(score: SubjectScoreResponse): string {
  if (score.matched_history <= 0) {
    return "No matching history — projection unavailable";
  }
  return `~${formatRate(score.expected_open)} open · ~${formatRate(
    score.expected_click,
  )} click · matched ${score.matched_history} campaign${
    score.matched_history === 1 ? "" : "s"
  }`;
}
