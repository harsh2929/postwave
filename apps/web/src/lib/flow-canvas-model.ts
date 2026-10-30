// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure step-graph operations behind the sequence canvas on
// /app/sequences/[id]. Desktop parity rows automation-63/64/65/67/68/71; the
// desktop reference is apps/desktop/src/components/sequence/{StepCanvas.tsx,
// step-canvas-helpers.ts, variants.ts, step-persist.ts}.
//
// The server contract is services/voice/internal/handlers/sequence_validation.go
// and generation/variants.go. PATCH /api/v1/voice/sequences/{id} REPLACES the
// whole `steps` tree, validates it recursively (at most 100 nodes, nesting at
// most 3 deep, positions unique within each slice) and 400s the entire write
// when one step is malformed. So every operation here is immutable, touches one
// slice, and renumbers that slice 1..n — the same shape the desktop canvas
// sends — and the validators below mirror the server's rules so the canvas can
// hold an unsaveable change locally instead of firing a request that must fail.
//
// Addressing is by path, not by client id: the stored step union has no id
// field and the server decodes strictly, so a client id could never ride along
// in the PATCH body. A slice is reached by the chain of (condition index,
// branch) hops from the top level; `[]` is the top level itself.

import { apiErrorMessage, isApiError, isOfflineQueuedError } from "./api";
import type {
  Sequence,
  SequenceEmail,
  SequenceEmailVariant,
  SequenceStoredStep,
} from "./voice-types";

export type StepKind = SequenceStoredStep["type"];
export type BranchSide = "yes" | "no";

export interface BranchHop {
  /** Index of the condition step inside its parent slice. */
  index: number;
  branch: BranchSide;
}

export type SlicePath = readonly BranchHop[];

export interface StepAddress {
  slice: SlicePath;
  index: number;
}

/** Mirrors services/voice sequenceMaxNodes. */
export const MAX_CANVAS_STEPS = 100;
/** Mirrors services/voice sequenceMaxDepth (the top level is depth 1). */
export const MAX_CANVAS_DEPTH = 3;
/** Mirrors services/voice sequenceMaxDelaySeconds (365 days). */
export const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;
const MAX_SUBJECT_CHARS = 255;
const MAX_TAG_CHARS = 128;
const MAX_CONDITION_VALUE_CHARS = 512;

export const STEP_KINDS: readonly StepKind[] = [
  "email",
  "delay",
  "condition",
  "tag_add",
  "tag_remove",
  "exit",
];

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  email: "Email",
  delay: "Delay",
  condition: "Condition",
  tag_add: "Add tag",
  tag_remove: "Remove tag",
  exit: "Exit",
};

export type DelayUnit = "minutes" | "hours" | "days";

export const DELAY_UNIT_SECONDS: Record<DelayUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

export interface ConditionPredicate {
  value: string;
  label: string;
  /** The server 400s these predicates without an argument. */
  needsValue: boolean;
  valueHint?: string;
}

/** The five predicates services/voice accepts (sequenceConditionPredicates). */
export const CONDITION_PREDICATES: readonly ConditionPredicate[] = [
  {
    value: "opened_previous",
    label: "Opened previous email",
    needsValue: false,
  },
  { value: "clicked_any", label: "Clicked any link", needsValue: false },
  {
    value: "tag_present",
    label: "Has tag",
    needsValue: true,
    valueHint: "Tag name",
  },
  {
    value: "custom_property_eq",
    label: "Custom property equals",
    needsValue: true,
    valueHint: "key:value",
  },
  {
    value: "product_event",
    label: "Product event fired",
    needsValue: true,
    valueHint: "Event name",
  },
];

/** dataTransfer type for palette tiles and step drag handles. */
export const STEP_DRAG_MIME = "application/x-postwave-step";
const MAX_DRAG_PAYLOAD_CHARS = 2048;

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

/**
 * A fresh step of `kind`. Email, tag and (argument-taking) condition steps
 * start incomplete on purpose — the editor opens on them, and the canvas
 * keeps them local until {@link findBlockingStep} clears.
 */
export function newStep(kind: StepKind): SequenceStoredStep {
  switch (kind) {
    case "email":
      return { type: "email", position: 0, email: { subject: "", body: "" } };
    case "delay":
      return {
        type: "delay",
        position: 0,
        delay: { seconds: DELAY_UNIT_SECONDS.days, value: 1, unit: "days" },
      };
    case "condition":
      return {
        type: "condition",
        position: 0,
        condition: {
          predicate: "opened_previous",
          yes_branch: [],
          no_branch: [],
        },
      };
    case "tag_add":
    case "tag_remove":
      return { type: kind, position: 0, tag: { tag: "" } };
    case "exit":
      return { type: "exit", position: 0 };
  }
}

