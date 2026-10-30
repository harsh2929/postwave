/**
 * ReplyMailboxRow — one registration in the reply-capture registry.
 *
 * The row renders the mailbox's health as a labelled Pill plus a sentence, the
 * secret REFERENCE (never a secret), and — only for a manager — the two verbs
 * the phone owns: stop/start polling, and remove.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import {
  mailboxHealth,
  mailboxSummary,
  mailboxTone,
  type ReplyMailbox,
} from "@/lib/replyMailboxes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReplyMailboxRowProps {
  mailbox: ReplyMailbox;
  online: boolean;
  /** A mutation is in flight anywhere in the panel. */
  busy: boolean;
  mayManage: boolean;
  onToggle: (mailbox: ReplyMailbox) => void | Promise<void>;
  onDelete: (mailbox: ReplyMailbox) => void | Promise<void>;
}

export function ReplyMailboxRow({
  mailbox,
  online,
  busy,
  mayManage,
  onToggle,
  onDelete,
}: ReplyMailboxRowProps) {
  const { t } = useTheme();
  return (
    <View
      style={{
        marginTop: 10,
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fg,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {mailbox.label}
        </Text>
        <Pill label={mailboxHealth(mailbox)} tone={mailboxTone(mailbox)} />
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={3}
      >
        {mailboxSummary(mailbox)}
      </Text>
      {/* The secret REFERENCE, not a secret. It is the only thing that
          lets an operator spot a mis-typed pointer. */}
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: "Menlo",
        }}
        numberOfLines={1}
      >
        {mailbox.usernameSecretRef}
      </Text>
      {mailbox.securityQuarantinedAt ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Security quarantine: delete this legacy registration and add a safe replacement from web or desktop.
        </Text>
      ) : null}
      {mayManage ? (
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          <Pressable
            onPress={() => void onToggle(mailbox)}
            disabled={!online || busy || Boolean(mailbox.securityQuarantinedAt)}
            accessibilityRole="button"
            accessibilityLabel={`${mailbox.enabled ? "Stop polling" : "Start polling"} ${mailbox.label}`}
            accessibilityState={{
              disabled:
                !online || busy || Boolean(mailbox.securityQuarantinedAt),
            }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color:
                  !online || busy || mailbox.securityQuarantinedAt
                    ? t.fgSubtle
                    : t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {mailbox.enabled ? "Stop polling" : "Start polling"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void onDelete(mailbox)}
            disabled={!online || busy}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${mailbox.label}`}
            accessibilityState={{ disabled: !online || busy }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: !online || busy ? t.fgSubtle : t.danger,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Remove
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
