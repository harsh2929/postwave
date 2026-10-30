/**
 * HubBanner — the one thing an operator must not miss.
 *
 * Auto-throttle means Moosewave has ALREADY cut this workspace's send rate. A
 * user who does not know that spends the morning debugging "why is the
 * campaign crawling" and never finds the answer, because the answer is not in
 * the campaign. It gets `accessibilityLiveRegion` so it is announced when it
 * appears mid-session, and a glyph so the state is not carried by tint alone.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { HubBanner as HubBannerModel } from "@/lib/deliverabilityHubView";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface HubBannerProps {
  banner: HubBannerModel | null;
}

export function HubBanner({ banner }: HubBannerProps) {
  const { t } = useTheme();
  if (!banner) return null;
  const color =
    banner.tone === "danger"
      ? t.danger
      : banner.tone === "warning"
        ? t.warning
        : t.info;
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${banner.title}. ${banner.message}`}
      style={{
        backgroundColor: t.surface,
        borderColor: color,
        borderWidth: 1,
        borderLeftWidth: 4,
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
        flexDirection: "row",
        gap: 10,
      }}
    >
      {/* Decorative: the alert role and the spoken label carry the meaning,
          so this glyph must not grow with the OS text size and shove the
          message column off a 320pt screen. */}
      <Text
        allowFontScaling={false}
        importantForAccessibility="no"
        style={{ color, fontSize: 15, fontFamily: FONT.semibold }}
      >
        ⚠
      </Text>
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          {...typeCap("heading")}
          style={{ color, ...typeStyle("heading"), fontFamily: FONT.semibold }}
        >
          {banner.title}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {banner.message}
        </Text>
      </View>
    </View>
  );
}
