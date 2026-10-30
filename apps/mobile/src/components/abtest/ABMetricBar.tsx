/**
 * ABMetricBar — the metric switcher plus the methodology link.
 *
 * Extracted from the A/B results route so the route file's render is a state
 * ladder and nothing else.
 */
import { Linking, Pressable, Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import type { ABMetric } from "@/api/abTests";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export const AB_METRICS: readonly { key: ABMetric; label: string }[] = [
  { key: "open_rate", label: "Open rate" },
  { key: "click_rate", label: "Click rate" },
  { key: "reply_rate", label: "Reply rate" },
];

const METHODOLOGY_URL = "https://docs.postwave.dev/ab-tests/methodology";

export function abMetricLabel(metric: ABMetric): string {
  return AB_METRICS.find((m) => m.key === metric)?.label ?? "Open rate";
}

export function ABMetricBar({
  metric,
  onChange,
  onOpenSettings,
}: {
  metric: ABMetric;
  onChange: (next: ABMetric) => void;
  /** Opens the A/B configuration sheet. Omitted hides the control. */
  onOpenSettings?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <View
        style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", flex: 1 }}
        accessibilityLabel="Metric selector"
      >
        {AB_METRICS.map((m) => (
          <Chip
            key={m.key}
            label={m.label}
            active={metric === m.key}
            onPress={() => onChange(m.key)}
          />
        ))}
      </View>
      {onOpenSettings ? (
        <Pressable
          onPress={onOpenSettings}
          accessibilityRole="button"
          accessibilityLabel="A/B test settings"
          accessibilityHint="Winner metric, evaluation window and winner share"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              fontSize: 12,
              fontFamily: FONT.semibold,
            }}
          >
            Settings
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Why these stats? Opens the A/B test methodology docs"
        hitSlop={8}
        onPress={() => {
          void Linking.openURL(METHODOLOGY_URL).catch(() => {
            /* no-op: external link may be unavailable */
          });
        }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            fontFamily: FONT.regular,
            textDecorationLine: "underline",
          }}
        >
          Why these stats?
        </Text>
      </Pressable>
    </View>
  );
}
