/**
 * AiChatEmptyState — prompt starters for an empty transcript.
 *
 * One per kind the handler accepts (campaign_draft / subject_line / summary
 * / free_form), so the first tap teaches what the surface is for. None of
 * them promises workspace figures: the aichat route forwards the prompt and
 * nothing else, so a starter that asked "how did last month perform" would
 * teach the opposite lesson.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const AI_CHAT_STARTERS: readonly string[] = [
  "Draft a re-engagement email for subscribers who have gone quiet",
  "Write five subject lines for a spring sale announcement",
  "Summarise what makes a welcome email worth opening",
  "Rewrite this in plainer language: ",
];

export function AiChatEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8, marginTop: 4 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        Try asking
      </Text>
      {AI_CHAT_STARTERS.map((starter) => (
        <Pressable
          key={starter}
          accessibilityRole="button"
          accessibilityLabel={`Use starter: ${starter.trim()}`}
          onPress={() => {
            haptics.tap();
            onPick(starter);
          }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.borderSubtle,
            backgroundColor: t.surface,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {starter}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
