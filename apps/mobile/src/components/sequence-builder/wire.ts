/**
 * sequence-builder/wire.ts — the CODEC between the Voice service's wire format
 * and the canvas model the builder renders.
 *
 * Split out of `types.ts` when modelling the nested email/delay/condition
 * union (plus product_event predicates, body_mjml and A/B variants) pushed that
 * file past its source budget. The seam is the right one regardless: `types.ts`
 * is the SHAPE the UI works in, and this file is the translation to and from
 * the shape the server speaks. A round trip through both directions is what the
 * tests assert, and keeping it in one file makes that pairing obvious.
 */
import {
  type CanvasStep,
  type ConditionType,
  type StepType,
  genStepId,
} from "./types";

export type WireStep = import("@/api/sequences").SequenceStepWire;

function delayToSeconds(
  value: number,
  unit: "minutes" | "hours" | "days",
): number {
  if (unit === "minutes") return value * 60;
  if (unit === "hours") return value * 3600;
  return value * 86400;
}

function delayFromSeconds(seconds: number): {
  value: number;
  unit: "minutes" | "hours" | "days";
} {
  if (seconds > 0 && seconds % 86400 === 0) {
    return { value: seconds / 86400, unit: "days" };
  }
  if (seconds > 0 && seconds % 3600 === 0) {
    return { value: seconds / 3600, unit: "hours" };
  }
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
}

/**
 * Canonical predicate for a condition type. `unsupported` re-emits whatever
 * the server sent (`raw`), so viewing a desktop-authored branch on a phone and
 * saving cannot rewrite it into a different condition.
 */
export function predicateFromConditionType(
  type: CanvasStep["condition_type"],
  raw?: string | undefined,
): string {
  switch (type) {
    case "clicked":
      return "clicked_any";
    case "tagged":
      return "tag_present";
    case "custom_property":
      return "custom_property_eq";
    case "product_event":
      return "product_event";
    case "unsupported":
      return raw ?? "";
    default:
      return "opened_previous";
  }
}

/**
 * Decode a wire predicate. Accepts BOTH the v0.3 predicate vocabulary
 * (`opened_previous`, `clicked_any`, …) and the legacy flat `condition_type`
 * vocabulary (`opened`, `clicked`, …) that pre-v0.3 rows still carry.
 * Anything else is reported as `unsupported` rather than guessed at.
 */
export function conditionTypeFromPredicate(
  predicate: string | undefined,
): ConditionType {
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
    case "custom_property_eq":
    case "custom_property":
      return "custom_property";
    case "product_event":
      return "product_event";
    case undefined:
    case "":
      return "opened";
    default:
      return "unsupported";
  }
}

/**
 * Total node count INCLUDING nested condition branches.
 *
 * `steps.length` counts only the top level, so a sequence whose whole body
 * lives inside one condition's yes/no arms reported "1 step". Bounded by an
 * explicit depth ceiling so a cyclic/hostile payload cannot spin the JS
 * thread — the server's own contract nests at most a handful of levels.
 */
export const CANVAS_BRANCH_DEPTH_LIMIT = 8;

export function countCanvasSteps(
  steps: readonly CanvasStep[] | undefined,
  depth = 0,
): number {
  if (!Array.isArray(steps) || depth > CANVAS_BRANCH_DEPTH_LIMIT) return 0;
  let total = 0;
  for (const step of steps) {
    if (!step) continue;
    total += 1;
    total += countCanvasSteps(step.yes_branch, depth + 1);
    total += countCanvasSteps(step.no_branch, depth + 1);
  }
  return total;
}

/**
 * Translate the mobile canvas tree into the Voice service's nested union.
 * Positions are one-based and restart inside each condition branch.
 */
