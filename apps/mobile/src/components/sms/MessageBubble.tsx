/**
 * MessageBubble — one SMS in a thread.
 *
 * Direction is expressed three ways, not one: alignment, colour, AND the
 * spoken label. Alignment alone is invisible to a screen reader and colour
 * alone is invisible to a colour-blind user, so both are backed by text.
 *
 * Delivery state matters more here than in a chat app, because an SMS that
 * failed at the carrier is money spent and a customer not answered. A failed
 * send is called out in the danger colour AND in words, and an unknown provider
 * status is shown as "sending" rather than optimistically as delivered.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { time } from "@/lib/format";
import { SMS_INBOX_BODY_MAX_CODE_POINTS } from "@/lib/smsBodyContract";
import {
  deliveryVerdict,
  safeSmsDisplayText,
  type SmsMessage,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MessageBubble({ message }: { message: SmsMessage }) {
  const { t } = useTheme();
  const outbound = message.direction === "outbound";
  const verdict = outbound ? deliveryVerdict(message.status) : null;
  const failed = verdict === "failed";
  const displayBody =
    message.bodyOmittedReason === "body_exceeds_inbox_limit"
      ? "Message text unavailable because it exceeds the safe inbox display limit"
      : message.bodyOmittedReason === "legacy_body_unavailable"
        ? "Legacy message content unavailable"
        : message.body;

  const safeError = message.errorMessage
    ? safeSmsDisplayText(message.errorMessage, 240)
    : "";
  const statusLine = outbound
    ? failed
      ? `Failed${safeError ? ` — ${safeError}` : ""}`
      : verdict === "delivered"
        ? "Delivered"
        : verdict === "sent"
          ? "Sent — delivery not confirmed"
          : verdict === "accepted"
            ? "Accepted by provider"
            : verdict === "queued"
              ? "Queued"
              : verdict === "reconciliation"
                ? "Reconciling — do not retry"
                : "Sending…"
    : "";

  return (
    <View
      style={{
        alignSelf: outbound ? "flex-end" : "flex-start",
        maxWidth: "85%",
        marginBottom: 10,
      }}
    >
      <View
        style={{
          backgroundColor: outbound ? t.accentSubtle : t.surface,
          borderColor: failed ? t.danger : t.borderSubtle,
          borderWidth: 1,
          borderRadius: 16,
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        {/* The message itself is the most reflow-friendly text in the app —
            a bubble is 85% width and grows down. It gets the `body` role's
            full 1.8x, not a hand-picked ceiling. */}
        <Text
          accessible
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            flexShrink: 1,
            writingDirection: "auto",
          }}
        >
          {safeSmsDisplayText(displayBody, SMS_INBOX_BODY_MAX_CODE_POINTS)}
        </Text>
        {message.mediaUrl ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
            numberOfLines={1}
          >
            Attachment included
          </Text>
        ) : null}
      </View>
      <Text
        accessible
        accessibilityLabel={`${outbound ? "Outbound" : "Inbound"} message at ${time(
          message.createdAt,
        )}${statusLine ? `. ${statusLine}` : ""}`}
        {...typeCap("caption")}
        style={{
          color: failed ? t.danger : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
          textAlign: outbound ? "right" : "left",
          fontVariant: ["tabular-nums"],
        }}
      >
        {outbound ? "You" : "Them"} · {time(message.createdAt)}
        {statusLine ? ` · ${statusLine}` : ""}
      </Text>
    </View>
  );
}
