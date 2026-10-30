/**
 * SubjectLabLinkCard — the Voice tab's pointer to the Subject Lab.
 *
 * Mobile's AI capability was real but homeless: `SubjectLineSuggestions`
 * generates subject lines inside the campaign subject sheet and the Voice tab
 * measures the brand voice — surfaces that never referred to one another, so
 * nothing on the device read as "the AI". (A third, the step editor's inline
 * buttons, was deleted under GATE#2: the endpoint behind them was deterministic
 * string templating, so labelling it AI was the opposite of this card's purpose.) The Subject Lab is where a subject line gets
 * an ANSWER rather than a suggestion, and the Voice tab is where an operator
 * already is when they are thinking about how the workspace sounds.
 *
 * Deliberately not role-gated. The lab's viewer-readable half (what has worked
 * for this list) is worth opening at any role; the admin-only scorer explains
 * itself on arrival rather than being hidden behind a link that silently is
 * not there.
 */
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import { Card } from "@/components/Card";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubjectLabLinkCard() {
  const { t } = useTheme();
  return (
    <Card style={{ padding: 0 }}>
      {/* Static style object — a function style on a Pressable silently drops
          layout under NativeWind v4. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open Subject Lab"
        accessibilityHint="Score subject lines against your own send history"
        onPress={() => {
          haptics.tap();
          router.push("/(tabs)/subject-lab");
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
            Subject Lab
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Score a subject line against what has actually worked for your list.
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
