/**
 * EngagementGauge — circular indicator showing an engagement score 0..1.
 *
 * Renders as a pure-SVG arc that fills clockwise from the top. The
 * server-supplied `engagement_score` lives on SubscriberTimelineStats;
 * the parent passes it through unchanged.
 *
 * Tones:
 *   - score >= 0.66 → success (warm)
 *   - 0.33..0.66    → warning (lukewarm)
 *   - < 0.33        → fgSubtle (cold)
 *
 * Mirrors the desktop's engagement halo but rendered with the
 * mobile-themed accent stack.
 */
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface EngagementGaugeProps {
  /** Score in [0, 1]. Values outside the range are clamped. */
  score: number;
  size?: number;
  /** Optional label rendered below the score. */
  label?: string;
}

export function EngagementGauge({
  score,
  size = 96,
  label = "Engagement",
}: EngagementGaugeProps) {
  const { t } = useTheme();
  const clamped = Math.max(0, Math.min(1, score));
  const percent = Math.round(clamped * 100);
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = c * clamped;
  const tone =
    clamped >= 0.66 ? t.success : clamped >= 0.33 ? t.warning : t.fgSubtle;
  const cx = size / 2;
  const cy = size / 2;
  return (
    <View
      style={{ alignItems: "center" }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${label} score`}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: percent,
        text: `${percent} out of 100`,
      }}
    >
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={t.borderSubtle}
            strokeWidth={stroke}
            fill="none"
          />
          <Circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={tone}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${filled} ${c - filled}`}
            strokeDashoffset={c / 4}
            strokeLinecap="round"
          />
        </Svg>
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
          pointerEvents="none"
        >
          {/* Size stays keyed to the `size` prop (the arc's diameter), but
              the ceiling is `figure`'s — the tightest in the scale — because
              this number is centred inside an SVG circle that cannot grow.
              The exact value is already spoken by the gauge's
              accessibilityValue, so capping it costs no information. */}
          <Text
            {...typeCap("figure")}
            style={{
              color: t.fg,
              fontSize: Math.round(size * 0.23),
              fontFamily: FONT.display,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              letterSpacing: -0.5,
            }}
          >
            {percent}
          </Text>
        </View>
      </View>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("badgeSmall"),
          letterSpacing: 0.5,
          fontFamily: FONT.semibold,
          fontWeight: "600",
          textTransform: "uppercase",
          marginTop: 6,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
