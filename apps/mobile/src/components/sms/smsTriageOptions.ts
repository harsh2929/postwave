/**
 * smsTriageOptions — which lifecycle verbs a conversation is actually offering,
 * and the sentences that describe the state it is in.
 *
 * The mobile inbox has always DECODED `snoozeUntil`, `archivedAt` and
 * `assigneeUserId` (src/lib/smsConversationWire.ts:408-421) and has always
 * rendered Snoozed / Archived filter chips with live server counts — while
 * offering no way to move a row into or out of any of them, and never showing
 * the assignee it parsed. This module is the decision half of closing that: it
 * is pure, so the rule "a snoozed row offers Wake, an archived row offers
 * Restore" is testable in node rather than only reachable through a sheet.
 *
 * TWO RULES WORTH STATING.
 *
 * 1. THE STATE COMES FROM THE SAME PREDICATE THE LIST FILTER USES. `archivedAt`
 *    wins over `snoozeUntil`, and a snooze whose deadline has already passed is
 *    NOT snoozed — mirrored from `smsConversationWire.ts:378-388`, so the menu
 *    can never contradict the chip the row was returned under.
 *
 * 2. AN UNKNOWN STATE OFFERS EVERYTHING AND SAYS SO. The thread screen reaches
 *    triage without a conversation summary — `GET .../context` does not carry
 *    the lifecycle stamps — so passing `conversation: null` yields the full verb
 *    set. Every verb is a SET, not a toggle (`archived_at = now()`,
 *    `snooze_until = NULL`, inbox_extras.go:100-118), so offering "Archive" for
 *    an already-archived row re-stamps it rather than un-archiving it. Guessing
 *    a toggle from unknown state is the only thing here that could act against
 *    the operator's intent.
 */
import type { SmsTriageIntent } from "@/hooks/useSmsInboxTriage";
import type { SmsConversationSummary } from "@/lib/smsConversation";

export type SmsSnoozePresetId = "snooze_1h" | "snooze_8h" | "snooze_24h";

export type SmsTriageOptionId =
  | SmsSnoozePresetId
  | "unsnooze"
  | "archive"
  | "unarchive"
  | "assign_me"
  | "unassign";

export interface SmsTriageOption {
  id: SmsTriageOptionId;
  label: string;
  hint?: string;
}

export const SMS_SNOOZE_PRESETS: readonly {
  id: SmsSnoozePresetId;
  label: string;
  ms: number;
}[] = [
  { id: "snooze_1h", label: "Snooze for 1 hour", ms: 60 * 60_000 },
  { id: "snooze_8h", label: "Snooze for 8 hours", ms: 8 * 60 * 60_000 },
  { id: "snooze_24h", label: "Snooze for 24 hours", ms: 24 * 60 * 60_000 },
];

export type SmsConversationLifecycle = "active" | "snoozed" | "archived";

/** Mirrors `conversationMatchesStatus` (smsConversationWire.ts:378-388). */
export function smsConversationLifecycle(
  conversation: Pick<SmsConversationSummary, "snoozeUntil" | "archivedAt">,
  now: number,
): SmsConversationLifecycle {
  // Archive wins: the wire's own predicate short-circuits on `archivedAt`
  // before it ever looks at the snooze deadline.
  if (conversation.archivedAt) return "archived";
  if (conversation.snoozeUntil) {
    const until = Date.parse(conversation.snoozeUntil);
    if (Number.isFinite(until) && until > now) return "snoozed";
  }
  return "active";
}

/**
 * The lifecycle sentence for a row, or null when the row is plainly active.
 * `null` is a real answer here — an active conversation should not carry a
 * badge that says "Active" on every line of a list.
 */
export function smsLifecycleLine(
  conversation: Pick<SmsConversationSummary, "snoozeUntil" | "archivedAt">,
  now: number,
  formatDeadline: (iso: string) => string,
): string | null {
  const state = smsConversationLifecycle(conversation, now);
  if (state === "archived") return "Archived";
  if (state === "snoozed" && conversation.snoozeUntil) {
    return `Snoozed until ${formatDeadline(conversation.snoozeUntil)}`;
  }
  return null;
}

/**
 * What the row can honestly say about assignment.
 *
 * The wire carries an assignee USER ID and nothing else — no name, no email —
 * and this screen has no workspace roster loaded, so "Assigned to a teammate"
 * is the strongest true statement available for someone else's id. Inventing a
 * name, or silently rendering the raw uuid, would both be worse.
 */
