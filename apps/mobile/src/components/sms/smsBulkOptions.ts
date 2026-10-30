/**
 * smsBulkOptions — which bulk lifecycle verbs the current status slice can
 * honestly offer.
 *
 * Every server verb is a SET (`archived_at = now()`, `snooze_until = NULL` …),
 * so offering "Archive" over a selection drawn from the Archived slice would
 * re-stamp rows rather than toggle them. The slice the operator is LOOKING AT
 * is the only lifecycle evidence the screen has, so the verb set follows it —
 * the same reasoning `smsTriageOptions` applies per row. The "any" slice mixes
 * lifecycles, and a SET verb is still safe there (it converges every selected
 * row to one state), so it offers everything.
 */
import type { SmsBulkAction } from "@/lib/smsBulkAction";
import type { SmsConversationStatus } from "@/lib/smsConversation";

import { SMS_SNOOZE_PRESETS, type SmsSnoozePresetId } from "./smsTriageOptions";

export type SmsBulkVerbId = SmsBulkAction | SmsSnoozePresetId;

export interface SmsBulkVerb {
  id: SmsBulkVerbId;
  label: string;
}

export function smsBulkVerbs(status: SmsConversationStatus): SmsBulkVerb[] {
  const snoozes: SmsBulkVerb[] = SMS_SNOOZE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
  }));
  if (status === "active") {
    return [...snoozes, { id: "archive", label: "Archive" }];
  }
  if (status === "snoozed") {
    return [
      { id: "unsnooze", label: "Wake now" },
      { id: "archive", label: "Archive" },
    ];
  }
  if (status === "archived") {
    return [{ id: "unarchive", label: "Restore" }];
  }
  return [
    ...snoozes,
    { id: "unsnooze", label: "Wake now" },
    { id: "archive", label: "Archive" },
    { id: "unarchive", label: "Restore" },
  ];
}

/** Resolve a verb press into the mutation's action + optional deadline. */
export function smsBulkIntentFor(
  id: SmsBulkVerbId,
  now: number,
): { action: SmsBulkAction; until?: string } {
  const preset = SMS_SNOOZE_PRESETS.find((entry) => entry.id === id);
  if (preset) {
    return {
      action: "snooze",
      until: new Date(now + preset.ms).toISOString(),
    };
  }
  return { action: id as SmsBulkAction };
}

export function smsBulkDoneMessage(
  id: SmsBulkVerbId,
  applied: number,
): string {
  const noun = applied === 1 ? "conversation" : "conversations";
  if (id === "archive") return `Archived ${applied} ${noun}`;
  if (id === "unarchive") return `Restored ${applied} ${noun}`;
  if (id === "unsnooze") return `Woke ${applied} ${noun}`;
  return `Snoozed ${applied} ${noun}`;
}
