/**
 * listHealth — presentation rules for the server-computed A–F list grade
 * returned by GET /api/v1/lists/{id}/deliverability.
 *
 * A one-character grade is the most glanceable possible signal on a small
 * screen, and mobile showed nothing at all — "which of my lists is
 * rotting?" required a desktop session.
 *
 * Three states, mirroring desktop's ListHealthBadge:
 *   undefined → still loading, render a muted placeholder
 *   null      → the server has no grade for this list, render nothing
 *   "A".."F"  → render the grade
 *
 * Pure + RN-free so it can be unit tested.
 */

export type HealthTone = "success" | "warning" | "danger" | "neutral";

/** Normalise whatever the server sent into a single grade letter, or null. */
export function normalizeGrade(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const letter = value.trim().toUpperCase().charAt(0);
  // `"ABCDF".includes("")` is TRUE, so the empty string must be rejected
  // explicitly or a blank grade renders as a blank pill.
  return letter && "ABCDF".includes(letter) ? letter : null;
}

/**
 * Grade → pill tone. A/B are healthy, C is a warning, D/F need action.
 * The pill always renders the LETTER too, so colour is never the only
 * carrier of the signal.
 */
export function gradeTone(grade: string | null | undefined): HealthTone {
  const letter = normalizeGrade(grade);
  if (letter === "A" || letter === "B") return "success";
  if (letter === "C") return "warning";
  if (letter === "D" || letter === "F") return "danger";
  return "neutral";
}

/** What a screen reader should say instead of a bare letter. */
export function gradeAccessibilityLabel(
  grade: string | null | undefined,
  score?: number | null,
): string {
  const letter = normalizeGrade(grade);
  if (!letter) return "List health not scored";
  const suffix =
    typeof score === "number" && Number.isFinite(score)
      ? `, score ${Math.round(score)} out of 100`
      : "";
  return `List health grade ${letter}${suffix}`;
}

export interface ListHealthSummary {
  grade: string | null;
  score: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
  unsubscribeRate: number | null;
  engagementRate: number | null;
  notes: string[];
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Project the deliverability payload down to what a phone renders. Rates
 * are left in whatever unit the server used — the caller decides — but
 * absent values stay NULL rather than collapsing to 0, because "0% bounce"
 * and "we don't know" are very different facts.
 */
export function normalizeListHealth(res: unknown): ListHealthSummary {
  const row = (res ?? {}) as Record<string, unknown>;
  return {
    grade: normalizeGrade(row.grade),
    score: rate(row.score),
    bounceRate: rate(row.bounce_rate),
    complaintRate: rate(row.complaint_rate),
    unsubscribeRate: rate(row.unsubscribe_rate),
    engagementRate: rate(row.engagement_rate),
    notes: Array.isArray(row.notes)
      ? row.notes.filter((n): n is string => typeof n === "string")
      : [],
  };
}
