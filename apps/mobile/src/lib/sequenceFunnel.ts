/**
 * lib/sequenceFunnel.ts — funnel-row ↔ canvas-step matching for mobile.
 *
 * Ported from apps/desktop/src/components/sequence/funnel-metrics.ts, with one
 * correction that MUST NOT be dropped: the two canvases number steps
 * differently.
 *
 *   desktop  CanvasStep.position is 1-BASED
 *   mobile   CanvasStep.position is 0-BASED (`wireToCanvas` assigns the array
 *            index — see components/sequence-builder/wire.ts)
 *
 * The wire contract is fixed by migration 0367 and is expressed in DESKTOP's
 * numbering: a top-level step at 1-based position N has step id "pN", branch
 * steps are "<condId>:yes:pN" / "<condId>:no:pN", deeper nesting prepends
 * segments. Meanwhile the LEGACY `position` column on `sequence_funnel_events`
 * is 0-indexed. So mobile has to add 1 when building an id and use its own
 * position verbatim for the legacy match. Copying desktop's call sites
 * literally would offset every reading by one step — i.e. confidently show the
 * NEXT step's numbers on every node, which is worse than showing none.
 *
 * A note on what the numbers will be today: NOTHING in this repository writes
 * `sequence_funnel_events` (migration 0367's own header states this — the
 * producers live on the engine side), so every tenant's funnel is currently
 * empty. That is why `funnelSummary` reports `hasData` and the UI says so,
 * rather than drawing a row of confident zeros.
 *
 * Import-free so the matching rules are unit-testable.
 */

/** One row of GET /api/v1/voice/sequences/{id}/funnel. */
export interface FunnelStepRow {
  position: number;
  /** Path-encoded id. Omitted on rows written before migration 0367. */
  step_id?: string;
  reached: number;
  opened: number;
  clicked: number;
  open_rate?: number;
  click_rate?: number;
  dropoff_pct?: number;
  variants?: {
    variant_key: string;
    reached: number;
    opened: number;
    clicked: number;
    open_rate?: number;
    click_rate?: number;
  }[];
}

export interface SequenceFunnelWire {
  sequence_id?: string;
  steps?: FunnelStepRow[];
}

/**
 * Funnel step id for a top-level step, from a MOBILE (0-based) position.
 * `p${position + 1}` — see the module header.
 */
export function topLevelFunnelStepId(mobilePosition: number): string {
  return `p${Math.trunc(mobilePosition) + 1}`;
}

/** Funnel step id for a branch step, from a MOBILE (0-based) position. */
export function branchFunnelStepId(
  conditionStepId: string,
  branch: "yes" | "no",
  mobilePosition: number,
): string {
  return `${conditionStepId}:${branch}:p${Math.trunc(mobilePosition) + 1}`;
}

/**
 * Find the funnel row for a canvas step.
 *
 * Matching order:
 *   1. exact `step_id` (works for top-level AND branch steps);
 *   2. legacy `position`, ONLY for rows without a step_id and ONLY when a
 *      legacy position is supplied. Callers pass the mobile 0-based position
 *      for top-level steps and `null` for branch steps — legacy rows carry no
 *      branch identity, so matching a branch by its branch-local position
 *      would surface a different step's numbers.
 */
export function getFunnelMetric(
  funnel: SequenceFunnelWire | null | undefined,
  stepId: string,
  legacyMobilePosition: number | null,
): FunnelStepRow | undefined {
  const rows = funnel?.steps;
  if (!Array.isArray(rows)) return undefined;
  const byId = rows.find((r) => r?.step_id === stepId);
  if (byId) return byId;
  if (legacyMobilePosition == null) return undefined;
  return rows.find(
    (r) => r && !r.step_id && r.position === legacyMobilePosition,
  );
}

export interface FunnelSummary {
  /** False when the report has no rows at all — nothing has ever enrolled. */
  hasData: boolean;
  entered: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
  /** Largest single-position drop, as a percentage, and where it happened. */
  worstDropoffPct: number;
  worstDropoffPosition: number | null;
}

/**
 * Totals for the strip above the canvas.
 *
 * `entered` is the reach of the FIRST position, not the sum of every row: a
 * subscriber appears once per step they reached, so summing reach would report
 * a four-step sequence as having four times its real audience.
 */
export function funnelSummary(
  funnel: SequenceFunnelWire | null | undefined,
): FunnelSummary {
  const rows = Array.isArray(funnel?.steps) ? funnel.steps.filter(Boolean) : [];
  const empty: FunnelSummary = {
    hasData: false,
    entered: 0,
    opened: 0,
    clicked: 0,
    openRate: 0,
    clickRate: 0,
    worstDropoffPct: 0,
    worstDropoffPosition: null,
  };
  if (rows.length === 0) return empty;

  let firstPosition = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (Number.isFinite(row.position) && row.position < firstPosition) {
      firstPosition = row.position;
    }
  }
  let entered = 0;
  let opened = 0;
  let clicked = 0;
  let worstDropoffPct = 0;
  let worstDropoffPosition: number | null = null;
  for (const row of rows) {
    const reached = safeInt(row.reached);
    if (row.position === firstPosition) entered += reached;
    opened += safeInt(row.opened);
    clicked += safeInt(row.clicked);
    const dropoff =
      typeof row.dropoff_pct === "number" && Number.isFinite(row.dropoff_pct)
        ? row.dropoff_pct
        : 0;
    if (dropoff > worstDropoffPct) {
      worstDropoffPct = dropoff;
      worstDropoffPosition = row.position;
    }
  }
  return {
    hasData: true,
    entered,
    opened,
    clicked,
    openRate: entered > 0 ? (opened / entered) * 100 : 0,
    clickRate: entered > 0 ? (clicked / entered) * 100 : 0,
    worstDropoffPct,
    worstDropoffPosition,
  };
}

/**
 * Spoken form for a step's metrics. A row of three compacted integers says
 * nothing useful to VoiceOver without the nouns attached.
 */
export function funnelMetricSpoken(row: FunnelStepRow): string {
  const reached = safeInt(row.reached);
  const opened = safeInt(row.opened);
  const clicked = safeInt(row.clicked);
  const noun = (n: number, word: string) =>
    `${n} ${n === 1 ? word : `${word}s`}`;
  return `Reached ${noun(reached, "subscriber")}, ${noun(opened, "open")}, ${noun(clicked, "click")}.`;
}

function safeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}
