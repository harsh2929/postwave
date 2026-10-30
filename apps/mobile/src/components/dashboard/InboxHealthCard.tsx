/**
 * InboxHealthCard — deliverability score at a glance.
 *
 * The bug this fixes is a trust bug, not a cosmetic one: the affordance read
 * `{hasHealth ? "Report >" : "Settings >"}` while `onPress` unconditionally
 * pushed `/(tabs)/settings`, and the accessibility label repeated the false
 * promise ("Open report"). Tapping a thing must do what the thing says.
 *
 * Now the label and the destination are derived from the same value: with a
 * score, "Report" opens the Deliverability hub — the screen that owns this
 * number, its breaches and the auto-throttle state; without one, "Settings"
 * opens the place where the missing signal is configured.
 */
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import type { DashboardStats } from "@/hooks/useDashboard";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { forwardChevron } from "@/lib/direction";

export interface InboxHealthCardProps {
  stats: DashboardStats | undefined;
  loading: boolean;
}

interface Destination {
  label: string;
  route: "/(tabs)/deliverability" | "/(tabs)/settings";
  spoken: string;
}

export function InboxHealthCard({ stats, loading }: InboxHealthCardProps) {
  const { t } = useTheme();
  const health = stats?.inbox_health ?? null;
  const score = typeof health?.score === "number" ? health.score : null;
  const state = health?.state && health.state.trim() ? health.state : null;
  const hasHealth = score !== null || state !== null;

  // Tone the dot by score: >=80 healthy, >=50 warning, else danger. The detail
  // line carries the same information in words, so the colour is never the
  // only signal.
  const dotColor =
    score === null
      ? t.fgSubtle
      : score >= 80
        ? t.success
        : score >= 50
          ? t.warning
          : t.danger;

  const detail = loading
    ? "Checking deliverability…"
    : hasHealth
      ? `Score ${score ?? 0}/100${state ? ` · ${state}` : ""}`
      : "Inbox health data is not available yet.";

  const destination: Destination = hasHealth
    ? {
        label: "Report",
        route: "/(tabs)/deliverability",
        spoken: `Inbox health, ${detail}. Open the deliverability hub.`,
      }
    : {
        label: "Settings",
        route: "/(tabs)/settings",
        spoken:
          "Inbox health data is not available yet. Open settings to configure sending.",
      };

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        marginTop: 14,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => {
          haptics.tap();
          router.push(destination.route);
        }}
        accessibilityRole="button"
        accessibilityLabel={destination.spoken}
        android_ripple={{ color: t.borderSubtle }}
        // NativeWind v4: a function-style `style` on a Pressable silently drops
        // layout. Static object only.
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 14,
          minHeight: 44,
        }}
      >
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: dotColor,
          }}
        />
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Inbox health
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              marginTop: 2,
              fontFamily: FONT.regular,
            }}
            numberOfLines={2}
          >
            {detail}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {destination.label}
          </Text>
          {/* The chevron is an ICON drawn as a glyph, not content: it is out
              of the copy (where a directional character does not belong) and
              out of the a11y tree, and it is the one case where
              `allowFontScaling={false}` is right — an affordance arrow that
              grows to 30pt beside a capped label is a rendering bug. */}
          <Text
            allowFontScaling={false}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{ color: t.accent, fontSize: 13, fontFamily: FONT.bold }}
          >
            {forwardChevron()}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}
