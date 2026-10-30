/**
 * Step canvas types for the visual sequence builder.
 *
 * These shapes are owned by the desktop UI. They map onto the backend
 * Sequence shape (services/voice/internal/generation/types.go). The
 * Voice service now persists ALL six step types — email, delay,
 * condition (with two branches), tag_add, tag_remove, exit — via the
 * Sequence.Steps array, in addition to the legacy emails-only path.
 * The PATCH handler at /api/v1/voice/sequences/{id} accepts either
 * `emails` (legacy) or `steps` (v0.3+) and rejects mixed requests.
 */
import type { SequenceEmailVariant } from "../../lib/api-client";
import type { IconName } from "../Icon";

export type StepType =
  | "email"
  | "delay"
  | "condition"
  | "tag_add"
  | "tag_remove"
  | "exit";

/** A node on the canvas. `id` is a stable client-side identifier. */
export interface CanvasStep {
  id: string;
  type: StepType;
  position: number;
  // Email-specific
  subject?: string;
  body?: string;
  body_html?: string;
  template_id?: string;
  /**
   * Optional A/B arms for this email step (roadmap addition). When
   * present: 2..4 arms, weight_bp summing to exactly 10000 — see
   * variants.ts for the mirrored validation. Assignment is a pure
   * deterministic hash server-side. Per-arm open/click stats DO exist
   * (analytics funnel FunnelStep.variants) and render on the step node.
   */
  variants?: SequenceEmailVariant[];
  // Delay-specific
  delay_value?: number;
  delay_unit?: "minutes" | "hours" | "days";
  // Condition-specific
  condition_type?:
    | "opened"
    | "clicked"
    | "tagged"
    | "custom_property"
    | "product_event";
  condition_value?: string;
  // Two child branches for conditions; each holds its own ordered steps.
  yes_branch?: CanvasStep[];
  no_branch?: CanvasStep[];
  // Tag-specific
  tag?: string;
}

/**
 * What the StepPalette emits via dataTransfer when a tile is dragged.
 * Encoded as `application/x-postwave-step` JSON.
 */
export interface PaletteDragPayload {
  source: "palette";
  type: StepType;
}

/** Drop position descriptor used by StepCanvas when a tile lands. */
export type DropTarget =
  | { kind: "before"; targetId: string }
  | { kind: "after"; targetId: string }
  | { kind: "end" }
  | { kind: "branch-end"; conditionId: string; branch: "yes" | "no" }
  | { kind: "branch-before"; conditionId: string; branch: "yes" | "no"; targetId: string };

export const STEP_DRAG_MIME = "application/x-postwave-step";

export type CanvasStepMoveTarget =
  | { kind: "before"; targetId: string }
  | { kind: "after"; targetId: string }
  | { kind: "end" };

function renumberTopLevelSteps(steps: CanvasStep[]): CanvasStep[] {
  return steps.map((step, index) => ({ ...step, position: index + 1 }));
}

export function moveCanvasStep(
  steps: CanvasStep[],
  stepId: string,
  target: CanvasStepMoveTarget,
): CanvasStep[] {
  const from = steps.findIndex((step) => step.id === stepId);
  if (from < 0) return steps;

  let insertIndex = steps.length;
  if (target.kind !== "end") {
    const targetIndex = steps.findIndex((step) => step.id === target.targetId);
    if (targetIndex < 0 || target.targetId === stepId) return steps;
    insertIndex = target.kind === "before" ? targetIndex : targetIndex + 1;
  }

  const copy = [...steps];
  const [moved] = copy.splice(from, 1);
  if (!moved) return steps;
  if (from < insertIndex) insertIndex -= 1;
  insertIndex = Math.max(0, Math.min(insertIndex, copy.length));
  if (insertIndex === from) return steps;

  copy.splice(insertIndex, 0, moved);
  return renumberTopLevelSteps(copy);
}

/** Human-readable label for a step type. */
export function stepTypeLabel(t: StepType): string {
  switch (t) {
    case "email":
      return "Email";
    case "delay":
      return "Delay";
    case "condition":
      return "Condition";
    case "tag_add":
      return "Add tag";
    case "tag_remove":
      return "Remove tag";
    case "exit":
      return "Exit";
  }
}

/** Stroke-icon (Icon.tsx) name for a step type — replaces the old
 * single-letter glyphs (M/T/?/+/−/⌧) on both the node and the palette. */
export function stepTypeIcon(t: StepType): IconName {
  switch (t) {
    case "email":
      return "mail";
    case "delay":
      return "clock";
    case "condition":
      return "git-branch";
    case "tag_add":
      return "plus";
    case "tag_remove":
      return "minus";
    case "exit":
      return "log-out";
  }
}

/** Single-line summary shown on a node card. */
export function stepSummary(s: CanvasStep): string {
  switch (s.type) {
    case "email":
      return s.subject ? `Subject: ${s.subject}` : "(no subject)";
    case "delay": {
      const v = s.delay_value ?? 0;
      const u = s.delay_unit ?? "days";
      return `Wait ${v} ${u}`;
    }
    case "condition": {
      const t = s.condition_type ?? "opened";
      const v = s.condition_value ?? "previous email";
      switch (t) {
        case "opened":
          return `If opened ${v || "previous email"}`;
        case "clicked":
          return `If clicked ${v || "any link"}`;
        case "tagged":
          return `If tagged "${v}"`;
        case "custom_property":
          return `If ${v || "property matches"}`;
        case "product_event":
          return `When event "${v || "event"}" fires`;
      }
      return "Condition";
    }
    case "tag_add":
      return s.tag ? `Add tag: ${s.tag}` : "Add tag…";
    case "tag_remove":
      return s.tag ? `Remove tag: ${s.tag}` : "Remove tag…";
    case "exit":
      return "Planned sequence exit";
  }
}

/** Lookup table of which types are persisted by the current backend. */
export function isBackendPersistable(t: StepType): boolean {
  // All six step types now round-trip through the Voice service.
  // services/voice/internal/generation/types.go declares the union;
  // the PATCH handler validates branches recursively before persisting.
  // (See the round-trip test in
  // services/voice/internal/handlers/sequences_test.go.)
  switch (t) {
    case "email":
    case "delay":
    case "condition":
    case "tag_add":
    case "tag_remove":
    case "exit":
      return true;
  }
}

/** Generate a unique-enough client id for a freshly-created node. */
export function genStepId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}
