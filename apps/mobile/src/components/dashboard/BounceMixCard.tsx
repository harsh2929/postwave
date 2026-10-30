/**
 * BounceMixCard — the dashboard's hard/soft/blocked split.
 *
 * Sits directly under the Inbox health row, because it is the follow-up
 * question to the number that row reports: a bad score sends you looking for
 * WHICH failure, and until now the phone could only tell you HOW MUCH.
 *
 * Self-gating in four directions (all decided in `lib/dashboardBounceMix`, not
 * here), so on a healthy workspace the dashboard keeps exactly the shape it
 * has today. Tapping it opens the Deliverability hub, which owns the full
 * breakdown, the provider split and the warm-up state.
 *
 * Tone is never the only signal: every row states its class WORD, its count
 * and its share, and the card carries one composed spoken sentence.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useBounceClasses } from "@/hooks/useDeliverabilityDiagnostics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { bounceMixState } from "@/lib/dashboardBounceMix";
import { bounceClassTone } from "@/lib/deliverabilityDiagnostics";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function BounceMixCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const bounces = useBounceClasses("30d");
  const state = bounceMixState({
    breakdown: bounces.data,
    errored: bounces.isError,
    offline: !gate.enabled,
  });

  if (state.kind === "hidden") return null;

  const shell = {
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    marginTop: 10,
    padding: 14,
  } as const;

  if (state.kind === "unavailable") {
    return (
      <View accessibilityRole="text" accessibilityLabel={state.spoken} style={shell}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {state.body}
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push("/(tabs)/deliverability");
      }}
      accessibilityRole="button"
      accessibilityLabel={state.spoken}
      android_ripple={{ color: t.borderSubtle }}
      // NativeWind v4: a function-style `style` on a Pressable silently drops
      // layout. Static object only.
      style={{ ...shell, gap: 8 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
        // The Pressable's composed label already reads all of this.
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontWeight: "700",
            fontFamily: FONT.bold,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {state.heading}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
          numberOfLines={1}
        >
          {state.total}
        </Text>
      </View>

      {state.rows.map((row) => {
        const tone = bounceClassTone(row.code);
        const ink =
          tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.fgSubtle;
        return (
          <View
            key={row.code}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            importantForAccessibility="no-hide-descendants"
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: ink,
              }}
            />
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
              numberOfLines={1}
            >
              {row.count}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontFamily: FONT.medium,
                fontVariant: ["tabular-nums"],
                minWidth: 52,
                textAlign: "right",
              }}
              numberOfLines={1}
            >
              {row.share}
            </Text>
          </View>
        );
      })}
    </Pressable>
  );
}
