/**
 * SmsConversationRow — one row of the SMS inbox, and the entry point to triage.
 *
 * Extracted from `app/(tabs)/sms/index.tsx` when the row grew a lifecycle
 * summary and a triage control; the screen file was over this app's 450-line
 * source budget with it inlined.
 *
 * TWO THINGS THIS ROW EXISTS TO GET RIGHT.
 *
 * 1. IT SHOWS THE STATE THE WIRE ALREADY CARRIED. `snoozeUntil`, `archivedAt`
 *    and `assigneeUserId` have been decoded by `smsConversationWire` since the
 *    inbox shipped and were rendered by nothing, so under the "Any" filter a
 *    snoozed conversation was indistinguishable from a live one and an assigned
 *    conversation looked unowned.
 *
 * 2. THE ROW BODY AND THE TRIAGE BUTTON ARE SIBLINGS, NEVER NESTED. A Pressable
 *    inside a Pressable is one hit-test target to the platform and one control
 *    to VoiceOver, so the inner action becomes unreachable — the repo guards it
 *    at src/lib/noNestedInteractiveControls.test.ts. Long press on the body is
 *    an accelerator only; the visible "More" button is the real affordance.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import {
  smsAssignmentLine,
  smsLifecycleLine,
} from "@/components/sms/smsTriageOptions";
import { FONT } from "@/lib/fonts";
import { dateTime, num, plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  conversationTitle,
  safeSmsDisplayText,
  threadPath,
  type SmsConversationSummary,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SmsConversationRowProps {
  conversation: SmsConversationSummary;
  /** Ticking clock, so "snoozed until" stops being true when it stops being true. */
  now: number;
  currentUserId: string | null;
  /** False offline or for a session that cannot write — no dead control. */
  canTriage: boolean;
  onTriage: (conversation: SmsConversationSummary) => void;
  /**
   * Multi-select mode: tapping the body TOGGLES membership instead of
   * navigating, the triage button hides, and the row announces its checked
   * state. The screen owns the selection set; the row only reports taps.
   */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: ((conversation: SmsConversationSummary) => void) | undefined;
}

export function SmsConversationRow({
  conversation,
  now,
  currentUserId,
  canTriage,
  onTriage,
  selectionMode = false,
  selected = false,
  onToggleSelect,
}: SmsConversationRowProps) {
  const { t } = useTheme();
  const unread = conversation.unreadCount > 0;
  const title = conversationTitle(conversation);
  const lifecycle = smsLifecycleLine(conversation, now, dateTime);
  const assignment = smsAssignmentLine(conversation, currentUserId);
  const openTriage = () => {
    haptics.tap();
    onTriage(conversation);
  };
  const preview = previewText(conversation);
  const bodyLabel = rowAccessibilityLabel({
    selectionMode,
    title,
    unreadCount: conversation.unreadCount,
    lifecycle,
    assignment,
  });
  return (
    <View style={{ marginBottom: 8 }}>
      <Card>
        <View
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
        >
          <Pressable
            onPress={() => {
              haptics.tap();
              if (selectionMode) {
                onToggleSelect?.(conversation);
                return;
              }
              router.push(threadPath(conversation.phoneE164));
            }}
            {...(canTriage && !selectionMode ? { onLongPress: openTriage } : {})}
            accessibilityRole={selectionMode ? "checkbox" : "button"}
            {...(selectionMode
              ? { accessibilityState: { checked: selected } }
              : {})}
            accessibilityLabel={bodyLabel}
            accessibilityHint={
              selectionMode
                ? "Toggles this conversation in the bulk selection."
                : "Message content is read as separate text inside the thread."
            }
            style={{
              flex: 1,
              ...(selectionMode && selected
                ? {
                    borderStartWidth: 3,
                    borderStartColor: t.accent,
                    paddingStart: 8,
                  }
                : {}),
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: unread ? FONT.semibold : FONT.medium,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {safeSmsDisplayText(title, 320)}
              </Text>
              {unread ? (
                <Pill
                  label={`${num(conversation.unreadCount)} new`}
                  tone="info"
                />
              ) : null}
            </View>
            {lifecycle || assignment ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {lifecycle ? (
                  <Pill
                    label={lifecycle}
                    tone={lifecycle === "Archived" ? "neutral" : "warning"}
                  />
                ) : null}
                {assignment ? <Pill label={assignment} tone="neutral" /> : null}
              </View>
            ) : null}
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: unread ? t.fg : t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 6,
                flexShrink: 1,
                writingDirection: "auto",
              }}
              numberOfLines={2}
            >
              {conversation.lastDirection === "outbound" ? "You: " : ""}
              {safeSmsDisplayText(preview, 512)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 6,
                fontVariant: ["tabular-nums"],
              }}
            >
              {relativeTime(conversation.lastMessageAt)} ·{" "}
              {plural(conversation.messageCount, "message")}
              {conversation.identityAmbiguous
                ? " · multiple subscriber identities"
                : conversation.subscriberEmail
                  ? ""
                  : " · unknown sender"}
            </Text>
          </Pressable>
          {canTriage && !selectionMode ? (
            // A visible, focusable control — long press alone has no affordance
            // and VoiceOver cannot perform it at all.
            <Pressable
              onPress={openTriage}
              accessibilityRole="button"
              accessibilityLabel={`Triage options for ${title}`}
              accessibilityHint="Snooze, archive or assign this conversation"
              hitSlop={8}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: "flex-end",
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                More
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

function previewText(
  conversation: Pick<
    SmsConversationSummary,
    "lastMessagePreview" | "lastMessagePreviewOmittedReason" | "lastDirection"
  >,
): string {
  if (
    conversation.lastMessagePreviewOmittedReason === "body_exceeds_inbox_limit"
  ) {
    return "Message preview unavailable because it exceeds the safe inbox display limit";
  }
  if (
    conversation.lastMessagePreviewOmittedReason === "legacy_body_unavailable"
  ) {
    return "Legacy message preview unavailable";
  }
  const trimmed = conversation.lastMessagePreview.trim();
  if (trimmed) return trimmed;
  return conversation.lastDirection === "outbound"
    ? "You sent a message"
    : "No preview";
}

function rowAccessibilityLabel(input: {
  selectionMode: boolean;
  title: string;
  unreadCount: number;
  lifecycle: string | null;
  assignment: string | null;
}): string {
  const parts = [
    `${input.selectionMode ? "Select" : "Open"} conversation with ${input.title}`,
  ];
  if (input.unreadCount > 0) {
    parts.push(plural(input.unreadCount, "unread message"));
  }
  if (input.lifecycle) parts.push(input.lifecycle);
  if (input.assignment) parts.push(input.assignment);
  return parts.join(", ");
}