export function canvasToWire(steps: CanvasStep[]): WireStep[] {
  return steps.map((step, index): WireStep => {
    const position = index + 1;
    switch (step.type) {
      case "email":
        return {
          type: "email",
          position,
          email: {
            subject: step.subject ?? "",
            body: step.body ?? "",
            ...(step.body_html !== undefined
              ? { body_html: step.body_html }
              : {}),
            // body_mjml / delay_seconds / variants are DESKTOP-authored fields
            // mobile never edits. They must still survive a round-trip: the
            // PATCH body is a full replace of the steps array, so any field
            // dropped here is destroyed on the server.
            ...(step.body_mjml !== undefined
              ? { body_mjml: step.body_mjml }
              : {}),
            ...(step.email_delay_seconds !== undefined
              ? { delay_seconds: step.email_delay_seconds }
              : {}),
            ...(step.template_id !== undefined
              ? { template_id: step.template_id }
              : {}),
            ...(step.variants !== undefined ? { variants: step.variants } : {}),
          },
        };
      case "delay": {
        const value = step.delay_value ?? 1;
        const unit = step.delay_unit ?? "days";
        return {
          type: "delay",
          position,
          delay: { seconds: delayToSeconds(value, unit), value, unit },
        };
      }
      case "condition":
        return {
          type: "condition",
          position,
          condition: {
            predicate: predicateFromConditionType(
              step.condition_type,
              step.condition_predicate,
            ),
            ...(step.condition_value
              ? { value: step.condition_value }
              : {}),
            yes_branch: canvasToWire(step.yes_branch ?? []),
            no_branch: canvasToWire(step.no_branch ?? []),
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
  });
}

type ReadableWireStep = Partial<WireStep> & {
  id?: string;
  interval_days?: number;
  delay_days?: number;
};

/**
 * Load either the current nested union or a legacy flat email row.
 *
 * Defensive by construction: this walks untrusted server JSON recursively
 * inside render, so a non-array `steps`/`yes_branch`/`no_branch` must degrade
 * to an empty list rather than throw and take the whole screen down.
 */
export function wireToCanvas(
  steps: readonly ReadableWireStep[] | null | undefined,
  depth = 0,
): CanvasStep[] {
  if (!Array.isArray(steps) || depth > CANVAS_BRANCH_DEPTH_LIMIT) return [];
  return steps
    .filter((step): step is ReadableWireStep => Boolean(step))
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((step, index): CanvasStep => {
      const type: StepType =
        step.type ??
        (step.email || step.subject !== undefined ? "email" : "delay");
      const canvas: CanvasStep = {
        id: step.id ?? genStepId(),
        type,
        position: index,
      };

      if (type === "email") decodeEmail(canvas, step);
      else if (type === "delay") decodeDelay(canvas, step);
      else if (type === "condition") decodeCondition(canvas, step, depth);
      else if (type === "tag_add" || type === "tag_remove") {
        canvas.tag = step.tag?.tag ?? "";
      }
      return canvas;
    });
}

/**
 * Email decode, including the desktop-only fields mobile must not destroy.
 *
 * Both the nested v0.3 `email` config AND the legacy FLAT shape are read for
 * every preserved field. The flat shape is not hypothetical: the detail screen
 * seeds its canvas from the sequence's `emails` projection whenever `steps` is
 * empty, and a `GeneratedEmail` row carries `body_mjml`/`delay_seconds` at the
 * top level. Reading those only from `step.email` meant a legacy sequence lost
 * both on the way in — and the server's PATCH sets `Emails = nil` the moment a
 * `steps` array arrives (services/voice/internal/handlers/sequences.go), so
 * there is no projection left to recover them from. Every field EmailConfig can
 * hold has to survive the trip through the canvas.
 */
function decodeEmail(canvas: CanvasStep, step: ReadableWireStep): void {
  const email = step.email;
  canvas.subject = email?.subject ?? step.subject ?? "";
  canvas.body = email?.body ?? step.body ?? step.body_html ?? "";
  const bodyHTML = email?.body_html ?? step.body_html;
  const templateID = email?.template_id ?? step.template_id;
  const bodyMJML = email?.body_mjml ?? step.body_mjml;
  const delaySeconds = email?.delay_seconds ?? step.delay_seconds;
  if (bodyHTML !== undefined) canvas.body_html = bodyHTML;
  if (templateID !== undefined) canvas.template_id = templateID;
  if (bodyMJML !== undefined) canvas.body_mjml = bodyMJML;
  if (delaySeconds !== undefined) canvas.email_delay_seconds = delaySeconds;
  if (Array.isArray(email?.variants)) canvas.variants = email.variants;
}

/** Delay decode across the nested, flat and legacy interval shapes. */
function decodeDelay(canvas: CanvasStep, step: ReadableWireStep): void {
  if (step.delay) {
    const parts =
      typeof step.delay.value === "number" && step.delay.unit
        ? { value: step.delay.value, unit: step.delay.unit }
        : delayFromSeconds(step.delay.seconds);
    canvas.delay_value = parts.value;
    canvas.delay_unit = parts.unit;
    return;
  }
  if (step.delay_value !== undefined) {
    canvas.delay_value = step.delay_value;
    canvas.delay_unit = step.delay_unit ?? "days";
    return;
  }
  canvas.delay_value = step.interval_days ?? step.delay_days ?? 1;
  canvas.delay_unit = "days";
}

/** Condition decode. Recurses into both arms; branch guards live in
 *  `wireToCanvas`, which is what makes a malformed arm render as empty. */
function decodeCondition(
  canvas: CanvasStep,
  step: ReadableWireStep,
  depth: number,
): void {
  const condition = step.condition;
  const predicate = condition?.predicate ?? step.condition_type;
  canvas.condition_type = conditionTypeFromPredicate(predicate);
  if (typeof predicate === "string" && predicate) {
    canvas.condition_predicate = predicate;
  }
  const value = condition?.value ?? step.condition_value;
  if (value !== undefined) canvas.condition_value = value;
  canvas.yes_branch = wireToCanvas(
    condition?.yes_branch ?? step.yes_branch,
    depth + 1,
  );
  canvas.no_branch = wireToCanvas(
    condition?.no_branch ?? step.no_branch,
    depth + 1,
  );
}
