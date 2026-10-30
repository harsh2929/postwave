import type { SequenceStoredStep } from "@/lib/voice-types";

export type DelayUnit = "minutes" | "hours" | "days";

export type CanvasStep =
  | {
      id: string;
      type: "email";
      subject: string;
      body: string;
      delayValue: number;
      delayUnit: DelayUnit;
    }
  | { id: string; type: "delay"; value: number; unit: DelayUnit }
  | {
      id: string;
      type: "condition";
      predicate: string;
      value: string;
    }
  | { id: string; type: "tag_add" | "tag_remove"; tag: string }
  | { id: string; type: "exit" };

export type PaletteStepKind = CanvasStep["type"];

export interface PaletteEntry {
  kind: PaletteStepKind;
  label: string;
}

export const PALETTE: PaletteEntry[] = [
  { kind: "email", label: "Email" },
  { kind: "delay", label: "Wait" },
  { kind: "condition", label: "Condition" },
  { kind: "tag_add", label: "Add tag" },
  { kind: "tag_remove", label: "Remove tag" },
  { kind: "exit", label: "Exit" },
];

export const CONDITION_PREDICATES = [
  { value: "opened_previous", label: "Opened previous email" },
  { value: "clicked_any", label: "Clicked any link" },
  { value: "tag_present", label: "Has tag" },
  { value: "custom_property_eq", label: "Custom property equals" },
];

// The sequence-builder draft slot. Audit finding (PII): this was once in
// localStorage, which persists indefinitely and can survive logout / a
// shared-device handoff. Email subject + body in a sequence step are
// operator-typed but routinely contain subscriber-PII (test addresses, names)
// during compose, so the draft lives in sessionStorage — wiped when the tab
// closes — AND is keyed by identity.
//
// Identity scoping is the half that was missing. Sign-out is a router.push in
// the SAME tab, so sessionStorage survives it; so does an in-place workspace
// switch. With a bare key the next person to open /app/sequences/new restored
// the previous identity's subject and body verbatim. Keying on
// tenant + user means a second identity structurally cannot read the first
// one's draft — the same construction campaign-template-design-session.ts uses.
export const STORAGE_KEY_PREFIX = "postwave:sequence-builder-draft";

/** Identity a sequence draft belongs to. Both halves are required. */
export interface SequenceDraftScope {
  tenantId: string;
  userId: string;
}

/**
 * Storage key for one identity's draft, or null when the identity is not
 * resolved — in which case nothing is stored or restored at all. Never fall
 * back to an unscoped key: that is the leak this closes.
 */
export function sequenceDraftKey(
  scope: SequenceDraftScope | null | undefined,
): string | null {
  const tenantId = scope?.tenantId?.trim();
  const userId = scope?.userId?.trim();
  if (!tenantId || !userId) return null;
  return [
    STORAGE_KEY_PREFIX,
    encodeURIComponent(tenantId),
    encodeURIComponent(userId),
  ].join(":");
}

/**
 * Keys written by the pre-scoping build. Cleared on mount so a draft already
 * sitting in a shared tab's sessionStorage is discarded rather than inherited.
 */
export const LEGACY_DRAFT_KEYS = [
  STORAGE_KEY_PREFIX,
  `${STORAGE_KEY_PREFIX}:at`,
] as const;
export const MAX_STORED_DRAFT_BYTES = 128 * 1024;
/** Mirrors services/voice sequenceMaxNodes. */
export const MAX_SEQUENCE_DRAFT_STEPS = 100;
/** Mirrors services/voice sequenceMaxNameRunes. */
export const MAX_SEQUENCE_NAME_CHARS = 200;
/** Mirrors services/voice sequenceMaxSubjectRunes. */
export const MAX_SEQUENCE_SUBJECT_CHARS = 255;
export const DEFAULT_SEQUENCE_NAME = "Manual sequence";

const MAX_DRAFT_ID_CHARS = 128;
const MAX_DRAFT_SHORT_TEXT_CHARS = 512;
const MAX_DRAFT_BODY_CHARS = 64 * 1024;
// The pre-alignment Web build could save 200 local steps. Preserve those on
// restore so the operator can remove/rework them; validateSteps still blocks
// transport above the server's 100-node limit. Recovery must not silently
// discard half a legitimate legacy draft.
const MAX_LEGACY_STORED_DRAFT_STEPS = 200;
const DRAFT_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UNIT_SECONDS: Record<DelayUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

export function draftStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function makeId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isStoredDraftTooLarge(raw: string): boolean {
  return byteLength(raw) > MAX_STORED_DRAFT_BYTES;
}

