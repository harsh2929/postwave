import type {
  InboundTrigger,
  InboundTriggerInput,
  TriggerAction,
  TriggerOperator,
} from "../../lib/api-client";
import { validateJSONPath, validateMatchOperand } from "../../lib/jsonpath";

export const TRIGGER_OPERATORS: Array<{
  value: TriggerOperator;
  label: string;
}> = [
  { value: "equals", label: "Equals" },
  { value: "contains", label: "Contains" },
  { value: "exists", label: "Exists" },
  { value: "regex", label: "Matches regex" },
];

export const TRIGGER_ACTIONS: Array<{
  value: TriggerAction;
  label: string;
  targetLabel: string;
  targetHelp: string;
}> = [
  {
    value: "add_to_sequence",
    label: "Enroll in sequence",
    targetLabel: "Sequence ID",
    targetHelp: "Copy the UUID from the target sequence.",
  },
  {
    value: "add_tag",
    label: "Add tag",
    targetLabel: "Tag name",
    targetHelp: "Use the exact existing tag name (up to 64 characters).",
  },
  {
    value: "remove_tag",
    label: "Remove tag",
    targetLabel: "Tag name",
    targetHelp: "Use the exact existing tag name (up to 64 characters).",
  },
  {
    value: "start_automation",
    label: "Start automation",
    targetLabel: "Automation ID",
    targetHelp: "Copy the UUID from the target automation.",
  },
];

export interface TriggerDraft {
  name: string;
  matchJsonpath: string;
  operator: TriggerOperator;
  matchValue: string;
  emailJsonpath: string;
  actionType: TriggerAction;
  actionTargetId: string;
}

export interface TriggerTargetOption {
  value: string;
  label: string;
}

export const EMPTY_TRIGGER_DRAFT: TriggerDraft = {
  name: "",
  matchJsonpath: "$.event",
  operator: "equals",
  matchValue: "",
  emailJsonpath: "$.user.email",
  actionType: "add_to_sequence",
  actionTargetId: "",
};

export function draftFromTrigger(trigger: InboundTrigger | null): TriggerDraft {
  if (!trigger) return { ...EMPTY_TRIGGER_DRAFT };
  return {
    name: trigger.name,
    matchJsonpath: trigger.match_jsonpath,
    operator: trigger.match_operator,
    matchValue: trigger.match_value ?? "",
    emailJsonpath: trigger.email_jsonpath,
    actionType: trigger.action_type,
    actionTargetId: trigger.action_target_id,
  };
}

export function isTriggerTargetUUID(value: string): boolean {
  return /^[{]?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[}]?$/i.test(
    value,
  );
}

export function validateTriggerDraft(
  draft: TriggerDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "Enter a trigger name.";
  else if (new TextEncoder().encode(draft.name.trim()).length > 256) {
    errors.name = "Name must be 256 bytes or smaller.";
  }
  const matchPathError = validateJSONPath(draft.matchJsonpath);
  if (matchPathError) errors.matchJsonpath = matchPathError;
  const operandError = validateMatchOperand(
    draft.operator,
    draft.operator === "exists" ? null : draft.matchValue,
  );
  if (operandError) errors.matchValue = operandError;
  const emailPathError = validateJSONPath(draft.emailJsonpath);
  if (emailPathError) errors.emailJsonpath = emailPathError;
  const target = draft.actionTargetId.trim();
  if (!target) {
    errors.actionTargetId = "Choose the target for this action.";
  } else if (
    draft.actionType === "add_to_sequence" ||
    draft.actionType === "start_automation"
  ) {
    if (!isTriggerTargetUUID(target)) {
      errors.actionTargetId = "Enter the target's UUID.";
    }
  } else if (
    Array.from(target).length > 64 ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) {
    errors.actionTargetId =
      "Tag name must be 1–64 characters without control characters.";
  }
  return errors;
}

export function triggerInput(draft: TriggerDraft): InboundTriggerInput {
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

export function triggerActionLabel(trigger: InboundTrigger): string {
  const action = TRIGGER_ACTIONS.find(
    (candidate) => candidate.value === trigger.action_type,
  );
  if (
    trigger.action_type === "add_tag" ||
    trigger.action_type === "remove_tag"
  ) {
    return `${action?.label ?? trigger.action_type} “${trigger.action_target_id}”`;
  }
  return `${action?.label ?? trigger.action_type} · …${trigger.action_target_id.slice(-8)}`;
}

export function triggerTargetRecords(
  payload: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
  }
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const candidate of [
    record.items,
    record.data,
    record.results,
    record.sequences,
  ]) {
    if (Array.isArray(candidate)) return triggerTargetRecords(candidate);
  }
  return [];
}
