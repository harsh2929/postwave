/**
 * step-persist.ts — the canvas persist gate, as pure logic.
 *
 * The Voice service validates the WHOLE `steps[]` array on every PATCH
 * (services/voice/internal/handlers/sequences.go): one malformed step —
 * including legacy server data the user never touched, e.g. an email
 * with an A/B split whose weights don't sum to 100% — 400s the entire
 * save. The canvas therefore refuses to PATCH until every step is
 * persistable, but a SILENT refusal blocks all saves with no feedback.
 *
 * Kept in a plain .ts module (no JSX) so the node-environment vitest
 * suite can exercise the predicate and the culprit-finder directly,
 * mirroring the convention of variants.ts / funnel-metrics.ts.
 */

import type { CanvasStep } from "./types";
import { stepTypeLabel } from "./types";
import { variantsAreValid } from "./variants";

/**
 * Can this single step be PATCHed as-is? Mirrors the server's per-step
 * validation. Recurses into condition branches. An email with an empty
 * subject, a malformed variant split, a zero-length delay, a blank tag,
 * or a condition with an invalid child all return false.
 */
export function canPersistStep(step: CanvasStep): boolean {
  switch (step.type) {
    case "email":
      // A malformed variant split would 400 the whole steps PATCH —
      // hold off persisting until the editor produces a valid one
      // (mirrors the server's ValidateVariants; empty/absent is fine).
      return (
        (step.subject ?? "").trim().length > 0 &&
        variantsAreValid(step.variants)
      );
    case "delay":
      return (step.delay_value ?? 0) > 0;
    case "condition":
      return (
        !!step.condition_type &&
        (step.yes_branch ?? []).every(canPersistStep) &&
        (step.no_branch ?? []).every(canPersistStep)
      );
    case "tag_add":
    case "tag_remove":
      return (step.tag ?? "").trim().length > 0;
    case "exit":
      return true;
  }
}

/** True when every step (recursively) is persistable. */
export function canPersistSteps(steps: CanvasStep[]): boolean {
  return steps.every(canPersistStep);
}

/**
 * Depth-first search for the FIRST step that blocks persistence,
 * descending into condition branches so a culprit buried inside a
 * branch is still found. Returns null when every step is persistable.
 */
export function findUnpersistableStep(steps: CanvasStep[]): CanvasStep | null {
  for (const step of steps) {
    if (step.type === "condition") {
      // A condition itself is unpersistable only via its branches /
      // missing type; check the type first, then recurse so the
      // reported culprit is the deepest concrete offender.
      if (!step.condition_type) return step;
      const inYes = findUnpersistableStep(step.yes_branch ?? []);
      if (inYes) return inYes;
      const inNo = findUnpersistableStep(step.no_branch ?? []);
      if (inNo) return inNo;
      continue;
    }
    if (!canPersistStep(step)) return step;
  }
  return null;
}

/** A short human label for a step in operator-facing copy. Prefers the
 *  email subject (what the user recognises), else the type label. */
export function stepDisplayName(step: CanvasStep): string {
  if (step.type === "email") {
    const subject = (step.subject ?? "").trim();
    if (subject) return `"${subject}"`;
  }
  return `The ${stepTypeLabel(step.type).toLowerCase()} step`;
}

/**
 * Why a step can't be saved, in operator-facing copy. The variant case
 * is called out specifically because it's the surprising one — legacy
 * server data with a bad split blocks saves on steps the user never
 * touched. Returns null for a step that CAN persist.
 */
export function persistBlockReason(step: CanvasStep): string | null {
  if (canPersistStep(step)) return null;
  const name = stepDisplayName(step);
  switch (step.type) {
    case "email":
      if (!variantsAreValid(step.variants)) {
        return `${name} has variant weights that don't sum to 100% — fix it before saving.`;
      }
      return `${name} needs a subject before it can be saved.`;
    case "delay":
      return `${name} needs a wait longer than zero before it can be saved.`;
    case "condition":
      return `${name} is missing its condition — set it before saving.`;
    case "tag_add":
    case "tag_remove":
      return `${name} needs a tag name before it can be saved.`;
    case "exit":
      // Exit steps always persist; unreachable given the guard above.
      return null;
  }
}
