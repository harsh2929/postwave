/**
 * AiChatAccessNotice — why the composer is not offered, in one card.
 *
 * A held server is rendered as exactly that: the server's own sentence and
 * its code, with no Retry, no composer and no pretence of a chat. The other
 * three are the ordinary reasons a phone cannot ask right now.
 */
import { Text, View } from "react-native";

import type { AiChatFailure } from "@/lib/aiChatFailures";
import type { AiChatAccess } from "@/lib/aiChatTranscript";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TITLES: Record<Exclude<AiChatAccess["kind"], "ready">, string> = {
  held: "Blocked on the server",
  no_tenant: "Reconnect your workspace",
  offline: "Reconnect to ask",
  role: "Chatting needs editor access",
};

export function AiChatAccessNotice({
  access,
  hold,
}: {
  access: AiChatAccess;
  hold: AiChatFailure | null;
}) {
  const { t } = useTheme();
  if (access.kind === "ready") return null;
  const held = access.kind === "held";
  return (
    <View
      accessibilityRole={held ? "alert" : "text"}
      style={{
        backgroundColor: t.surface,
        borderColor: held ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 6,
        marginBottom: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {TITLES[access.kind]}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {access.message}
      </Text>
      {held && hold?.code ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Server code: ${hold.code}. Clear the conversation to start again once the hold is lifted.`}
        </Text>
      ) : null}
    </View>
  );
}
