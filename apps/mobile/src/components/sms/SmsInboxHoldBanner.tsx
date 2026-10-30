/**
 * SmsInboxHoldBanner — the inbox-level warning for an unresolved encrypted
 * reply intent. Sentence choice is the pure `smsInboxHoldBanner`
 * (node-tested); this file only paints it and, when a visible row carries the
 * hold, navigates to that thread.
 */
import { router } from "expo-router";
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import type { SmsInboxHoldBanner as Banner } from "@/lib/smsInboxHoldRollup";
import { threadPath } from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsInboxHoldBanner({ banner }: { banner: Banner | null }) {
  const { t } = useTheme();
  if (!banner) return null;
  const color = banner.tone === "danger" ? t.danger : t.warning;
  const text = (
    <Text
      accessibilityLiveRegion="assertive"
      {...typeCap("caption")}
      style={{
        color,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {banner.text}
    </Text>
  );
  if (!banner.targetPhone) return text;
  const target = banner.targetPhone;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(threadPath(target));
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open the held conversation with ${target}`}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: "center" }}
    >
      {text}
    </Pressable>
  );
}
