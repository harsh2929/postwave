/** Online-only SMS composer with explicit sender and consent-list identity. */
import { Pressable, Text, TextInput, View } from "react-native";

import { MAX_SMS_REPLY_CODE_POINTS } from "@/api/smsInbox";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { isValidSmsReplyBody } from "@/lib/smsBodyContract";
import {
  safeSmsDisplayText,
  type SmsEligibleList,
  type SmsSenderProfile,
} from "@/lib/smsConversation";
import { segmentInfo } from "@/lib/smsSegments";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface ReplyComposerProps {
  value: string;
  onChangeText: (next: string) => void;
  onSend: () => void;
  sending: boolean;
  enabled: boolean;
  disabledReason: string | null;
  senders: readonly SmsSenderProfile[];
  senderId: string;
  onSenderChange: (id: string) => void;
  lists: readonly SmsEligibleList[];
  listId: string;
  onListChange: (id: string) => void;
  /**
   * Opens the canned-response picker. Optional so the composer renders
   * unchanged where the library is not wired; the button only appears for a
   * session that could write (the caller gates it on access).
   */
  onOpenQuickReplies?: (() => void) | undefined;
}

export function ReplyComposer({
  value,
  onChangeText,
  onSend,
  sending,
  enabled,
  disabledReason,
  senders,
  senderId,
  onSenderChange,
  lists,
  listId,
  onListChange,
  onOpenQuickReplies,
}: ReplyComposerProps) {
  const { t } = useTheme();
  const trimmed = value.trim();
  const characters = Array.from(value).length;
  const canSend =
    enabled &&
    !disabledReason &&
    !sending &&
    trimmed.length > 0 &&
    isValidSmsReplyBody(value) &&
    Boolean(senderId && listId);
  const info = segmentInfo(value);
  const senderOptions = senders.map((sender) => ({
    value: sender.id,
    label: safeSmsDisplayText(sender.phoneNumber || sender.provider, 64),
  }));
  const listOptions = lists.map((list) => ({
    value: list.id,
    label: safeSmsDisplayText(list.name, 80),
  }));

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        backgroundColor: t.bg,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 12,
        gap: 8,
      }}
    >
      {senderOptions.length > 0 ? (
        <SegmentedControl
          options={senderOptions}
          value={senderId}
          onChange={onSenderChange}
          accessibilityLabel="SMS sender profile"
          scrollable
        />
      ) : null}
      {listOptions.length > 0 ? (
        <SegmentedControl
          options={listOptions}
          value={listId}
          onChange={onListChange}
          accessibilityLabel="Consent list for this reply"
          scrollable
        />
      ) : null}
      {disabledReason ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{ color: t.warning, ...typeStyle("caption"), fontFamily: FONT.medium }}
        >
          {disabledReason}
        </Text>
      ) : null}
      {info.showCounter || characters > MAX_SMS_REPLY_CODE_POINTS ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color:
              characters > MAX_SMS_REPLY_CODE_POINTS || info.unicode
                ? t.warning
                : t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {num(characters)} / {num(MAX_SMS_REPLY_CODE_POINTS)} characters ·{" "}
          {info.segments === 1 ? "1 segment" : `${num(info.segments)} segments`}
          {info.unicode ? " · non-GSM characters shorten each segment to 70" : ""}
        </Text>
      ) : null}
      {onOpenQuickReplies ? (
        <Pressable
          onPress={onOpenQuickReplies}
          accessibilityRole="button"
          accessibilityLabel="Insert a quick reply"
          accessibilityHint="Opens the canned-response library; picking inserts text into the draft."
          hitSlop={8}
          style={{ minHeight: 32, justifyContent: "center", alignSelf: "flex-start" }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.accent,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
            }}
          >
            Quick replies
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={enabled && !sending}
          placeholder={enabled ? "Reply…" : disabledReason ?? "Reply unavailable"}
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Reply message"
          multiline
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 20,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12,
            color: t.fg,
            fontSize: fontSizeFor("body"),
            fontFamily: FONT.regular,
            writingDirection: "auto",
          }}
          {...typeCap("body")}
        />
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={sending ? "Sending reply" : "Send reply"}
          accessibilityState={{ disabled: !canSend }}
          style={{
            minWidth: 64,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            paddingHorizontal: 16,
            backgroundColor: canSend ? t.accent : t.surfaceElevated,
            opacity: canSend ? 1 : 0.6,
          }}
        >
          <Text
            {...typeCap("control")}
            importantForAccessibility="no"
            style={{
              color: canSend ? t.accentFg : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {sending ? "…" : "Send"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
