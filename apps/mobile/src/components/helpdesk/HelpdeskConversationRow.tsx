/**
 * HelpdeskConversationRow — one waiting customer in the queue.
 *
 * What a support triage row has to answer, in order: WHO is waiting, WHAT
 * about, HOW LONG, and whether anyone has picked it up. Everything else
 * (tags, priority weight, channel routing) belongs on the desk, where there
 * is room for it.
 *
 * A thread that has never been spoken in has no `last_message_at`; it says
 * "no messages yet" rather than rendering an epoch or an empty slot.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import {
  conversationSubtitle,
  conversationTitle,
  humanizeToken,
  statusTone,
  type HelpdeskConversation,
} from "@/lib/helpdesk";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HelpdeskConversationRow({
  conversation,
  onOpen,
}: {
  conversation: HelpdeskConversation;
  onOpen: (conversation: HelpdeskConversation) => void;
}) {
  const { t } = useTheme();
  const title = conversationTitle(conversation);
  const subtitle = conversationSubtitle(conversation);
  const stamp = conversation.lastMessageAt ?? conversation.updatedAt;
  const when = stamp ? relativeTime(stamp) : "No messages yet";
  const spokenWhen = stamp ? dateTime(stamp) : "no messages yet";
  const spokenRequester =
    title === "Unidentified sender"
      ? "Customer-supplied requester identity unavailable."
      : `Customer-supplied requester: ${title}.`;
  const spokenSubject = conversation.subject
    ? `Customer-supplied subject: ${conversation.subject}.`
    : "Customer-supplied subject unavailable.";
  const spokenChannel = conversation.channelType
    ? `Recorded channel: ${humanizeToken(conversation.channelType)}.`
    : "Recorded channel unavailable.";
  const assignmentLabel =
    conversation.assignmentState === "tenant_active_user"
      ? "Assigned"
      : conversation.assignmentState === "legacy_unverified"
        ? "Legacy assignment unverified"
        : "Unassigned";

  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onOpen(conversation);
      }}
      accessibilityRole="button"
      accessibilityLabel={`${spokenRequester} ${spokenSubject} ${spokenChannel} Recorded status: ${humanizeToken(
        conversation.status,
      )}. Recorded activity time: ${spokenWhen}. Recorded assignment: ${
        conversation.assignmentState === "tenant_active_user"
          ? "assigned to a verified active workspace member."
          : conversation.assignmentState === "legacy_unverified"
            ? "legacy assignment is unverified; no assignee identity is shown."
            : "unassigned."
      }`}
      accessibilityHint="Opens the conversation"
      // NativeWind v4: a function-style style prop silently drops layout.
      style={{ marginBottom: 8 }}
    >
      <Card>
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
              fontFamily: FONT.semibold,
              flex: 1,
              writingDirection: "auto",
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Pill
            label={humanizeToken(conversation.status)}
            tone={statusTone(conversation.status)}
            size="sm"
          />
        </View>

        {subtitle ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 6,
              writingDirection: "auto",
            }}
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        ) : null}

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
          {when}
          {conversation.sourceType
            ? ` · ${humanizeToken(conversation.sourceType)}`
            : ""}
          {` · ${assignmentLabel}`}
        </Text>
      </Card>
    </Pressable>
  );
}