export function smsAssignmentLine(
  conversation: Pick<SmsConversationSummary, "assigneeUserId">,
  currentUserId: string | null,
): string | null {
  const assignee = conversation.assigneeUserId;
  if (!assignee) return null;
  return currentUserId && assignee === currentUserId
    ? "Assigned to you"
    : "Assigned to a teammate";
}

export function snoozeUntilIso(id: SmsSnoozePresetId, now: number): string {
  const preset = SMS_SNOOZE_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown snooze preset: ${id}`);
  return new Date(now + preset.ms).toISOString();
}

export function smsTriageOptions(input: {
  /** `null` when the caller has no lifecycle stamps — see rule 2 above. */
  conversation: Pick<
    SmsConversationSummary,
    "snoozeUntil" | "archivedAt" | "assigneeUserId"
  > | null;
  now: number;
  currentUserId: string | null;
}): SmsTriageOption[] {
  const { conversation, now, currentUserId } = input;
  const state = conversation
    ? smsConversationLifecycle(conversation, now)
    : null;
  const options: SmsTriageOption[] = [];

  if (state === "snoozed" || state === null) {
    options.push({
      id: "unsnooze",
      label: "Wake now",
      hint: "Clears the snooze and returns it to Active.",
    });
  }
  if (state !== "snoozed") {
    for (const preset of SMS_SNOOZE_PRESETS) {
      options.push({ id: preset.id, label: preset.label });
    }
  } else {
    // Re-snoozing from a snoozed row is a real need ("not yet, give it a day"),
    // but it should not be the first thing under the finger.
    for (const preset of SMS_SNOOZE_PRESETS) {
      options.push({
        id: preset.id,
        label: preset.label.replace("Snooze", "Re-snooze"),
      });
    }
  }
  if (state === "archived" || state === null) {
    options.push({
      id: "unarchive",
      label: "Restore from archive",
    });
  }
  if (state !== "archived") {
    options.push({
      id: "archive",
      label: "Archive",
      hint: "Hides it from Active. It stays readable under the Archived filter.",
    });
  }

  const assignee = conversation?.assigneeUserId ?? null;
  const mine = Boolean(currentUserId && assignee === currentUserId);
  if (currentUserId && !mine) {
    options.push({
      id: "assign_me",
      label: "Assign to me",
      ...(assignee ? { hint: "Takes it over from another teammate." } : {}),
    });
  }
  if (assignee || state === null) {
    options.push({ id: "unassign", label: "Clear the assignee" });
  }
  return options;
}

/** The request this option represents. Pure — the caller performs it. */
export function smsTriageIntentFor(
  id: SmsTriageOptionId,
  input: { phoneE164: string; now: number; currentUserId: string | null },
): SmsTriageIntent {
  switch (id) {
    case "snooze_1h":
    case "snooze_8h":
    case "snooze_24h":
      return {
        action: "snooze",
        phoneE164: input.phoneE164,
        until: snoozeUntilIso(id, input.now),
      };
    case "unsnooze":
      return { action: "unsnooze", phoneE164: input.phoneE164 };
    case "archive":
      return { action: "archive", phoneE164: input.phoneE164 };
    case "unarchive":
      return { action: "unarchive", phoneE164: input.phoneE164 };
    case "assign_me": {
      if (!input.currentUserId) {
        throw new Error("No signed-in user id is available to assign to.");
      }
      return {
        action: "assign",
        phoneE164: input.phoneE164,
        userId: input.currentUserId,
      };
    }
    case "unassign":
      return { action: "assign", phoneE164: input.phoneE164, userId: null };
  }
}

/** Past-tense confirmation, spoken after the server acknowledged the write. */
export function smsTriageDoneMessage(id: SmsTriageOptionId): string {
  switch (id) {
    case "snooze_1h":
      return "Snoozed for 1 hour.";
    case "snooze_8h":
      return "Snoozed for 8 hours.";
    case "snooze_24h":
      return "Snoozed for 24 hours.";
    case "unsnooze":
      return "Back in Active.";
    case "archive":
      return "Archived.";
    case "unarchive":
      return "Restored from the archive.";
    case "assign_me":
      return "Assigned to you.";
    case "unassign":
      return "Assignee cleared.";
  }
}