function plural(value: number, unit: string): string {
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${value} ${value === 1 ? singular : unit}`;
}

/** One-line description of a step as it reads on a canvas node. */
export function stepSummary(step: SequenceStoredStep): string {
  switch (step.type) {
    case "email": {
      const subject = step.email.subject?.trim() || "(no subject)";
      const arms = Array.isArray(step.email.variants)
        ? step.email.variants.length
        : 0;
      return arms > 0 ? `${subject} · A/B ${arms} variants` : subject;
    }
    case "delay": {
      const unit = step.delay.unit;
      if (unit && step.delay.value)
        return `Wait ${plural(step.delay.value, unit)}`;
      const seconds = step.delay.seconds;
      if (seconds % DELAY_UNIT_SECONDS.days === 0) {
        return `Wait ${plural(seconds / DELAY_UNIT_SECONDS.days, "days")}`;
      }
      if (seconds % DELAY_UNIT_SECONDS.hours === 0) {
        return `Wait ${plural(seconds / DELAY_UNIT_SECONDS.hours, "hours")}`;
      }
      return `Wait ${plural(Math.max(1, Math.round(seconds / 60)), "minutes")}`;
    }
    case "condition": {
      const predicate = CONDITION_PREDICATES.find(
        (p) => p.value === step.condition.predicate,
      );
      const label = predicate?.label ?? "Condition";
      const value = step.condition.value?.trim();
      return value
        ? `If ${label.toLowerCase()}: ${value}`
        : `If ${label.toLowerCase()}`;
    }
    case "tag_add":
      return step.tag.tag?.trim()
        ? `Add tag: ${step.tag.tag.trim()}`
        : "Add tag…";
    case "tag_remove":
      return step.tag.tag?.trim()
        ? `Remove tag: ${step.tag.tag.trim()}`
        : "Remove tag…";
    case "exit":
      return "End the journey";
  }
}

export function isStepKind(value: unknown): value is StepKind {
  return (
    typeof value === "string" &&
    (STEP_KINDS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* Tree access                                                         */
/* ------------------------------------------------------------------ */

function branchList(
  step: SequenceStoredStep | undefined,
  side: BranchSide,
): SequenceStoredStep[] {
  if (!step || step.type !== "condition") return [];
  const list =
    side === "yes" ? step.condition.yes_branch : step.condition.no_branch;
  return Array.isArray(list) ? list : [];
}

export function branchSteps(
  step: SequenceStoredStep,
  side: BranchSide,
): SequenceStoredStep[] {
  return branchList(step, side);
}

/** The slice a path names, or null when a hop does not land on a condition. */
export function sliceAt(
  steps: SequenceStoredStep[],
  path: SlicePath,
): SequenceStoredStep[] | null {
  let current = steps;
  for (const hop of path) {
    const owner = current[hop.index];
    if (!owner || owner.type !== "condition") return null;
    current = branchList(owner, hop.branch);
  }
  return current;
}

export function stepAt(
  steps: SequenceStoredStep[],
  address: StepAddress,
): SequenceStoredStep | null {
  const slice = sliceAt(steps, address.slice);
  return slice?.[address.index] ?? null;
}

/** Depth of a slice: the top level is 1, a branch of a top-level condition 2. */
export function sliceDepth(path: SlicePath): number {
  return path.length + 1;
}

export function countSteps(steps: SequenceStoredStep[]): number {
  let total = 0;
  for (const step of steps) {
    total += 1;
    if (step.type === "condition") {
      total += countSteps(branchList(step, "yes"));
      total += countSteps(branchList(step, "no"));
    }
  }
  return total;
}

function renumberSlice(slice: SequenceStoredStep[]): SequenceStoredStep[] {
  return slice.map((step, index) =>
    step.position === index + 1 ? step : { ...step, position: index + 1 },
  );
}

/** Rebuild `steps` with the slice at `path` replaced by `fn(slice)`. */
function withSlice(
  steps: SequenceStoredStep[],
  path: SlicePath,
  fn: (slice: SequenceStoredStep[]) => SequenceStoredStep[] | null,
): SequenceStoredStep[] | null {
  if (path.length === 0) return fn(steps);
  const [hop, ...rest] = path;
  const owner = steps[hop.index];
  if (!owner || owner.type !== "condition") return null;
  const inner = withSlice(branchList(owner, hop.branch), rest, fn);
  if (!inner) return null;
  const copy = [...steps];
  copy[hop.index] = {
    ...owner,
    condition: {
      ...owner.condition,
      ...(hop.branch === "yes" ? { yes_branch: inner } : { no_branch: inner }),
    },
  };
  return copy;
}

/** Human location of a step: "Step 3", "Step 2 › Yes › step 1". */
export function describeAddress(address: StepAddress): string {
  const parts: string[] = [];
  address.slice.forEach((hop, depth) => {
    parts.push(`${depth === 0 ? "Step" : "step"} ${hop.index + 1}`);
    parts.push(hop.branch === "yes" ? "Yes" : "No");
  });
  parts.push(
    `${address.slice.length === 0 ? "Step" : "step"} ${address.index + 1}`,
  );
  return parts.join(" › ");
}

/** "the Yes branch of step 2" — for branch-scoped control names. */
export function describeBranch(path: SlicePath): string {
  const last = path[path.length - 1];
  if (!last) return "the sequence";
  const owner = describeAddress({
    slice: path.slice(0, -1),
    index: last.index,
  }).toLowerCase();
  return `the ${last.branch === "yes" ? "Yes" : "No"} branch of ${owner}`;
}

export function addressKey(address: StepAddress): string {
  return [
    ...address.slice.map(
      (hop) => `${hop.index}${hop.branch === "yes" ? "y" : "n"}`,
    ),
    String(address.index),
  ].join(".");
}

export function sameSlice(a: SlicePath, b: SlicePath): boolean {
  return (
    a.length === b.length &&
    a.every((hop, i) => hop.index === b[i].index && hop.branch === b[i].branch)
  );
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

export interface CanvasEdit {
  steps: SequenceStoredStep[];
  /**
   * For each top-level step of `steps`, the index it held BEFORE the edit
   * (null for a step the edit created). Lets the page carry per-email
   * metadata (fidelity scores) and the selected email across a reorder.
   */
  origin: (number | null)[];
  /** The step the operator acted on, where it now lives. */
  focus: StepAddress | null;
  /** Screen-reader sentence describing the change. */
  announcement: string;
}

function identityOrigin(length: number): (number | null)[] {
  return Array.from({ length }, (_, i) => i);
}

function placeLabel(slice: SlicePath, index: number, length: number): string {
  const where = slice.length === 0 ? "" : ` in ${describeBranch(slice)}`;
  return `position ${index + 1} of ${length}${where}`;
}

/**
 * Why a step of `kind` cannot be added to the slice at `path`, or null.
 * Mirrors the server's depth and node-count ceilings.
 */
export function insertionProblem(
  steps: SequenceStoredStep[],
  path: SlicePath,
): string | null {
  if (!sliceAt(steps, path)) return "That branch no longer exists.";
  if (sliceDepth(path) > MAX_CANVAS_DEPTH) {
    return `Branches nest at most ${MAX_CANVAS_DEPTH} levels deep, so this branch cannot hold steps.`;
  }
  if (countSteps(steps) >= MAX_CANVAS_STEPS) {
    return `A sequence holds at most ${MAX_CANVAS_STEPS} steps.`;
  }
  return null;
}

export function insertStep(
  steps: SequenceStoredStep[],
  path: SlicePath,
  index: number,
  step: SequenceStoredStep,
): CanvasEdit | null {
  if (insertionProblem(steps, path)) return null;
  if (countSteps(steps) + countSteps([step]) > MAX_CANVAS_STEPS) return null;
  let at = 0;
  let length = 0;
  const next = withSlice(steps, path, (slice) => {
    at = Math.max(0, Math.min(Math.trunc(index), slice.length));
    const copy = [...slice];
    copy.splice(at, 0, step);
    length = copy.length;
    return renumberSlice(copy);
  });
  if (!next) return null;
  const origin =
    path.length === 0
      ? [
          ...identityOrigin(at),
          null,
          ...identityOrigin(steps.length - at).map((i) => (i ?? 0) + at),
        ]
      : identityOrigin(next.length);
  return {
    steps: next,
    origin,
    focus: { slice: path, index: at },
    announcement: `Added ${STEP_KIND_LABEL[step.type]} step at ${placeLabel(path, at, length)}.`,
  };
}

export function appendStep(
  steps: SequenceStoredStep[],
  path: SlicePath,
  step: SequenceStoredStep,
): CanvasEdit | null {
  const slice = sliceAt(steps, path);
  if (!slice) return null;
  return insertStep(steps, path, slice.length, step);
}

/** Move a step to `toIndex` within its own slice. Null when nothing moves. */
export function moveStep(
  steps: SequenceStoredStep[],
  address: StepAddress,
  toIndex: number,
): CanvasEdit | null {
  const slice = sliceAt(steps, address.slice);
  if (!slice) return null;
  const from = address.index;
  if (from < 0 || from >= slice.length) return null;
  const to = Math.trunc(toIndex);
  if (to < 0 || to >= slice.length || to === from) return null;
  const moved = slice[from];
  const next = withSlice(steps, address.slice, (current) => {
    const copy = [...current];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return renumberSlice(copy);
  });
  if (!next) return null;
  let origin = identityOrigin(next.length);
  if (address.slice.length === 0) {
    const order = identityOrigin(steps.length);
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    origin = order;
  }
  return {
    steps: next,
    origin,
    focus: { slice: address.slice, index: to },
    announcement: `Moved ${STEP_KIND_LABEL[moved.type]} step to ${placeLabel(address.slice, to, slice.length)}.`,
  };
}

/**
 * Where a dragged step lands when dropped on the gap BEFORE `gapIndex` of its
 * own slice (gapIndex === slice.length is the end gap). Returns the move's
 * target index, or null when the drop would not move it.
 */
export function dropTargetIndex(
  fromIndex: number,
  gapIndex: number,
  sliceLength: number,
): number | null {
  if (gapIndex < 0 || gapIndex > sliceLength) return null;
  const to = gapIndex > fromIndex ? gapIndex - 1 : gapIndex;
  return to === fromIndex ? null : to;
}

export function removeStep(
  steps: SequenceStoredStep[],
  address: StepAddress,
): CanvasEdit | null {
  const slice = sliceAt(steps, address.slice);
  if (!slice || address.index < 0 || address.index >= slice.length) {
    return null;
  }
  // A draft keeps at least one top-level step; branches may be emptied.
  if (address.slice.length === 0 && slice.length <= 1) return null;
  const removed = slice[address.index];
  const next = withSlice(steps, address.slice, (current) =>
    renumberSlice(current.filter((_, i) => i !== address.index)),
  );
  if (!next) return null;
  const origin =
    address.slice.length === 0
      ? identityOrigin(steps.length).filter((i) => i !== address.index)
      : identityOrigin(next.length);
  const remaining = slice.length - 1;
  return {
    steps: next,
    origin,
    focus:
      remaining > 0
        ? {
            slice: address.slice,
            index: Math.min(address.index, remaining - 1),
          }
        : null,
    announcement: `Removed ${STEP_KIND_LABEL[removed.type]} step${
      address.slice.length === 0 ? "" : ` from ${describeBranch(address.slice)}`
    }.`,
  };
}

/** Replace a step's configuration in place (its type and slot are kept). */
export function replaceStep(
  steps: SequenceStoredStep[],
  address: StepAddress,
  step: SequenceStoredStep,
): CanvasEdit | null {
  const current = stepAt(steps, address);
  if (!current || current.type !== step.type) return null;
  const next = withSlice(steps, address.slice, (slice) => {
    const copy = [...slice];
    copy[address.index] = { ...step, position: address.index + 1 };
    return copy;
  });
  if (!next) return null;
  return {
    steps: next,
    origin: identityOrigin(next.length),
    focus: address,
    announcement: `Updated ${STEP_KIND_LABEL[step.type]} step at ${describeAddress(address).toLowerCase()}.`,
  };
}

/**
 * Set (or with an empty/undefined list, clear) an email step's A/B split.
 * Clearing omits the key rather than sending `[]`, as desktop does.
 */
export function setEmailVariants(
  steps: SequenceStoredStep[],
  address: StepAddress,
  variants: SequenceEmailVariant[] | undefined,
): CanvasEdit | null {
  const current = stepAt(steps, address);
  if (!current || current.type !== "email") return null;
  const { variants: _previous, ...email } = current.email;
  const nextStep: SequenceStoredStep = {
    ...current,
    email:
      variants && variants.length > 0 ? { ...email, variants } : { ...email },
  };
  const edit = replaceStep(steps, address, nextStep);
  if (!edit) return null;
  return {
    ...edit,
    announcement:
      variants && variants.length > 0
        ? `A/B test set to ${variants.length} variants on ${describeAddress(address).toLowerCase()}.`
        : `A/B test removed from ${describeAddress(address).toLowerCase()}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Validation (mirrors services/voice sequence_validation.go)          */
/* ------------------------------------------------------------------ */

const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/u;

function singleLineProblem(
  field: string,
  value: string,
  maxChars: number,
  required: boolean,
): string | null {
  if (required && !value.trim()) return `needs ${field}`;
  if ([...value].length > maxChars) {
    return `needs ${field} of ${maxChars} characters or fewer`;
  }
  if (CONTROL_CHAR.test(value)) return `needs ${field} on a single line`;
  return null;
}

function delayValueProblem(delay: {
  seconds: number;
  value?: number;
  unit?: string;
}): string | null {
  if (
    !Number.isInteger(delay.seconds) ||
    delay.seconds < 1 ||
    delay.seconds > MAX_DELAY_SECONDS
  ) {
    return "needs a wait between 1 minute and 365 days";
  }
  if (
    delay.unit === undefined &&
    (delay.value === undefined || delay.value === 0)
  ) {
    return null;
  }
  const unit = delay.unit as DelayUnit | undefined;
  const multiplier = unit ? DELAY_UNIT_SECONDS[unit] : undefined;
  if (
    !multiplier ||
    !Number.isInteger(delay.value) ||
    (delay.value ?? 0) < 1 ||
    (delay.value ?? 0) > MAX_DELAY_SECONDS / multiplier
  ) {
    return "needs a whole-number wait of at most 365 days in minutes, hours, or days";
  }
  return null;
}

/** Why one step (not its branches) cannot be saved, or null. */
export function stepProblem(step: SequenceStoredStep): string | null {
  switch (step.type) {
    case "email": {
      const subject = singleLineProblem(
        "a subject",
        step.email.subject ?? "",
        MAX_SUBJECT_CHARS,
        true,
      );
      if (subject) return subject;
      const hasBody = [
        step.email.body,
        step.email.body_html,
        step.email.body_mjml,
      ].some((part) => typeof part === "string" && part.trim() !== "");
      if (!hasBody) return "needs a body";
      const delay = step.email.delay_seconds ?? 0;
      if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
        return "needs a send delay between 0 and 365 days";
      }
      return variantsProblem(step.email.variants);
    }
    case "delay":
      return delayValueProblem(step.delay);
    case "condition": {
      const predicate = CONDITION_PREDICATES.find(
        (p) => p.value === step.condition.predicate?.trim().toLowerCase(),
      );
      if (!predicate) return "needs a supported condition";
      const value = step.condition.value ?? "";
      const valueIssue = singleLineProblem(
        "a condition value",
        value,
        MAX_CONDITION_VALUE_CHARS,
        predicate.needsValue,
      );
      return valueIssue;
    }
    case "tag_add":
    case "tag_remove":
      return singleLineProblem(
        "a tag",
        step.tag.tag ?? "",
        MAX_TAG_CHARS,
        true,
      );
    case "exit":
      return null;
  }
}

