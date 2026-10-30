/**
 * sequence-settings.ts — pure logic for the sequence-level settings
 * card (goal / exit criteria + stuck-participant threshold).
 *
 * Server contracts mirrored here:
 *   - goal: services/voice/internal/generation/types.go — kind ∈
 *     conversion|click|open, plus exit_on_goal. Conversion goals are
 *     STORED but never evaluated in this build (no conversion event
 *     source feeds sequences), and exit_on_goal cannot stop engine-side
 *     sends yet — goal-met participants are merely reported with the
 *     `completed_goal` status in the participants view. The caveat
 *     copy below states both limits verbatim-honest.
 *   - stuck_after_days: services/voice/internal/handlers/sequences.go —
 *     integer, 0 (off) .. 365; the stuck report 400s when neither the
 *     sequence setting nor a ?days override is configured. A missing durable
 *     Postgres projection is a retryable 503 dependency failure.
 */

import type { SequenceGoal } from "../../lib/api-client";

export type GoalKind = SequenceGoal["kind"];

/** Dropdown options for the goal-kind select, in render order. */
export const GOAL_KIND_OPTIONS: ReadonlyArray<{
  value: GoalKind;
  label: string;
}> = [
  { value: "open", label: "Opened an email in this sequence" },
  { value: "click", label: "Clicked a link in this sequence" },
  { value: "conversion", label: "Converted (purchase / signup)" },
];

/** Honest caveat rendered under the goal-kind select, per kind. */
export function goalKindCaveat(kind: GoalKind): string {
  switch (kind) {
    case "conversion":
      return (
        "Conversion goals are stored but not yet evaluated — there's no " +
        "conversion event source feeding sequences in this build, so no " +
        "participant will show this goal as met."
      );
    case "open":
      return (
        "Evaluated from opens of this sequence's emails. Participants who " +
        "meet the goal show as “Goal met” in the participants view."
      );
    case "click":
      return (
        "Evaluated from clicks on this sequence's emails. Participants who " +
        "meet the goal show as “Goal met” in the participants view."
      );
  }
}

/** Honest caveat rendered next to the exit_on_goal toggle. */
export const EXIT_ON_GOAL_CAVEAT =
  "Exit on goal can't stop engine-side sends yet — participants who meet " +
  "the goal are reported with the completed_goal status in the " +
  "participants view, but already-scheduled emails may still go out.";

/** Server-side bound on stuck_after_days (sequences.go). */
export const STUCK_AFTER_DAYS_MAX = 365;

/**
 * Parse the stuck-threshold input. Empty string and "0" both mean
 * "off" (the server treats 0 as disabled); anything else must be a
 * whole number of days within 1..365.
 */
export function parseStuckAfterDays(
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: 0 };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > STUCK_AFTER_DAYS_MAX) {
    return {
      ok: false,
      message: `Stuck threshold must be a whole number of days between 0 (off) and ${STUCK_AFTER_DAYS_MAX}.`,
    };
  }
  return { ok: true, value: n };
}

/* ------- stuck-report error classification -------------------------- */

export type StuckErrorKind = "unconfigured" | "unavailable" | "other";

/**
 * Classify a stuck-list error so the panel can render the matching
 * honest state: 400 → no threshold configured; 404 → route absent on an older
 * gateway; 503 and other transient failures → generic retryable error.
 */
export function classifyStuckError(
  error: { status?: number } | undefined,
): StuckErrorKind {
  if (error?.status === 400) return "unconfigured";
  if (error?.status === 404) return "unavailable";
  return "other";
}

export const STUCK_UNCONFIGURED_COPY =
  "Set a threshold first — configure “Mark participants stuck after” in " +
  "the sequence settings above to enable this report.";

export const STUCK_UNAVAILABLE_COPY =
  "This Moosewave server does not expose the stuck-participant report. Upgrade " +
  "the gateway before offering this view.";
