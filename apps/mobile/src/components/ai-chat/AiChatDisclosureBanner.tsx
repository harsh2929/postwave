/**
 * AiChatDisclosureBanner — the Article 50(1) notice, ABOVE the first turn.
 *
 * The text is whatever lib/aiChat placed in the transcript's disclosure row,
 * which is `AI_DISCLOSURE_TEXT` from @postwave/ai-disclosure byte for byte —
 * the same constant SubjectLineSuggestions, AskAnalyticsSection and the
 * sequence-draft review render, and the one the Go gateway mirrors. Nothing
 * here paraphrases it; the second line only says how a reply arrives.
 */
import { Text, View } from "react-native";

import { AI_DISCLOSURE_LABEL } from "@postwave/ai-disclosure";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AiChatDisclosureBanner({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={AI_DISCLOSURE_LABEL}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 4,
        marginBottom: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {text}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Each reply is generated on the server and arrives whole once it is
        finished — nothing streams in word by word.
      </Text>
    </View>
  );
}