export function newStep(kind: PaletteStepKind): CanvasStep {
  switch (kind) {
    case "email":
      return {
        id: makeId(),
        type: "email",
        subject: "",
        body: "",
        delayValue: 0,
        delayUnit: "hours",
      };
    case "delay":
      return { id: makeId(), type: "delay", value: 1, unit: "days" };
    case "condition":
      return {
        id: makeId(),
        type: "condition",
        predicate: "opened_previous",
        value: "",
      };
    case "tag_add":
    case "tag_remove":
      return { id: makeId(), type: kind, tag: "" };
    case "exit":
      return { id: makeId(), type: "exit" };
  }
}

export function isPaletteStepKind(value: string): value is PaletteStepKind {
  return PALETTE.some((entry) => entry.kind === value);
}

function isDelayUnit(value: unknown): value is DelayUnit {
  return value === "minutes" || value === "hours" || value === "days";
}

function cleanDraftId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (
    !value ||
    value.length > MAX_DRAFT_ID_CHARS ||
    value.trim() !== value ||
    DRAFT_CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function cleanDraftText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return [...value].slice(0, maxChars).join("");
}

export function coerceDraftStep(value: unknown): CanvasStep | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CanvasStep>;
  const id = cleanDraftId(raw.id);
  if (!id || typeof raw.type !== "string") return null;
  if (!isPaletteStepKind(raw.type)) return null;
  switch (raw.type) {
    case "email": {
      const step = raw as Partial<Extract<CanvasStep, { type: "email" }>>;
      return {
        id,
        type: "email",
        // Keep the old recovery ceiling. A legacy 256–512 character subject
        // is surfaced by validateSteps for editing instead of being truncated.
        subject: cleanDraftText(step.subject, MAX_DRAFT_SHORT_TEXT_CHARS),
        body: cleanDraftText(step.body, MAX_DRAFT_BODY_CHARS),
        delayValue:
          typeof step.delayValue === "number" &&
          Number.isFinite(step.delayValue)
            ? step.delayValue
            : 0,
        delayUnit: isDelayUnit(step.delayUnit) ? step.delayUnit : "hours",
      };
    }
    case "delay": {
      const step = raw as Partial<Extract<CanvasStep, { type: "delay" }>>;
      return {
        id,
        type: "delay",
        value:
          typeof step.value === "number" && Number.isFinite(step.value)
            ? step.value
            : 1,
        unit: isDelayUnit(step.unit) ? step.unit : "days",
      };
    }
    case "condition": {
      const step = raw as Partial<Extract<CanvasStep, { type: "condition" }>>;
      return {
        id,
        type: "condition",
        predicate:
          typeof step.predicate === "string" &&
          CONDITION_PREDICATES.some((p) => p.value === step.predicate)
            ? step.predicate
            : "opened_previous",
        value: cleanDraftText(step.value, MAX_DRAFT_SHORT_TEXT_CHARS),
      };
    }
    case "tag_add":
    case "tag_remove": {
      const step = raw as { tag?: unknown };
      return {
        id,
        type: raw.type,
        tag: cleanDraftText(step.tag, MAX_DRAFT_SHORT_TEXT_CHARS),
      };
    }
    case "exit":
      return { id, type: "exit" };
  }
}

export interface StoredSequenceDraft {
  name: string;
  steps: CanvasStep[];
}

/**
 * Serializes the complete authoring state. The name used to live outside the
 * stored step array, so changing only it neither armed dirty state nor survived
 * navigation. The small versioned envelope keeps future migrations explicit.
 */
export function serializeSequenceDraft(
  name: string,
  steps: CanvasStep[],
): string {
  return JSON.stringify({ version: 1, name, steps });
}

function coerceStoredSteps(value: unknown): CanvasStep[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .slice(0, MAX_LEGACY_STORED_DRAFT_STEPS)
    .map((item) => coerceDraftStep(item))
    .filter((item): item is CanvasStep => item !== null);
}

/** Restores current envelopes and pre-envelope array-only drafts. */
export function restoreStoredDraft(raw: string): StoredSequenceDraft | null {
  if (isStoredDraftTooLarge(raw)) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const steps = coerceStoredSteps(parsed);
      return steps ? { name: DEFAULT_SEQUENCE_NAME, steps } : null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const envelope = parsed as {
      version?: unknown;
      name?: unknown;
      steps?: unknown;
    };
    if (envelope.version !== 1) return null;
    const steps = coerceStoredSteps(envelope.steps);
    if (!steps) return null;
    const restoredName = cleanDraftText(envelope.name, MAX_SEQUENCE_NAME_CHARS);
    return {
      name: restoredName || DEFAULT_SEQUENCE_NAME,
      steps,
    };
  } catch {
    return null;
  }
}

