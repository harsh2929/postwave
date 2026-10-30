/** Pure conversion, validation, and immutable tree helpers for StepCanvas. */

import type {
  SequenceCanvasStep,
  SequenceDetail,
  SequenceStep,
} from "../../lib/api-client";
import {
  type CanvasStep,
  type PaletteDragPayload,
  type StepType,
  genStepId,
} from "./types";

const MAX_PALETTE_DRAG_PAYLOAD_CHARS = 2048;

function isStepType(value: unknown): value is StepType {
  return (
    value === "email" ||
    value === "delay" ||
    value === "condition" ||
    value === "tag_add" ||
    value === "tag_remove" ||
    value === "exit"
  );
}

export function parsePaletteDragPayload(
  raw: string,
): PaletteDragPayload | null {
  if (raw.length > MAX_PALETTE_DRAG_PAYLOAD_CHARS) return null;
  try {
    const payload = JSON.parse(raw) as Partial<PaletteDragPayload>;
    if (payload.source !== "palette" || !isStepType(payload.type)) return null;
    return { source: "palette", type: payload.type };
  } catch {
    return null;
  }
}

export interface ExistingStepDragPayload {
  source: "canvas-step";
  stepId: string;
}

export function parseExistingStepDragPayload(
  raw: string,
): ExistingStepDragPayload | null {
  if (raw.length > MAX_PALETTE_DRAG_PAYLOAD_CHARS) return null;
  try {
    const payload = JSON.parse(raw) as Partial<ExistingStepDragPayload>;
    if (payload.source !== "canvas-step") return null;
    if (typeof payload.stepId !== "string" || payload.stepId.length === 0) {
      return null;
    }
    return { source: "canvas-step", stepId: payload.stepId };
  } catch {
    return null;
  }
}

/* ------- conversion helpers ---------------------------------------- */

function isBackendCanvasStep(step: unknown): step is SequenceCanvasStep {
  return (
    !!step &&
    typeof step === "object" &&
    "type" in step &&
    typeof (step as { type?: unknown }).type === "string"
  );
}

function conditionTypeFromPredicate(
  predicate: string | undefined,
): CanvasStep["condition_type"] {
  switch (predicate) {
    case "opened_previous":
    case "opened":
      return "opened";
    case "clicked_any":
    case "clicked":
      return "clicked";
    case "tag_present":
    case "tagged":
      return "tagged";
    case "product_event":
      return "product_event";
    case "custom_property_eq":
    default:
      return "custom_property";
  }
}

function predicateFromConditionType(
  type: CanvasStep["condition_type"],
): string {
  switch (type) {
    case "opened":
      return "opened_previous";
    case "clicked":
      return "clicked_any";
    case "tagged":
      return "tag_present";
    case "product_event":
      return "product_event";
    case "custom_property":
    default:
      return "custom_property_eq";
  }
}

function backendStepToCanvasStep(step: SequenceCanvasStep): CanvasStep {
  const base = {
    id: genStepId(),
    type: step.type,
    position: step.position,
  };
  switch (step.type) {
    case "email":
      return {
        ...base,
        subject: step.email?.subject ?? "",
        body: step.email?.body ?? step.email?.body_html ?? "",
        body_html: step.email?.body_html,
        template_id: step.email?.template_id,
        // Roadmap A/B split — carried verbatim; the editor owns it.
        variants:
          step.email?.variants && step.email.variants.length > 0
            ? step.email.variants
            : undefined,
      };
    case "delay": {
      const seconds = step.delay?.seconds ?? 0;
      const derived = delaySecondsToParts(seconds);
      return {
        ...base,
        delay_value: step.delay?.value ?? derived.value,
        delay_unit: step.delay?.unit ?? derived.unit,
      };
    }
    case "condition":
      return {
        ...base,
        condition_type: conditionTypeFromPredicate(step.condition?.predicate),
        condition_value: step.condition?.value ?? "",
        yes_branch: (step.condition?.yes_branch ?? []).map(
          backendStepToCanvasStep,
        ),
        no_branch: (step.condition?.no_branch ?? []).map(
          backendStepToCanvasStep,
        ),
      };
    case "tag_add":
    case "tag_remove":
      return { ...base, tag: step.tag?.tag ?? "" };
    case "exit":
      return base;
  }
}

