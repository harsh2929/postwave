/**
 * subscriberLifecycle — where this contact sits in the funnel.
 *
 *   GET /api/v1/subscribers/{id}/lifecycle → { stage, score, ... }
 *
 * A per-subscriber lifecycle projection has existed server-side with both
 * read AND write, and NO client surfaced it on a profile (desktop's card is
 * the workspace-wide distribution). It is a single enum plus a 1–5 score —
 * exactly the kind of fact a phone reads well and a spreadsheet reads badly.
 *
 * Contract detail worth encoding: a contact with no explicit sidecar row is
 * NOT missing — the server represents it as stage `subscriber`, score 3. So
 * a default must render as the default, never as "unknown".
 *
 * Import-free so the labels and the parse are unit-testable.
 */

export const LIFECYCLE_STAGES = [
  "subscriber",
  "lead",
  "mql",
  "sql",
  "opportunity",
  "customer",
  "evangelist",
  "other",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface SubscriberLifecycle {
  stage: LifecycleStage;
  /** 1–5. The server clamps; we clamp again rather than render a 0 or a 9. */
  score: number;
  updatedAt: string;
}

/** Acronyms must not be title-cased into "Mql". */
const STAGE_LABELS: Record<LifecycleStage, string> = {
  subscriber: "Subscriber",
  lead: "Lead",
  mql: "MQL",
  sql: "SQL",
  opportunity: "Opportunity",
  customer: "Customer",
  evangelist: "Evangelist",
  other: "Other",
};

export function lifecycleStageLabel(stage: LifecycleStage): string {
  return STAGE_LABELS[stage];
}

function isStage(value: unknown): value is LifecycleStage {
  return (
    typeof value === "string" &&
    (LIFECYCLE_STAGES as readonly string[]).includes(value)
  );
}

/**
 * Parse the projection. Returns null only when the payload carries no
 * recognisable stage at all — which is a wire problem, not a default, and
 * the card then renders nothing rather than inventing "Subscriber".
 */
export function parseSubscriberLifecycle(
  raw: unknown,
): SubscriberLifecycle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!isStage(row.stage)) return null;
  const rawScore =
    typeof row.score === "number" && Number.isFinite(row.score)
      ? Math.trunc(row.score)
      : 3;
  return {
    stage: row.stage,
    score: Math.min(5, Math.max(1, rawScore)),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

/**
 * Spoken label. The visible pill is a bare stage name and the score is a
 * "3/5" glyph pair — neither reads as a sentence, and the score has no
 * meaning without its scale.
 */
export function lifecycleSpokenLabel(lifecycle: SubscriberLifecycle): string {
  return `Lifecycle stage: ${lifecycleStageLabel(lifecycle.stage)}. Score ${lifecycle.score} out of 5.`;
}
