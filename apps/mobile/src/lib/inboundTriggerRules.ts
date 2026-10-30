/**
 * lib/inboundTriggerRules.ts — the trigger-rule half of an inbound endpoint,
 * restated as pure policy so the sheet can describe a stored rule without
 * inventing anything and send the server exactly the body it expects.
 *
 * A trigger is "when this JSONPath on the payload matches, resolve the
 * subscriber email from that other JSONPath, then do ONE action". The wire
 * shape is Trigger in apps/api/internal/inbound_webhooks/triggers.go; the
 * limits a draft must satisfy live in lib/inboundTriggerValidation.ts and are
 * re-exported here so callers import one module.
 *
 * The desktop editor (apps/desktop/src/components/webhooks/
 * trigger-editor-model.ts) is the model for the fields and the wording. What
 * it does that the phone does NOT: evaluate the JSONPath against a sample
 * body. That preview needs a retained event on hand and a wide screen to read
 * the result; the phone validates syntax and says so.
 *
 * No react-native / expo import: vitest runs this in node.
 */
import { transitionLabel } from "@/lib/direction";
import { plural, relativeTime } from "@/lib/format";
import type {
  TriggerAction,
  TriggerOperator,
  TriggerRuleDraft,
} from "@/lib/inboundTriggerValidation";

export {
  isTriggerTargetUUID,
  utf8ByteLength,
  validateMatchOperand,
  validateTriggerDraft,
  validateTriggerJsonPath,
} from "@/lib/inboundTriggerValidation";
export type {
  TriggerAction,
  TriggerDraftErrors,
  TriggerOperator,
  TriggerRuleDraft,
} from "@/lib/inboundTriggerValidation";