/**
 * Convert full v0.3 `steps[]` when present; otherwise promote legacy
 * `emails[]` into email + delay nodes for older saved rows.
 */
export function storedStepsToCanvasSteps(
  source: Pick<SequenceDetail, "steps" | "emails">,
): CanvasStep[] {
  const stored = source.steps ?? [];
  if (stored.length > 0 && isBackendCanvasStep(stored[0])) {
    return (stored as SequenceCanvasStep[]).map(backendStepToCanvasStep);
  }
  const emails = source.emails ?? (stored as SequenceStep[]);
  const out: CanvasStep[] = [];
  let pos = 1;
  for (const e of emails) {
    const delay = delayFromStep(e);
    if (delay.value > 0) {
      out.push({
        id: genStepId(),
        type: "delay",
        position: pos++,
        delay_value: delay.value,
        delay_unit: delay.unit,
      });
    }
    out.push({
      id: genStepId(),
      type: "email",
      position: pos++,
      subject: e.subject ?? "",
      body: e.body ?? e.body_html ?? "",
      body_html: e.body_html,
    });
  }
  return out;
}

interface DelayParts {
  value: number;
  unit: "minutes" | "hours" | "days";
}

function delayFromStep(s: SequenceStep): DelayParts {
  // Voice service emits `delay_seconds`; legacy desktop typed
  // `interval_days` / `delay_days`. Promote to a friendlier unit.
  const ds = (s as SequenceStep & { delay_seconds?: number }).delay_seconds;
  if (typeof ds === "number" && ds > 0) {
    if (ds % 86400 === 0) return { value: ds / 86400, unit: "days" };
    if (ds % 3600 === 0) return { value: ds / 3600, unit: "hours" };
    return { value: Math.max(1, Math.round(ds / 60)), unit: "minutes" };
  }
  const days = s.interval_days ?? s.delay_days ?? 0;
  return { value: days, unit: "days" };
}

function delaySecondsToParts(seconds: number): DelayParts {
  if (seconds > 0) {
    if (seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
    if (seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
    return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
  }
  return { value: 1, unit: "days" };
}

function delayToSeconds(value: number, unit: DelayParts["unit"]): number {
  switch (unit) {
    case "minutes":
      return value * 60;
    case "hours":
      return value * 3600;
    case "days":
      return value * 86400;
  }
}

function canvasStepToBackendStep(
  step: CanvasStep,
  index: number,
): SequenceCanvasStep {
  const position = index + 1;
  switch (step.type) {
    case "email":
      return {
        type: "email",
        position,
        email: {
          subject: step.subject ?? "",
          body: step.body ?? "",
          body_html: step.body_html,
          delay_seconds: 0,
          template_id: step.template_id,
          // Roadmap A/B split — round-trips additively; omit (rather
          // than send []) when no test is configured.
          variants:
            step.variants && step.variants.length > 0
              ? step.variants
              : undefined,
        },
      };
    case "delay":
      return {
        type: "delay",
        position,
        delay: {
          seconds: delayToSeconds(
            step.delay_value ?? 1,
            step.delay_unit ?? "days",
          ),
          value: step.delay_value ?? 1,
          unit: step.delay_unit ?? "days",
        },
      };
    case "condition":
      return {
        type: "condition",
        position,
        condition: {
          predicate: predicateFromConditionType(step.condition_type),
          value: step.condition_value ?? "",
          yes_branch: (step.yes_branch ?? []).map(canvasStepToBackendStep),
          no_branch: (step.no_branch ?? []).map(canvasStepToBackendStep),
        },
      };
    case "tag_add":
    case "tag_remove":
      return {
        type: step.type,
        position,
        tag: { tag: step.tag ?? "" },
      };
    case "exit":
      return { type: "exit", position };
  }
}

export function canvasStepsToBackendSteps(
  steps: CanvasStep[],
): SequenceCanvasStep[] {
  return steps.map(canvasStepToBackendStep);
}

export function findStepInTree(
  steps: CanvasStep[],
  id: string,
): CanvasStep | null {
  for (const step of steps) {
    if (step.id === id) return step;
    if (step.type === "condition") {
      const yes = findStepInTree(step.yes_branch ?? [], id);
      if (yes) return yes;
      const no = findStepInTree(step.no_branch ?? [], id);
      if (no) return no;
    }
  }
  return null;
}

export function flattenSteps(steps: CanvasStep[]): CanvasStep[] {
  const out: CanvasStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.type === "condition") {
      out.push(...flattenSteps(step.yes_branch ?? []));
      out.push(...flattenSteps(step.no_branch ?? []));
    }
  }
  return out;
}

