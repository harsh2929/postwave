/**
 * HelpdeskMessageBubble — one message in a support thread.
 *
 * Delivery is never inferred from direction. Historical outbound records are
 * explicitly unverified, while internal notes explicitly say not delivered.
 */
import { Text, View } from "react-native";

import { humanizeToken, type HelpdeskMessage } from "@/lib/helpdesk";
import { FONT } from "@/lib/fonts";
import { plural, time } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HelpdeskMessageBubble({
  message,
}: {
  message: HelpdeskMessage;
}) {
  const { t } = useTheme();
  const internal = message.direction === "internal";
  const outbound = message.direction === "outbound";
  const fact = internal
    ? "Internal note · not delivered"
    : outbound
      ? "Outbound record · delivery unverified"
      : "Inbound record · received";
  const actor = humanizeToken(message.senderType);
  const body =
    message.body ??
    (message.bodyOmittedReason
      ? "Content unavailable: " + humanizeToken(message.bodyOmittedReason).toLowerCase()
      : message.attachmentCount > 0
        ? "No text · " + plural(message.attachmentCount, "attachment") + " recorded"
        : "No message text recorded");
  const sender =
    message.sender && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(message.sender)
      ? message.sender
      : null;

  return (
    <View
      style={{
        alignSelf: internal ? "center" : outbound ? "flex-end" : "flex-start",
        maxWidth: internal ? "100%" : "85%",
        marginBottom: 10,
      }}
    >
      <View
        style={{
          backgroundColor: outbound && !internal ? t.accentSubtle : t.surface,
          borderColor: internal ? t.warning : t.borderSubtle,
          borderWidth: 1,
          borderRadius: 16,
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 4,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: internal ? t.warning : t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          {fact}
          {` · ${actor}`}
          {sender ? ` · ${sender}` : ""}
        </Text>
        {/* The message is the most reflow-friendly text on the screen — a
            bubble is 85% wide and grows downward — so it gets the body role's
            full ceiling rather than a hand-picked one. */}
        <Text
          accessibilityLabel={body}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            writingDirection: "auto",
          }}
        >
          {body}
        </Text>
        {message.projectionTruncated ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("caption")}
            style={{
              color: t.warning,
              ...typeStyle("caption"),
              fontFamily: FONT.medium,
            }}
          >
            The server truncated this safe display projection. Raw evidence is
            unavailable here.
          </Text>
        ) : null}
        {message.body && message.attachmentCount > 0 ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {plural(message.attachmentCount, "attachment")} recorded; raw
            attachments are unavailable here.
          </Text>
        ) : null}
        <Text
          {...typeCap("caption")}
          importantForAccessibility="no"
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {time(message.at, "—")}
        </Text>
      </View>
    </View>
  );
}
