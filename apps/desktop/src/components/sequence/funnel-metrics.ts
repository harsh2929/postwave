/**
 * Funnel-row ↔ canvas-step matching.
 *
 * Funnel rows were historically keyed by a flat integer `position`
 * (apps/api/internal/analytics/analytics.go::SequenceFunnel). That key
 * cannot distinguish branch steps: condition branches renumber locally
 * (1..n inside each yes/no branch), so a branch-local position collides
 * with a top-level row.
 *
 * Migration 0367 added a stable `step_id` to sequence_funnel_events and
 * the analytics read side now emits it per row, omitting it for legacy
 * rows. The id encodes the step's path through the flow:
 *
 *   - top-level step at position N            → "pN"
 *   - branch step under a condition           → "<condId>:yes:pN" /
 *                                               "<condId>:no:pN"
 *   - deeper nesting prepends further segments ("p1:yes:p2:no:p1")
 *
 * These helpers build that id for canvas steps and match funnel rows
 * against it, falling back to the legacy position key ONLY for
 * top-level steps (branch steps stay metric-less against legacy rows —
 * a position-keyed lookup there would show another step's numbers).
 */

import type { SequenceFunnel, SequenceFunnelStep } from "../../lib/api-client";

import type { CanvasStep } from "./types";

/**
 * Funnel row plus the `step_id` column added by migration 0367. Local
 * extension over the shared api-client shape: older payloads (and rows
 * written before the migration) simply omit the field.
 */
export type FunnelStepRow = SequenceFunnelStep & { step_id?: string };

/** Funnel step id for a top-level step ("p3"). */
export function topLevelFunnelStepId(position: number): string {
  return `p${position}`;
}

/** Funnel step id for a branch step under a condition ("p3:yes:p1"). */
export function branchFunnelStepId(
  conditionStepId: string,
  branch: "yes" | "no",
  position: number,
): string {
  return `${conditionStepId}:${branch}:p${position}`;
}

/**
 * Find the funnel row for a canvas step.
 *
 * Matching order:
 *   1. exact `step_id` match (new producers — works for top-level AND
 *      branch steps);
 *   2. legacy position match, restricted to rows WITHOUT a step_id and
 *      only when `legacyPosition` is given. Callers pass the top-level
 *      position here and `null` for branch steps, because legacy rows
 *      carry no branch identity — matching them by branch-local
 *      position would surface the wrong step's numbers.
 *
 * [D07-templates-seq-automations#4] `legacyPosition` is the canvas step's
 * 1-based position, but legacy NULL-step_id funnel rows carry a 0-indexed
 * `position` column (sequence_funnel_events; see SEQUENCE-LOOP-ENGINE-
 * CONTRACT.md §A and analytics.recomputePosition, which adds 1 to recover
 * the 1-based value). SequenceFunnel serves that column verbatim, so the
 * legacy branch must subtract 1 to line the two conventions up — matching
 * `=== legacyPosition` shows the NEXT step's numbers on every node.
 */
export function getFunnelMetric(
  funnel: SequenceFunnel | null,
  stepId: string,
  legacyPosition: number | null,
): SequenceFunnelStep | undefined {
  if (!funnel) return undefined;
  const rows = funnel.steps as FunnelStepRow[];
  const byId = rows.find((r) => r.step_id === stepId);
  if (byId) return byId;
  if (legacyPosition == null) return undefined;
  return rows.find((r) => !r.step_id && r.position === legacyPosition - 1);
}

/**
 * Resolve a funnel step id back to the canvas step it points at by
 * walking the encoded path ("p1:yes:p2" → top-level position 1's yes
 * branch, position 2). Returns null for malformed ids or when the
 * canvas no longer has a step at that path (e.g. the flow was edited
 * since the events were written).
 */
export function findStepByFunnelId(
  steps: CanvasStep[],
  stepId: string,
): CanvasStep | null {
  const segments = stepId.split(":");
  let scope = steps;
  let current: CanvasStep | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "yes" || seg === "no") {
      if (!current || current.type !== "condition") return null;
      scope = (seg === "yes" ? current.yes_branch : current.no_branch) ?? [];
      current = null;
      continue;
    }
    if (!/^p\d+$/.test(seg)) return null;
    const position = Number(seg.slice(1));
    current = scope.find((s) => s.position === position) ?? null;
    if (!current) return null;
  }
  return current;
}
