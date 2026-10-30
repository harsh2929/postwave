/**
 * Sparkline — pure-SVG line chart over a short daily series. Same approach the
 * desktop + web use: zero chart dependency, just react-native-svg primitives.
 *
 * The component is intentionally minimal: a single polyline + an optional
 * filled gradient below the line. No axes, no legend — those live above/beside
 * the chart in the parent.
 *
 * GRADIENT IDS ARE PER-INSTANCE. `<Defs><LinearGradient id="…">` registers the
 * gradient in react-native-svg's document-wide brush table, and `fill="url(#…)"`
 * resolves against that same table. A hardcoded id therefore means the LAST
 * mounted Sparkline silently repaints every earlier one — invisible while only
 * one existed on a screen, and wrong the moment the dashboard renders a tile
 * chart beside a subscriber card. The id is minted once per mount from a
 * module counter (NOT React's `useId`, whose «r0» delimiters are not valid in
 * an SVG `url(#…)` reference).
 *
 * Heights / widths come in via props so the parent can size it inside a stat
 * row (small) or a hero card (large).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

import { FONT } from "@/lib/fonts";
import { sparklinePoints } from "@/lib/sparkline";
import { useTheme } from "@/lib/theme";
import { TYPE, typeCap, typeStyle } from "@/lib/typeScale";

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Render the area-fill below the line. */
  filled?: boolean;
  /** Optional label rendered above the chart (e.g. "30-day engagement"). */
  label?: string;
  /** Optional semantic summary for screen readers. */
  accessibilityLabel?: string;
  /** Line/fill colour. Defaults to the theme accent. */
  color?: string;
}

/** Gap between the optional label and the chart. */
const LABEL_MARGIN = 4;
/**
 * Vertical reserve for the optional label, DERIVED from the role rather than
 * left as the literal `18` it used to be. A hardcoded reserve is only correct
 * at one OS text size: at the role's own 1.4x ceiling the label is 21pt and an
 * 18pt reserve clipped it. Same reasoning as `tabBarHeightFor`.
 */
const LABEL_RESERVE =
  Math.ceil(
    TYPE.badgeSmall.lineHeight * TYPE.badgeSmall.maxFontSizeMultiplier,
  ) + LABEL_MARGIN;

let gradientSeq = 0;

/** Stable, collision-free gradient id for the lifetime of one mounted chart. */
function useGradientId(): string {
  const [id] = useState(() => {
    gradientSeq += 1;
    return `pwSparkFill${gradientSeq}`;
  });
  return id;
}

export function Sparkline({
  values,
  width = 160,
  height = 48,
  filled = true,
  label,
  accessibilityLabel,
  color,
}: SparklineProps) {
  const { t } = useTheme();
  const gradientId = useGradientId();
  const stroke = color ?? t.accent;
  if (!values.length) {
    return (
      <View
        style={{ width, height: height + (label ? LABEL_RESERVE : 0) }}
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          accessibilityLabel ?? `${label ?? "Trend"} chart, no data yet`
        }
      >
        {label ? <SparklineLabel label={label} color={t.fgMuted} /> : null}
        <Text
          // The chart box is a FIXED width/height (96x24 inside a stat tile),
          // so this is the tightest kind of pinned geometry.
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("badgeSmall"),
            fontFamily: FONT.regular,
          }}
        >
          No data yet
        </Text>
      </View>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padX = 2;
  const padY = 2;
  const innerH = height - padY * 2;
  const points = sparklinePoints(values, width, height, padX, padY);
  const lineD = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const fillD =
    points.length && firstPoint && lastPoint
      ? `${lineD} L${lastPoint.x.toFixed(2)} ${(padY + innerH).toFixed(2)} L${firstPoint.x.toFixed(2)} ${(padY + innerH).toFixed(2)} Z`
      : "";
  const latest = values[values.length - 1] ?? 0;
  const chartLabel =
    accessibilityLabel ??
    `${label ?? "Trend"} chart, ${values.length} points, latest ${formatSparklineValue(latest)}, range ${formatSparklineValue(min)} to ${formatSparklineValue(max)}`;
  return (
    <View
      style={{ width }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={chartLabel}
    >
      {label ? <SparklineLabel label={label} color={t.fgMuted} /> : null}
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
            <Stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        {filled && fillD ? (
          <Path d={fillD} fill={`url(#${gradientId})`} />
        ) : null}
        <Path
          d={lineD}
          stroke={stroke}
          strokeWidth={1.5}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

function SparklineLabel({ label, color }: { label: string; color: string }) {
  return (
    <Text
      // The caller reserves exactly 18pt for this label when sizing the box
      // (`height + (label ? 18 : 0)`), so it must not grow past the reserve.
      {...typeCap("badgeSmall")}
      style={{
        color,
        ...typeStyle("badgeSmall"),
        fontWeight: "600",
        fontFamily: FONT.semibold,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        marginBottom: LABEL_MARGIN,
      }}
    >
      {label}
    </Text>
  );
}

function formatSparklineValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}