/** One rule as the phone holds it — camelCase, every field present. */
export interface InboundTriggerRule {
  id: string;
  webhookId: string;
  name: string;
  active: boolean;
  matchJsonpath: string;
  matchOperator: TriggerOperator;
  /** Null for `exists`, which has no operand. */
  matchValue: string | null;
  emailJsonpath: string;
  actionType: TriggerAction;
  actionTargetId: string;
  firedCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The wire body of POST /triggers, and the full-replace body of PATCH. */
export interface TriggerRuleInput {
  name: string;
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value: string | null;
  email_jsonpath: string;
  action_type: TriggerAction;
  action_target_id: string;
}

export const TRIGGER_OPERATORS: readonly {
  value: TriggerOperator;
  label: string;
}[] = [
  { value: "equals", label: "Equals" },
  { value: "contains", label: "Contains" },
  { value: "exists", label: "Exists" },
  { value: "regex", label: "Regex" },
];

export const TRIGGER_ACTIONS: readonly {
  value: TriggerAction;
  label: string;
  targetLabel: string;
  targetHelp: string;
  targetPlaceholder: string;
}[] = [
  {
    value: "add_to_sequence",
    label: "Enroll in sequence",
    targetLabel: "Sequence ID",
    targetHelp: "Copy the UUID from the target sequence.",
    targetPlaceholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    value: "add_tag",
    label: "Add tag",
    targetLabel: "Tag name",
    targetHelp: "Use the exact existing tag name (up to 64 characters).",
    targetPlaceholder: "paid-customer",
  },
  {
    value: "remove_tag",
    label: "Remove tag",
    targetLabel: "Tag name",
    targetHelp: "Use the exact existing tag name (up to 64 characters).",
    targetPlaceholder: "paid-customer",
  },
  {
    value: "start_automation",
    label: "Start automation",
    targetLabel: "Automation ID",
    targetHelp: "Copy the UUID from the target automation.",
    targetPlaceholder: "00000000-0000-0000-0000-000000000000",
  },
];

export const EMPTY_TRIGGER_DRAFT: TriggerRuleDraft = {
  name: "",
  matchJsonpath: "$.event",
  operator: "equals",
  matchValue: "",
  emailJsonpath: "$.user.email",
  actionType: "add_to_sequence",
  actionTargetId: "",
};

/** Every trigger route is admin-scoped (routeauth manifest, all four verbs). */
export const TRIGGER_RULES_ADMIN_CAPTION =
  "Trigger rules are read and changed by admins only. Ask an owner or admin to pause or edit a rule on this endpoint.";

/** Shown under the target field: the phone checks syntax, not existence. */
export const TRIGGER_TARGET_SYNTAX_NOTE =
  "Manual values are checked for syntax only. The server may reject a target that no longer exists, or the action may fail when it runs.";

const OPERATORS = new Set<string>(TRIGGER_OPERATORS.map((o) => o.value));
const ACTIONS = new Set<string>(TRIGGER_ACTIONS.map((a) => a.value));

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOperator(value: unknown): TriggerOperator {
  return typeof value === "string" && OPERATORS.has(value)
    ? (value as TriggerOperator)
    : "equals";
}

function asAction(value: unknown): TriggerAction {
  return typeof value === "string" && ACTIONS.has(value)
    ? (value as TriggerAction)
    : "add_to_sequence";
}

/**
 * One row of GET /api/v1/inbound-webhooks/{id}/triggers (Trigger in
 * triggers.go). Null for anything without an id; the row is otherwise kept
 * however partial it is, because a rule an operator cannot SEE is a rule they
 * cannot pause.
 *
 * `active` reads a missing flag as ACTIVE, deliberately. The verb this sheet
 * exists for is "pause the misfiring rule"; a rule mis-shown as paused sends
 * the operator looking elsewhere, while a rule mis-shown as active costs one
 * harmless PATCH.
 */
export function normalizeTriggerRule(entry: unknown): InboundTriggerRule | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const id = str(r.id).trim();
  if (!id) return null;
  const fired =
    typeof r.fired_count === "number" && Number.isFinite(r.fired_count)
      ? Math.max(0, Math.trunc(r.fired_count))
      : 0;
  return {
    id,
    webhookId: str(r.webhook_id),
    name: str(r.name).trim() || "Unnamed rule",
    active: r.active !== false,
    matchJsonpath: str(r.match_jsonpath),
    matchOperator: asOperator(r.match_operator),
    matchValue: typeof r.match_value === "string" ? r.match_value : null,
    emailJsonpath: str(r.email_jsonpath),
    actionType: asAction(r.action_type),
    actionTargetId: str(r.action_target_id),
    firedCount: fired,
    lastFiredAt: str(r.last_fired_at) || null,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

/** The list response is `{items: [...]}`; a bare array is tolerated. */
export function parseTriggerRuleList(payload: unknown): InboundTriggerRule[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: InboundTriggerRule[] = [];
  for (const entry of raw) {
    const rule = normalizeTriggerRule(entry);
    if (rule) out.push(rule);
  }
  return out;
}

/** The wire body. `exists` canonicalises the operand away, as the server does. */
export function triggerInputFromDraft(draft: TriggerRuleDraft): TriggerRuleInput {
  return {
    name: draft.name.trim(),
    match_jsonpath: draft.matchJsonpath.trim(),
    match_operator: draft.operator,
    match_value: draft.operator === "exists" ? null : draft.matchValue,
    email_jsonpath: draft.emailJsonpath.trim(),
    action_type: draft.actionType,
    action_target_id: draft.actionTargetId.trim(),
  };
}

export function draftFromRule(rule: InboundTriggerRule | null): TriggerRuleDraft {
  if (!rule) return { ...EMPTY_TRIGGER_DRAFT };
  return {
    name: rule.name,
    matchJsonpath: rule.matchJsonpath,
    operator: rule.matchOperator,
    matchValue: rule.matchValue ?? "",
    emailJsonpath: rule.emailJsonpath,
    actionType: rule.actionType,
    actionTargetId: rule.actionTargetId,
  };
}

/** Field-by-field, so a draft with the same text in a different order is not "dirty". */
export function isTriggerDraftDirty(
  draft: TriggerRuleDraft,
  baseline: TriggerRuleDraft,
): boolean {
  return (Object.keys(baseline) as (keyof TriggerRuleDraft)[]).some(
    (key) => draft[key] !== baseline[key],
  );
}

/** `When $.event equals "customer.created"` — or `When $.event exists`. */
export function triggerConditionLine(rule: InboundTriggerRule): string {
  const head = `When ${rule.matchJsonpath} ${rule.matchOperator}`;
  if (rule.matchOperator === "exists") return head;
  return `${head} ${JSON.stringify(rule.matchValue ?? "")}`;
}

/** `Email from $.customer.email → Add tag “paid”` (desktop's triggerActionLabel). */
export function triggerActionLine(rule: InboundTriggerRule): string {
  const action = TRIGGER_ACTIONS.find((a) => a.value === rule.actionType);
  const label = action?.label ?? rule.actionType;
  const target =
    rule.actionType === "add_tag" || rule.actionType === "remove_tag"
      ? `“${rule.actionTargetId}”`
      : `…${rule.actionTargetId.slice(-8)}`;
  return transitionLabel(`Email from ${rule.emailJsonpath}`, `${label} ${target}`);
}

/**
 * "Never fired" / "Fired 12 times · last 3h ago". The count comes from the
 * server's fired_count and is never derived; absence of a last-fired time
 * with a non-zero count still reports the count.
 */
export function triggerFiredLine(
  rule: InboundTriggerRule,
  now = Date.now(),
): string {
  if (rule.firedCount === 0) return "Never fired";
  const base = `Fired ${plural(rule.firedCount, "time")}`;
  if (!rule.lastFiredAt) return base;
  return `${base} · last ${relativeTime(rule.lastFiredAt, { now })}`;
}

/** The sheet subtitle: "3 rules · 1 paused", or "No rules yet". */
export function triggerRulesSummary(rules: readonly InboundTriggerRule[]): string {
  if (rules.length === 0) return "No rules yet";
  const paused = rules.filter((r) => !r.active).length;
  const base = plural(rules.length, "rule");
  return paused > 0 ? `${base} · ${paused} paused` : base;
}

/** The pause/resume control, in the ACTION's words, plus what it costs. */
export function triggerToggleCopy(rule: InboundTriggerRule): {
  label: string;
  a11y: string;
} {
  return rule.active
    ? {
        label: "Pause",
        a11y: `Pause ${rule.name}. Matching events stop running it until it is resumed; nothing is deleted.`,
      }
    : {
        label: "Resume",
        a11y: `Resume ${rule.name} so matching events run it again.`,
      };
}

/** Desktop's ConfirmModal copy for the irreversible verb, verbatim. */
export function triggerDeleteConfirmCopy(rule: InboundTriggerRule): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  return {
    title: "Delete this trigger?",
    message: `Future matching events will no longer run “${rule.name}.” Fired-count history on this rule will also leave this endpoint view. Pause it instead for a reversible stop.`,
    confirmLabel: "Delete trigger",
  };
}