/** Backward-compatible step-only reader used by existing callers/tests. */
export function restoreStoredDraftSteps(raw: string): CanvasStep[] | null {
  return restoreStoredDraft(raw)?.steps ?? null;
}

function delaySeconds(value: number, unit: DelayUnit): number {
  return Math.max(0, Math.round(value * UNIT_SECONDS[unit]));
}

export function stepTitle(step: CanvasStep): string {
  switch (step.type) {
    case "email":
      return step.subject || "Untitled email";
    case "delay":
      return `Wait ${step.value || 0} ${step.unit}`;
    case "condition":
      return (
        CONDITION_PREDICATES.find((p) => p.value === step.predicate)?.label ??
        "Condition"
      );
    case "tag_add":
      return step.tag ? `Add tag: ${step.tag}` : "Add tag";
    case "tag_remove":
      return step.tag ? `Remove tag: ${step.tag}` : "Remove tag";
    case "exit":
      return "Exit sequence";
  }
}

export function stepSummary(step: CanvasStep): string {
  switch (step.type) {
    case "email":
      return step.body ? step.body.slice(0, 90) : "Draft an email body";
    case "delay":
      return "Standalone wait before the next action";
    case "condition":
      return step.value ? `Argument: ${step.value}` : "Branches at send time";
    case "tag_add":
    case "tag_remove":
      return step.tag || "Enter a tag before saving";
    case "exit":
      return "Stops this journey for the subscriber";
  }
}

export function toStoredSteps(steps: CanvasStep[]): SequenceStoredStep[] {
  return steps.map((step, index) => {
    const position = index + 1;
    switch (step.type) {
      case "email":
        return {
          type: "email",
          position,
          email: {
            subject: step.subject.trim(),
            body: step.body,
            delay_seconds: delaySeconds(step.delayValue, step.delayUnit),
          },
        };
      case "delay":
        return {
          type: "delay",
          position,
          delay: {
            seconds: delaySeconds(step.value, step.unit),
            value: step.value,
            unit: step.unit,
          },
        };
      case "condition":
        return {
          type: "condition",
          position,
          condition: {
            predicate: step.predicate,
            value: step.value.trim() || undefined,
            yes_branch: [],
            no_branch: [],
          },
        };
      case "tag_add":
      case "tag_remove":
        return {
          type: step.type,
          position,
          tag: { tag: step.tag.trim() },
        };
      case "exit":
        return { type: "exit", position };
    }
  });
}

export function validateSequenceName(name: string): string | null {
  const normalized = name.trim();
  if (!normalized) return null; // save() substitutes DEFAULT_SEQUENCE_NAME.
  if ([...normalized].length > MAX_SEQUENCE_NAME_CHARS) {
    return `Sequence name must be ${MAX_SEQUENCE_NAME_CHARS} characters or fewer.`;
  }
  return null;
}

export function validateSteps(steps: CanvasStep[]): string | null {
  if (steps.length === 0) return "Add at least one step before saving.";
  if (steps.length > MAX_SEQUENCE_DRAFT_STEPS) {
    return `Sequence drafts can include at most ${MAX_SEQUENCE_DRAFT_STEPS} steps.`;
  }
  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.type === "email" && !step.subject.trim()) {
      return `${label}: an email step needs a subject line.`;
    }
    if (
      step.type === "email" &&
      [...step.subject.trim()].length > MAX_SEQUENCE_SUBJECT_CHARS
    ) {
      return `${label}: the subject must be ${MAX_SEQUENCE_SUBJECT_CHARS} characters or fewer.`;
    }
    if (step.type === "email" && !step.body.trim()) {
      return `${label}: an email step needs a body.`;
    }
    if (step.type === "delay" && step.value <= 0) {
      return `${label}: wait time must be greater than zero.`;
    }
    if (
      step.type === "condition" &&
      (step.predicate === "tag_present" ||
        step.predicate === "custom_property_eq") &&
      !step.value.trim()
    ) {
      return `${label}: this condition needs an argument.`;
    }
    if (
      (step.type === "tag_add" || step.type === "tag_remove") &&
      !step.tag.trim()
    ) {
      return `${label}: enter a tag before saving.`;
    }
  }
  return null;
}