export function updateStepInTree(
  steps: CanvasStep[],
  nextStep: CanvasStep,
): CanvasStep[] {
  return steps.map((step) => {
    if (step.id === nextStep.id) return nextStep;
    if (step.type !== "condition") return step;
    return {
      ...step,
      yes_branch: updateStepInTree(step.yes_branch ?? [], nextStep),
      no_branch: updateStepInTree(step.no_branch ?? [], nextStep),
    };
  });
}

export function updateBranchInTree(
  steps: CanvasStep[],
  conditionId: string,
  branch: "yes" | "no",
  mutate: (list: CanvasStep[]) => CanvasStep[],
): CanvasStep[] {
  return steps.map((step) => {
    if (step.id === conditionId && step.type === "condition") {
      const key = branch === "yes" ? "yes_branch" : "no_branch";
      return { ...step, [key]: renumberStepTree(mutate(step[key] ?? [])) };
    }
    if (step.type !== "condition") return step;
    return {
      ...step,
      yes_branch: updateBranchInTree(
        step.yes_branch ?? [],
        conditionId,
        branch,
        mutate,
      ),
      no_branch: updateBranchInTree(
        step.no_branch ?? [],
        conditionId,
        branch,
        mutate,
      ),
    };
  });
}

export function deleteStepFromTree(
  steps: CanvasStep[],
  id: string,
): CanvasStep[] {
  return steps
    .filter((step) => step.id !== id)
    .map((step) => {
      if (step.type !== "condition") return step;
      return {
        ...step,
        yes_branch: deleteStepFromTree(step.yes_branch ?? [], id),
        no_branch: deleteStepFromTree(step.no_branch ?? [], id),
      };
    });
}

export function renumberStepTree(steps: CanvasStep[]): CanvasStep[] {
  return steps.map((step, index) => {
    const next: CanvasStep = { ...step, position: index + 1 };
    if (next.type === "condition") {
      next.yes_branch = renumberStepTree(next.yes_branch ?? []);
      next.no_branch = renumberStepTree(next.no_branch ?? []);
    }
    return next;
  });
}

export function renumberSteps(list: CanvasStep[]): CanvasStep[] {
  return list.map((step, index) => ({ ...step, position: index + 1 }));
}

export function buildNewCanvasStep(type: StepType): CanvasStep {
  const base: CanvasStep = { id: genStepId(), type, position: 0 };
  switch (type) {
    case "email":
      return { ...base, subject: "New email", body: "" };
    case "delay":
      return { ...base, delay_value: 1, delay_unit: "days" };
    case "condition":
      return {
        ...base,
        condition_type: "opened",
        condition_value: "",
        yes_branch: [],
        no_branch: [],
      };
    case "tag_add":
    case "tag_remove":
      return { ...base, tag: "" };
    case "exit":
      return base;
  }
}

export function insertCanvasStep(
  list: CanvasStep[],
  index: number,
  step: CanvasStep,
): CanvasStep[] {
  const copy = [...list];
  copy.splice(index, 0, step);
  return renumberSteps(copy);
}
