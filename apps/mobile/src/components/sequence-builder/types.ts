/**
 * Sequence-builder types — mobile mirror of the desktop's
 * `apps/desktop/src/components/sequence/types.ts`.
 *
 * The wire format (services/voice/internal/generation/types.go) is the
 * same across web/desktop/mobile; we keep the in-canvas shape separate
 * so the builder can render branching/condition nodes that the legacy
 * `emails`-only POST/PATCH body doesn't carry. On save we translate
 * back to the typed shape exported from `@/api/sequences::SequenceStepWire`.
 *
 * Branching (yes/no, tag_add, tag_remove, exit) is shown in the palette
 * as "Requires API v0.3" muted tooltips. They render and persist via
 * the v0.3 `steps` field — the desktop already uses the same UI, so the
 * mobile keeps the gating consistent.
 */

export type StepType =
  | "email"
  | "delay"
  | "condition"
  | "tag_add"
  | "tag_remove"
  | "exit";

/**
 * Condition vocabulary understood by this client.
 *
 * `unsupported` is a SENTINEL, never a stored value: it means the server sent
 * a predicate this build does not model. Before it existed, an unrecognised
 * predicate silently decoded to `opened` and the canvas confidently rendered
 * "If opened previous email" over, say, a product-event branch — a wrong
 * reading, which is worse than an absent one. The raw predicate is kept on
 * `condition_predicate` so a round-trip through the canvas cannot destroy it.
 */
export type ConditionType =
  | "opened"
  | "clicked"
  | "tagged"
  | "custom_property"
  | "product_event"
  | "unsupported";

/** An A/B arm on an email step (services/voice EmailConfig.Variants). */
export interface SequenceEmailVariant {
  key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_bp?: number;
}

/** A node on the mobile canvas. `id` is a stable client-side identifier. */
export interface CanvasStep {
  id: string;
  type: StepType;
  position: number;
  // Email-specific.
  subject?: string;
  body?: string;
  body_html?: string;
  /** MJML source authored on desktop. Decode-and-re-emit only on mobile. */
  body_mjml?: string;
  /** Per-step send offset carried on the email config (not the delay node). */
  email_delay_seconds?: number;
  /** A/B arms authored on desktop. Mobile renders a count, never edits them. */
  variants?: SequenceEmailVariant[];
  template_id?: string;
  // Delay-specific.
  delay_value?: number;
  delay_unit?: "minutes" | "hours" | "days";
  // Condition-specific.
  condition_type?: ConditionType;
  /** Raw wire predicate, preserved verbatim so `unsupported` round-trips. */
  condition_predicate?: string;
  condition_value?: string;
  // Two child branches for conditions; each holds its own ordered steps.
  yes_branch?: CanvasStep[];
  no_branch?: CanvasStep[];
  // Tag-specific.
  tag?: string;
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
      const ct = s.condition_type ?? "opened";
      const v = s.condition_value ?? "";
      switch (ct) {
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
        case "unsupported":
          return s.condition_predicate
            ? `Condition "${s.condition_predicate}" — not supported on mobile`
            : "Condition — not supported on mobile";
      }
      return "Condition";
    }
    case "tag_add":
      return s.tag ? `Add tag: ${s.tag}` : "Add tag…";
    case "tag_remove":
      return s.tag ? `Remove tag: ${s.tag}` : "Remove tag…";
    case "exit":
      return "Exit sequence";
  }
}

/** Generate a unique-enough client id for a freshly-created node. */
export function genStepId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}

/** Drop position descriptor used by StepCanvas when a tile lands. */
export type DropTarget =
  | { kind: "before"; targetId: string }
  | { kind: "after"; targetId: string }
  | { kind: "end" };

/**
 * Lifted-tile payload during a long-press drag. Either a fresh palette
 * type (no id) or an existing node id (move).
 */
export type DragSource =
  | { kind: "palette"; type: StepType }
  | { kind: "node"; id: string };

/** Exact nested step union accepted by the Voice service. */

// The wire<->canvas codec lives in ./wire; re-exported so existing imports of
// "@/components/sequence-builder/types" keep resolving unchanged.
export {
  CANVAS_BRANCH_DEPTH_LIMIT,
  canvasToWire,
  conditionTypeFromPredicate,
  countCanvasSteps,
  predicateFromConditionType,
  wireToCanvas,
  type WireStep,
} from "./wire";

