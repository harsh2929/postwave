/**
 * Conversion helpers for AI sequence drafts.
 *
 * POST /api/v1/voice/sequences/draft returns `{name, steps}` where each
 * step is an EMAIL with a `delay_hours` wait relative to the previous
 * one (services/voice/internal/generation/draft.go::DraftStep). The
 * canvas, by contrast, models waits as explicit delay nodes between
 * email nodes — so accepting a draft expands every positive
 * `delay_hours` into a standalone delay step ahead of its email.
 */

import type { SequenceCanvasStep, SequenceDraftStep } from "../../lib/api-client";

/** Mirror of generation.DraftStepCountMax — server 400s above this. */
export const DRAFT_STEP_COUNT_MAX = 10;

/** Mirror of the server's brief cap (draftBriefMaxRunes). */
export const DRAFT_BRIEF_MAX_LENGTH = 8000;

/** Mirror of the server's tone cap (draftToneMaxRunes). */
export const DRAFT_TONE_MAX_LENGTH = 200;

/**
 * Expand an AI draft into the backend canvas-step union accepted by
 * createSequence: each draft email becomes (optional delay node +)
 * email node, with positions renumbered 1..n across the whole flow.
 * Steps are ordered by their draft `position` regardless of array
 * order so a shuffled LLM response can't scramble the flow.
 */
export function draftStepsToCanvasSteps(
  steps: SequenceDraftStep[],
): SequenceCanvasStep[] {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const out: SequenceCanvasStep[] = [];
  for (const s of ordered) {
    const hours = Math.max(0, Math.round(s.delay_hours ?? 0));
    if (hours > 0) {
      const wholeDays = hours % 24 === 0 ? hours / 24 : null;
      out.push({
        type: "delay",
        position: out.length + 1,
        delay:
          wholeDays != null
            ? { seconds: hours * 3600, value: wholeDays, unit: "days" }
            : { seconds: hours * 3600, value: hours, unit: "hours" },
      });
    }
    out.push({
      type: "email",
      position: out.length + 1,
      email: {
        subject: s.subject,
        body: s.body,
        delay_seconds: 0,
      },
    });
  }
  return out;
}

/** Human label for a draft step's wait ("Immediately", "Wait 2 days"). */
export function formatDraftDelay(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  if (h === 0) return "Immediately";
  if (h % 24 === 0) {
    const d = h / 24;
    return `Wait ${d} day${d === 1 ? "" : "s"}`;
  }
  return `Wait ${h} hour${h === 1 ? "" : "s"}`;
}
