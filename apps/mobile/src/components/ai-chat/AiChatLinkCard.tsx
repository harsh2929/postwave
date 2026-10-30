/**
 * AiChatLinkCard — the Voice tab's pointer to Moosewave AI chat.
 *
 * Voice is where an operator is when they are thinking about how the
 * workspace sounds; the chat is where they ask for something written in it.
 * Same shape as SubjectLabLinkCard, and like it deliberately not role-gated:
 * the chat screen explains its editor floor on arrival rather than hiding
 * behind a link that silently is not there.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AiChatLinkCard() {
  const { t } = useTheme();
  return (
    <Card style={{ padding: 0 }}>
      {/* Static style object — a function style on a Pressable silently drops
          layout under NativeWind v4. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open Moosewave AI"
        accessibilityHint="Ask for a draft, a subject line or a summary"
        onPress={() => {
          haptics.tap();
          router.push("/(tabs)/ai-chat");
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 14,
          minHeight: 44,
        }}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
            }}
          >
            Moosewave AI
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Ask for a draft, a subject line or a summary, in a tone you pick.
          </Text>
        </View>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.accent,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          Open
        </Text>
      </Pressable>
    </Card>
  );
}
