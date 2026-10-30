/**
 * Meter — the one filled-bar implementation for this cluster.
 *
 * Used by the sending rate-limit meter and (when it lands) domain warm-up, so
 * there is a single bar rather than two that drift apart. A bar with no text
 * alternative is unreadable to a screen reader and unreadable to anyone with a
 * colour-vision deficiency, so this component insists on both:
 * `accessibilityRole="progressbar"` with a real `accessibilityValue`, and a
 * visible caption carrying the same numbers.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface MeterProps {
  label: string;
  /** 0-1, or null for "no cap configured" — which is NOT zero. */
  fraction: number | null;
  tone: SignalTone;
  /** Visible caption under the bar, e.g. "3,210 / 5,000 · resets in 22m". */
  caption: string;
  /** Spoken value; defaults to the caption. */
  accessibilityValueText?: string | undefined;
}

const TRACK_HEIGHT = 10;

export function Meter({
  label,
  fraction,
  tone,
  caption,
  accessibilityValueText,
}: MeterProps) {
  const { t } = useTheme();
  const fill =
    tone === "danger"
      ? t.danger
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.success
          : t.fgMuted;
  const percent =
    fraction === null
      ? null
      : Math.max(0, Math.min(100, Math.round(fraction * 100)));

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      {...(percent === null
        ? {}
        : { accessibilityValue: { min: 0, max: 100, now: percent } })}
      accessibilityHint={accessibilityValueText ?? caption}
      style={{ gap: 6 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {percent === null ? "No cap" : `${percent}%`}
        </Text>
      </View>
      <View
        style={{
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: t.bgSubtle,
          overflow: "hidden",
        }}
      >
        {percent === null ? null : (
          <View
            style={{
              width: `${Math.max(percent, 2)}%`,
              height: "100%",
              backgroundColor: fill,
              borderRadius: TRACK_HEIGHT / 2,
            }}
          />
        )}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {caption}
      </Text>
    </View>
  );
}
