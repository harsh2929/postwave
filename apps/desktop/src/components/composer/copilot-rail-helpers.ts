/**
 * copilot-rail-helpers — pure logic behind composer/CopilotRail.tsx.
 *
 * The rail composes EXISTING AI surfaces (pre-send verdict, Subject
 * Lab, VoiceDriftBanner, InboxRealityBanner) — these helpers cover the
 * bits the rail renders itself: the verdict status palette (mirrors
 * ai/PresendCheckPanel so the two surfaces never disagree on what
 * "warn" looks like), component naming, score formatting, and the
 * can-this-draft-run-checks gate.
 *
 * Kept free of React/DOM so the node-env vitest suite can exercise
 * them directly.
 */

/** Section ids — also used as collapse-state keys. */
export type RailSectionId = "verdict" | "subject" | "voice" | "inbox";

export const RAIL_SECTIONS: {
  id: RailSectionId;
  title: string;
  blurb: string;
}[] = [
  {
    id: "verdict",
    title: "Pre-send verdict",
    blurb: "EQ Score · voice drift · placement in one combined check.",
  },
  {
    id: "subject",
    title: "Subject Lab",
    blurb: "Confidence-scored subject variants against your baseline.",
  },
  {
    id: "voice",
    title: "Voice drift",
    blurb: "How closely the body matches your voice profile.",
  },
  {
    id: "inbox",
    title: "Inbox reality",
    blurb: "Predicted Primary / Promotions / Spam placement.",
  },
];

/**
 * Status → colour token. Mirrors ai/PresendCheckPanel's palette —
 * "error"/"skipped"/unknown render muted, not red, because an
 * unavailable check is an absence, not a failure of the draft.
 */
export function presendStatusColor(s: string | undefined): string {
  if (s === "ok") return "var(--pw-accent)";
  if (s === "warn") return "var(--pw-warning)";
  if (s === "critical") return "var(--pw-danger)";
  return "var(--pw-fg-muted)";
}

/** Status → human label. */
export function presendStatusLabel(s: string | undefined): string {
  if (s === "ok") return "Passing";
  if (s === "warn") return "Caution";
  if (s === "critical") return "Failing";
  if (s === "error") return "Error";
  if (s === "skipped") return "Skipped";
  return "Unknown";
}

/** Wire component name → display name. Unknown names de-snake. */
export function componentDisplayName(name: string | undefined): string {
  if (!name) return "Check";
  if (name === "eq_score") return "EQ Score";
  if (name === "voice_drift") return "Voice drift";
  if (name === "placement") return "Placement";
  if (name === "campaign_assurance") return "Campaign Assurance";
  return name.replace(/_/g, " ");
}

/**
 * Component scores arrive on mixed scales (0..1 fractions AND 0..100
 * integers). Same normalisation PresendCheckPanel applies: >1 renders
 * as-is, ≤1 renders ×100; absent → em dash.
 */
export function formatComponentScore(score: number | undefined | null): string {
  if (score == null || Number.isNaN(score)) return "—";
  return score > 1 ? score.toFixed(0) : (score * 100).toFixed(0);
}

export interface VerdictReadiness {
  ok: boolean;
  /** Honest, actionable reason when not ok. */
  reason?: string;
}

/**
 * POST /presend/verdict requires subject + from + body. Gate the Run
 * button with a reason instead of letting the server 400.
 */
export function verdictReadiness(
  subject: string,
  fromEmail: string,
  bodyHtml: string,
): VerdictReadiness {
  if (!subject.trim()) {
    return { ok: false, reason: "Add a subject line to run the checks." };
  }
  if (!fromEmail.trim()) {
    return { ok: false, reason: "Set a From address to run the checks." };
  }
  if (!bodyHtml.trim()) {
    return { ok: false, reason: "Write a body to run the checks." };
  }
  return { ok: true };
}

/** Subject Lab needs ≥10 chars of seed before Generate enables. */
export const SUBJECT_LAB_MIN_SEED = 10;

export function subjectLabSeedReady(subject: string): boolean {
  return subject.trim().length >= SUBJECT_LAB_MIN_SEED;
}