export interface BlockingStep {
  address: StepAddress | null;
  message: string;
}

/**
 * The first reason this tree would be refused by the server, depth-first, or
 * null when the whole tree is saveable.
 */
export function findBlockingStep(
  steps: SequenceStoredStep[],
): BlockingStep | null {
  if (countSteps(steps) > MAX_CANVAS_STEPS) {
    return {
      address: null,
      message: `A sequence holds at most ${MAX_CANVAS_STEPS} steps.`,
    };
  }
  const visit = (
    slice: SequenceStoredStep[],
    path: SlicePath,
  ): BlockingStep | null => {
    if (slice.length > 0 && sliceDepth(path) > MAX_CANVAS_DEPTH) {
      return {
        address: { slice: path, index: 0 },
        message: `${describeBranch(path)} is nested deeper than ${MAX_CANVAS_DEPTH} levels.`,
      };
    }
    for (let index = 0; index < slice.length; index += 1) {
      const step = slice[index];
      const address = { slice: path, index };
      const problem = stepProblem(step);
      if (problem) {
        return {
          address,
          message: `${describeAddress(address)} (${STEP_KIND_LABEL[step.type]}) ${problem}.`,
        };
      }
      if (step.type === "condition") {
        for (const branch of ["yes", "no"] as const) {
          const found = visit(branchList(step, branch), [
            ...path,
            { index, branch },
          ]);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(steps, []);
}

/* ------------------------------------------------------------------ */
/* A/B variants (mirrors generation.ValidateVariants)                  */
/* ------------------------------------------------------------------ */

export const VARIANT_MIN = 2;
export const VARIANT_MAX = 4;
export const VARIANT_WEIGHT_TOTAL_BP = 10000;
const VARIANT_KEY_MAX_CHARS = 32;
export const VARIANT_KEYS = ["A", "B", "C", "D"] as const;

/** Editor-side arm: `weight_pct` is the raw input string ("50", "33.34"). */
export interface VariantDraft {
  key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_pct: string;
}

/** 5000 → "50", 3334 → "33.34". */
export function bpToPct(bp: number): string {
  return (bp / 100)
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.\d)0$/u, "$1");
}

/** "33.34" → 3334; null for blank or non-numeric input. */
export function pctToBp(pct: string): number | null {
  const trimmed = pct.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** 10000 bp split as evenly as possible; the remainder goes to the first arms. */
export function evenWeightsBp(count: number): number[] {
  if (count < 1) return [];
  const base = Math.floor(VARIANT_WEIGHT_TOTAL_BP / count);
  const remainder = VARIANT_WEIGHT_TOTAL_BP - base * count;
  return Array.from({ length: count }, (_, i) =>
    i < remainder ? base + 1 : base,
  );
}

function relabelAndEven(drafts: VariantDraft[]): VariantDraft[] {
  const weights = evenWeightsBp(drafts.length);
  return drafts.map((draft, i) => ({
    ...draft,
    key: VARIANT_KEYS[i] ?? `V${i + 1}`,
    weight_pct: bpToPct(weights[i]),
  }));
}

/** A fresh two-arm split: arm A is the current email, arm B a copy to edit. */
export function seedVariantDrafts(email: {
  subject: string;
  body?: string;
  body_html?: string;
}): VariantDraft[] {
  const arm = {
    subject: email.subject ?? "",
    body: email.body ?? "",
    ...(email.body_html ? { body_html: email.body_html } : {}),
  };
  return relabelAndEven([
    { key: "A", ...arm, weight_pct: "" },
    { key: "B", ...arm, weight_pct: "" },
  ]);
}

export function addVariantDraft(drafts: VariantDraft[]): VariantDraft[] {
  if (drafts.length >= VARIANT_MAX) return drafts;
  return relabelAndEven([
    ...drafts,
    { key: "", subject: "", body: "", weight_pct: "" },
  ]);
}

export function removeVariantDraft(
  drafts: VariantDraft[],
  index: number,
): VariantDraft[] {
  if (drafts.length <= VARIANT_MIN || index < 0 || index >= drafts.length) {
    return drafts;
  }
  return relabelAndEven(drafts.filter((_, i) => i !== index));
}

/** Total of all arms in basis points; null when any weight does not parse. */
export function weightsTotalBp(drafts: VariantDraft[]): number | null {
  let total = 0;
  for (const draft of drafts) {
    const bp = pctToBp(draft.weight_pct);
    if (bp === null) return null;
    total += bp;
  }
  return total;
}

/** First reason the drafts cannot be saved as a split, or null. */
export function variantDraftsProblem(drafts: VariantDraft[]): string | null {
  if (drafts.length < VARIANT_MIN) {
    return `An A/B test needs at least ${VARIANT_MIN} variants.`;
  }
  if (drafts.length > VARIANT_MAX) {
    return `An A/B test allows at most ${VARIANT_MAX} variants.`;
  }
  for (const draft of drafts) {
    const label = draft.key || "?";
    if (!draft.subject.trim()) return `Variant ${label} needs a subject.`;
    if (CONTROL_CHAR.test(draft.subject)) {
      return `Variant ${label}: the subject must be a single line.`;
    }
    if ([...draft.subject].length > MAX_SUBJECT_CHARS) {
      return `Variant ${label}: the subject must be ${MAX_SUBJECT_CHARS} characters or fewer.`;
    }
    if (!draft.body.trim() && !(draft.body_html ?? "").trim()) {
      return `Variant ${label} needs a body.`;
    }
    const bp = pctToBp(draft.weight_pct);
    if (bp === null) return `Variant ${label}: the weight must be a number.`;
    if (bp < 1) return `Variant ${label}: the weight must be at least 0.01%.`;
  }
  const total = weightsTotalBp(drafts);
  if (total !== VARIANT_WEIGHT_TOTAL_BP) {
    return `Variant weights must total 100% (currently ${bpToPct(total ?? 0)}%).`;
  }
  return null;
}

/** Wire shape of validated drafts, or null when they would be refused. */
export function draftsToVariants(
  drafts: VariantDraft[],
): SequenceEmailVariant[] | null {
  if (variantDraftsProblem(drafts) !== null) return null;
  return drafts.map((draft) => ({
    key: draft.key,
    subject: draft.subject.trim(),
    body: draft.body,
    ...((draft.body_html ?? "").trim() ? { body_html: draft.body_html } : {}),
    weight_bp: pctToBp(draft.weight_pct) ?? 0,
  }));
}

export function variantsToDrafts(
  variants: SequenceEmailVariant[],
): VariantDraft[] {
  return variants.map((variant) => ({
    key: variant.key,
    subject: variant.subject,
    body: variant.body,
    ...(variant.body_html ? { body_html: variant.body_html } : {}),
    weight_pct: bpToPct(variant.weight_bp),
  }));
}

/** Server-side ValidateVariants for an already-stored list, as a sentence. */
export function variantsProblem(
  variants: SequenceEmailVariant[] | undefined,
): string | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (variants.length < VARIANT_MIN || variants.length > VARIANT_MAX) {
    return `needs between ${VARIANT_MIN} and ${VARIANT_MAX} A/B variants`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const variant of variants) {
    const key = (variant.key ?? "").trim();
    if (!key || key.length > VARIANT_KEY_MAX_CHARS) {
      return "has an A/B variant without a usable key";
    }
    if (seen.has(key.toLowerCase())) return `repeats A/B variant ${key}`;
    seen.add(key.toLowerCase());
    if (!(variant.subject ?? "").trim())
      return `needs a subject on variant ${key}`;
    if (!(variant.body ?? "").trim() && !(variant.body_html ?? "").trim()) {
      return `needs a body on variant ${key}`;
    }
    if (!Number.isInteger(variant.weight_bp) || variant.weight_bp < 1) {
      return `needs a positive weight on variant ${key}`;
    }
    total += variant.weight_bp;
  }
  return total === VARIANT_WEIGHT_TOTAL_BP
    ? null
    : "has A/B variant weights that do not total 100%";
}

/* ------------------------------------------------------------------ */
/* Drag payloads                                                       */
/* ------------------------------------------------------------------ */

export type StepDragPayload =
  | { source: "palette"; kind: StepKind }
  | { source: "canvas-step"; slice: BranchHop[]; index: number };

function isBranchHop(value: unknown): value is BranchHop {
  if (!value || typeof value !== "object") return false;
  const hop = value as Partial<BranchHop>;
  return (
    Number.isSafeInteger(hop.index) &&
    (hop.index ?? -1) >= 0 &&
    (hop.branch === "yes" || hop.branch === "no")
  );
}

/** Strict parse of a dataTransfer payload; anything malformed is ignored. */
export function parseStepDragPayload(raw: string): StepDragPayload | null {
  if (!raw || raw.length > MAX_DRAG_PAYLOAD_CHARS) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.source === "palette" && isStepKind(value.kind)) {
      return { source: "palette", kind: value.kind };
    }
    if (
      value?.source === "canvas-step" &&
      Array.isArray(value.slice) &&
      value.slice.length <= MAX_CANVAS_DEPTH &&
      value.slice.every(isBranchHop) &&
      Number.isSafeInteger(value.index) &&
      (value.index as number) >= 0
    ) {
      return {
        source: "canvas-step",
        slice: (value.slice as BranchHop[]).map((hop) => ({
          index: hop.index,
          branch: hop.branch,
        })),
        index: value.index as number,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Sequence bridging                                                   */
/* ------------------------------------------------------------------ */

const ZERO_BREAKDOWN: SequenceEmail["fidelityBreakdown"] = {
  embedding: 0,
  stylistic: 0,
  vocab: 0,
  structural: 0,
};

/** True when the stored row is authored as a step graph (not legacy emails). */
export function hasStepGraph(seq: Pick<Sequence, "steps">): boolean {
  return Array.isArray(seq.steps) && seq.steps.length > 0;
}

function emailContent(email: SequenceEmail) {
  return {
    subject: email.subject,
    body: email.bodyMarkdown,
    body_html: email.bodyHtml || undefined,
    body_mjml: email.bodyMjml ?? undefined,
    delay_seconds: Math.max(0, Math.round(email.delayHours * 3600)),
  };
}

/**
 * The step tree the canvas edits. A step-graph row merges the (possibly
 * edited) top-level emails into their steps by position — exactly what
 * updateSequence does before it PATCHes — so a structural edit never drops
 * unsaved copy. A legacy emails-only row is promoted to email steps.
 */
export function canvasStepsOf(
  seq: Pick<Sequence, "steps" | "emails">,
): SequenceStoredStep[] {
  const emails = Array.isArray(seq.emails) ? seq.emails : [];
  if (hasStepGraph(seq)) {
    const byPosition = new Map(emails.map((email) => [email.position, email]));
    return (seq.steps as SequenceStoredStep[]).map((step) => {
      if (step.type !== "email") return step;
      const email = byPosition.get(step.position);
      return email
        ? { ...step, email: { ...step.email, ...emailContent(email) } }
        : step;
    });
  }
  return [...emails]
    .sort((a, b) => a.position - b.position)
    .map((email) => ({
      type: "email" as const,
      position: email.position,
      email: emailContent(email),
    }));
}

function emailFromStep(
  seqId: string,
  step: Extract<SequenceStoredStep, { type: "email" }>,
  previous: SequenceEmail | undefined,
): SequenceEmail {
  return {
    id:
      previous && previous.position === step.position
        ? previous.id
        : `${seqId}-${step.position}`,
    position: step.position,
    subject: step.email.subject ?? "",
    bodyMarkdown: step.email.body ?? "",
    bodyHtml: step.email.body_html ?? "",
    bodyMjml: step.email.body_mjml ?? null,
    delayHours: (step.email.delay_seconds ?? 0) / 3600,
    fidelity: previous?.fidelity ?? 0,
    fidelityBreakdown: previous?.fidelityBreakdown ?? ZERO_BREAKDOWN,
    fidelityBreakdownPresent: previous?.fidelityBreakdownPresent ?? false,
    regenerationCount: previous?.regenerationCount ?? 0,
  };
}

function needsStepGraph(steps: SequenceStoredStep[]): boolean {
  return steps.some(
    (step) =>
      step.type !== "email" ||
      (Array.isArray(step.email.variants) && step.email.variants.length > 0),
  );
}

export interface CanvasCommit {
  sequence: Sequence;
  /**
   * The edit turns a legacy emails-only row into a step graph. The server
   * then stores every email as a step record, which has no field for the
   * per-email voice-fidelity score or regeneration count — the page must
   * name that consequence before saving.
   */
  convertsToGraph: boolean;
}

/**
 * Apply an edit to the page's Sequence: `steps` becomes the edited tree
 * (or stays absent for an emails-only row that remains emails-only, so the
 * save keeps sending `emails` with their fidelity metadata), and `emails` is
 * re-derived from the top-level email steps, carrying each email's metadata
 * across the edit via `origin`.
 */
export function commitCanvasEdit(
  seq: Sequence,
  previousSteps: SequenceStoredStep[],
  edit: CanvasEdit,
): CanvasCommit {
  const graph = hasStepGraph(seq) || needsStepGraph(edit.steps);
  const previousByPosition = new Map(
    (Array.isArray(seq.emails) ? seq.emails : []).map((email) => [
      email.position,
      email,
    ]),
  );
  const emails: SequenceEmail[] = [];
  edit.steps.forEach((step, index) => {
    if (step.type !== "email") return;
    const from = edit.origin[index];
    const before =
      from === null || from === undefined ? null : previousSteps[from];
    const previous =
      before && before.type === "email"
        ? previousByPosition.get(before.position)
        : undefined;
    emails.push(emailFromStep(seq.id, step, previous));
  });
  return {
    sequence: { ...seq, emails, steps: graph ? edit.steps : undefined },
    convertsToGraph: graph && !hasStepGraph(seq),
  };
}

/** Where the top-level email that sat at `position` lives after the edit. */
export function followEmailPosition(
  previousSteps: SequenceStoredStep[],
  edit: CanvasEdit,
  position: number,
): number | null {
  const oldIndex = previousSteps.findIndex(
    (step) => step.type === "email" && step.position === position,
  );
  if (oldIndex < 0) return null;
  const newIndex = edit.origin.indexOf(oldIndex);
  if (newIndex < 0) return null;
  return edit.steps[newIndex]?.position ?? null;
}

/** The top-level email nearest `index` (forward first), or null. */
export function emailPositionNear(
  steps: SequenceStoredStep[],
  index: number,
): number | null {
  for (let i = Math.max(0, index); i < steps.length; i += 1) {
    if (steps[i].type === "email") return steps[i].position;
  }
  for (let i = Math.min(index, steps.length) - 1; i >= 0; i -= 1) {
    if (steps[i].type === "email") return steps[i].position;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Save failure + 412 reconciliation                                   */
/* ------------------------------------------------------------------ */

/**
 * What a failed draft save needs, named by its remedy:
 *  - "reload": the stored draft moved on (412 version mismatch, 409 no longer
 *    a draft, or the save could not be confirmed) — retrying the same
 *    snapshot can only fail again, so the local snapshot must be discarded.
 *  - "retry": the request never landed or the service was unavailable —
 *    re-sending the same snapshot under the same version is safe.
 *  - "fix": the server refused the content; its sentence says what to change.
 *  - "queued": the browser is offline and the change is waiting to sync.
 */
export type SaveFailureKind = "reload" | "retry" | "fix" | "queued";

export interface SaveFailure {
  kind: SaveFailureKind;
  message: string;
}

export function classifySaveFailure(error: unknown): SaveFailure {
  if (isOfflineQueuedError(error)) {
    return { kind: "queued", message: error.message };
  }
  if (isApiError(error)) {
    const message = apiErrorMessage(error, "The draft could not be saved.");
    if (error.status === 412 || error.status === 409) {
      return { kind: "reload", message };
    }
    if (
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      return { kind: "retry", message };
    }
    return { kind: "fix", message };
  }
  // updateSequence's own guards throw plain Errors ("A fresh sequence version
  // is required…", "The server did not confirm the next sequence version…");
  // each names reloading as the remedy.
  return {
    kind: "reload",
    message:
      error instanceof Error && error.message
        ? error.message
        : "The draft could not be saved.",
  };
}

/**
 * After a conflict reload, keep the operator on the email they were editing
 * when it still exists; otherwise land on the first email (or 1 when the
 * reloaded draft has none).
 */
export function reconcileSelectedPosition(
  latest: Pick<Sequence, "emails">,
  selectedPosition: number,
): number {
  const emails = Array.isArray(latest.emails) ? latest.emails : [];
  if (emails.some((email) => email.position === selectedPosition)) {
    return selectedPosition;
  }
  return emails[0]?.position ?? 1;
}
