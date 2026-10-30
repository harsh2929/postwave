/**
 * SmsConversationTriageSheet — the verbs behind the inbox's own filter chips.
 *
 * The SMS inbox shipped a four-way lifecycle control (Active / Snoozed /
 * Archived / Any) with live server counts and no way to move a row between
 * them: `POST .../snooze|unsnooze|archive|unarchive|assign` have been mounted
 * on the same admin chain as the list itself since
 * apps/api/internal/sms/inbox_extras.go:54-58, and mobile's transport had none
 * of them. This sheet is where they land.
 *
 * WHY `RowActionSheet` AND NOT A SWIPE. A swipe has no affordance and VoiceOver
 * cannot perform it, and the verb set here is not binary — three snooze
 * durations, archive, and assignment do not fit two swipe rails. The row keeps
 * a visible "More" button (a real, focusable control) and long-press as the
 * accelerator, so nothing is reachable only by gesture.
 *
 * WHY THE SHEET IS DUMB. Which options exist for a given lifecycle state is a
 * rule, not a rendering detail, so it lives in `smsTriageOptions` where node
 * tests can reach it. This file decides layout and nothing else.
 */
import { RowActionSheet, type RowAction } from "@/components/RowActionSheet";
import type { SmsConversationSummary } from "@/lib/smsConversation";

import { smsTriageOptions, type SmsTriageOptionId } from "./smsTriageOptions";

export interface SmsConversationTriageSheetProps {
  visible: boolean;
  /**
   * `null` when the caller holds no lifecycle stamps — the thread screen
   * reaches triage through `GET .../context`, which does not carry them. The
   * option builder then offers the full verb set instead of guessing.
   */
  conversation: Pick<
    SmsConversationSummary,
    "snoozeUntil" | "archivedAt" | "assigneeUserId"
  > | null;
  /** What the sheet is acting on, spoken in its header. */
  title: string;
  subtitle?: string | undefined;
  currentUserId: string | null;
  now: number;
  /** A write is in flight; every verb is disabled rather than queued. */
  busy: boolean;
  onClose: () => void;
  onSelect: (option: SmsTriageOptionId) => void;
}

export function SmsConversationTriageSheet({
  visible,
  conversation,
  title,
  subtitle,
  currentUserId,
  now,
  busy,
  onClose,
  onSelect,
}: SmsConversationTriageSheetProps) {
  const options = smsTriageOptions({ conversation, now, currentUserId });
  const actions: RowAction[] = options.map((option) => ({
    key: option.id,
    label: option.label,
    ...(option.hint ? { hint: option.hint } : {}),
    disabled: busy,
    ...(busy ? { disabledReason: "A previous change is still saving." } : {}),
    onPress: () => onSelect(option.id),
  }));
  return (
    <RowActionSheet
      visible={visible}
      title={title}
      {...(subtitle
        ? { subtitle }
        : conversation === null
          ? {
              subtitle:
                "The current snooze and archive state isn't loaded here, so every option is offered.",
            }
          : {})}
      actions={actions}
      onClose={onClose}
    />
  );
}
