/**
 * TimeSeriesChart — line / area chart for change-over-time.
 *
 * The mobile app had exactly one visualization: `lib/sparkline.ts`, an
 * unlabeled 40pt trend squiggle. Everything the desktop Analytics surface plots
 * — opens over time, revenue, deliverability trend, list growth — had no phone
 * equivalent at all. This is the primitive those screens are built on.
 *
 * Decisions worth stating, because each one is a way charts commonly mislead:
 *
 *  - ONE AXIS, ALWAYS. There is deliberately no second y-scale. Two measures of
 *    different magnitude (sends and revenue) get two charts, never two axes on
 *    one — a dual axis lets the author choose where the lines cross, so the
 *    reader is looking at a design decision rather than at the data.
 *  - COUNT AXES START AT ZERO (`zeroBased`, default on). Truncating the axis is
 *    the fastest way to make a 2% change look like a collapse.
 *  - GAPS STAY GAPS. A null day breaks the line (`pathSegments`) instead of
 *    drawing a straight run through missing data.
 *  - TOUCH SCRUBBING IS THE HOVER LAYER. A chart with no readout is decorative;
 *    on a phone the equivalent of a desktop crosshair is dragging along the
 *    plot to reveal a crosshair and an exact value.
 *  - THE NUMBERS ARE REACHABLE WITHOUT SIGHT. A spoken summary plus a
 *    "View as table" toggle mean the data is not locked inside an image, and
 *    a legend means identity is never colour-alone. The plot is also
 *    `adjustable`, so swipe-up / swipe-down walk the series point by point
 *    with the exact figure announced — a drag is a gesture assistive tech
 *    never performs, so without this the crosshair existed for sighted users
 *    only. And because a scrubable rectangle with no cue is a feature only its
 *    author knows about, `ScrubHint` says so until the reader has scrubbed.
 *
 * Chrome (title, legend, readout, hint, table) lives in `ChartParts`, the SVG
 * marks in `ChartMarks`; the arithmetic lives in `lib/chartScale`; the colours
 * come from `lib/chartPalette`, which was validated for colour-vision
 * separation. Never pass a raw hex here.
 */
import { useMemo, useState } from "react";
import { LayoutChangeEvent, Text, View } from "react-native";
import Svg, { G, Line, Text as SvgText } from "react-native-svg";

import { chartPalette } from "@/lib/chartPalette";
import {
  extentOf,
  indexAtX,
  niceTicks,
  scaleX,
  scaleY,
  tickLabel,
} from "@/lib/chartScale";
import {
  chartPointSummary,
  chartSummary,
  stepScrubIndex,
} from "@/lib/chartSummary";
import { FONT } from "@/lib/fonts";
import { compactNum } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { Crosshair, SeriesMarks } from "./ChartMarks";
import {
  ChartDataTable,
  ChartLegend,
  ChartTitle,
  ScrubHint,
  ScrubReadout,
  type ChartSeriesLike,
} from "./ChartParts";

export type ChartSeries = ChartSeriesLike;

export interface TimeSeriesChartProps {
  series: readonly ChartSeries[];
  /** One label per x position; used by the scrub readout and the table. */
  labels: readonly string[];
  /** Names the chart — and, for a single series, names that series too. */
  title?: string;
  height?: number;
  /**
   * Fill under the line. Honoured only for a single series: overlapping
   * translucent fills read as a third, fictional colour.
   */
  area?: boolean;
  /** Turn off only for genuinely signed measures (a week-over-week delta). */
  zeroBased?: boolean;
  /** Used in the table's spoken rows, e.g. "opens". */
  valueNoun?: string;
}

const PAD_LEFT = 38;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;

export function TimeSeriesChart({
  series,
  labels,
  title,
  height = 180,
  area = false,
  zeroBased = true,
  valueNoun = "value",
}: TimeSeriesChartProps) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);
  const [width, setWidth] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  // Sticky: the hint retires once the reader has discovered the gesture, and
  // does not flicker back on every finger-up.
  const [scrubbed, setScrubbed] = useState(false);
  const [showTable, setShowTable] = useState(false);

  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = Math.max(0, height - PAD_TOP - PAD_BOTTOM);

  const extent = useMemo(
    () => extentOf(series.flatMap((s) => [...s.values]), { zeroBased }),
    [series, zeroBased],
  );
  const ticks = useMemo(() => niceTicks(extent, 3), [extent]);
  const spoken = useMemo(
    () => chartSummary(title, series, labels.length),
    [title, series, labels.length],
  );

  const hasAnyPoint = series.some((s) =>
    s.values.some((v) => typeof v === "number" && Number.isFinite(v)),
  );

  const scrub = (locationX: number) => {
    if (!labels.length) return;
    const next = indexAtX(locationX - PAD_LEFT, labels.length, plotWidth);
    setScrubbed(true);
    setScrubIndex((current) => {
      // One tick per data point crossed, not per pixel of finger travel.
      if (current !== next) haptics.tap();
      return next;
    });
  };

  // Assistive-tech traversal. The plot is one node, so a drag — the gesture
  // that reveals individual points — is unavailable to a VoiceOver user; as
  // `adjustable`, swipe-up / swipe-down step the same cursor and the announced
  // value comes from `accessibilityValue` below.
  const stepBy = (direction: "increment" | "decrement") => {
    setScrubIndex((current) => {
      const next = stepScrubIndex(current, direction, labels.length);
      if (next !== current) haptics.tap();
      return next;
    });
  };
  const pointSpoken = chartPointSummary(scrubIndex, labels, series);

  return (
    <View style={{ gap: 8 }}>
      {title ? <ChartTitle title={title} /> : null}

      <ScrubReadout
        index={scrubIndex}
        labels={labels}
        series={series}
        palette={palette}
      />

      <View
        onLayout={(event: LayoutChangeEvent) =>
          setWidth(event.nativeEvent.layout.width)
        }
        accessible
        // `adjustable` rather than `image`: it is what publishes the
        // increment/decrement gestures that let a listener walk the series
        // point by point instead of receiving one summary sentence.
        accessibilityRole={hasAnyPoint ? "adjustable" : "image"}
        accessibilityLabel={spoken}
        {...(hasAnyPoint
          ? {
              accessibilityValue: { text: pointSpoken ?? "No point selected" },
              accessibilityHint:
                "Swipe up or down to move through the points; drag across the chart to scrub",
              accessibilityActions: [
                { name: "increment", label: "Next point" },
                { name: "decrement", label: "Previous point" },
              ],
              onAccessibilityAction: (event: {
                nativeEvent: { actionName: string };
              }) => {
                const action = event.nativeEvent.actionName;
                if (action === "increment" || action === "decrement") {
                  stepBy(action);
                }
              },
            }
          : {})}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => scrub(e.nativeEvent.locationX)}
        onResponderMove={(e) => scrub(e.nativeEvent.locationX)}
        onResponderRelease={() => setScrubIndex(null)}
        onResponderTerminate={() => setScrubIndex(null)}
        style={{ height }}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <G x={PAD_LEFT} y={PAD_TOP}>
              {/* Recessive gridlines: present enough to read a value against,
                  never competing with the data. */}
              {ticks.map((tick) => (
                <Line
                  key={`grid-${tick}`}
                  x1={0}
                  y1={scaleY(tick, extent, plotHeight)}
                  x2={plotWidth}
                  y2={scaleY(tick, extent, plotHeight)}
                  stroke={t.borderSubtle}
                  strokeWidth={1}
                />
              ))}

              {series.map((s, i) => (
                <SeriesMarks
                  key={s.id}
                  series={s}
                  color={palette.seriesColor(i)}
                  extent={extent}
                  plotWidth={plotWidth}
                  plotHeight={plotHeight}
                  area={area && series.length === 1}
                />
              ))}

              {scrubIndex !== null && labels.length > 0 ? (
                <Crosshair
                  x={scaleX(scrubIndex, labels.length, plotWidth)}
                  plotHeight={plotHeight}
                  stroke={t.fgSubtle}
                  ring={t.surface}
                  markers={series
                    .map((s, i) => ({
                      value: s.values[scrubIndex],
                      color: palette.seriesColor(i),
                      id: s.id,
                    }))
                    .filter(
                      (m): m is { value: number; color: string; id: string } =>
                        typeof m.value === "number" && Number.isFinite(m.value),
                    )
                    .map((m) => ({
                      id: m.id,
                      color: m.color,
                      y: scaleY(m.value, extent, plotHeight),
                    }))}
                />
              ) : null}
            </G>

            {ticks.map((tick) => (
              <SvgText
                key={`tick-${tick}`}
                x={PAD_LEFT - 8}
                y={PAD_TOP + scaleY(tick, extent, plotHeight) + 4}
                fill={t.fgSubtle}
                fontSize={10}
                textAnchor="end"
              >
                {tickLabel(tick, ticks, compactNum)}
              </SvgText>
            ))}
          </Svg>
        ) : null}

        {!hasAnyPoint && width > 0 ? (
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
          >
            <Text
              // Absolutely positioned inside a FIXED plot height, so this is
              // pinned geometry: `control`'s 1.4x keeps the sentence inside
              // the frame instead of spilling over the axis labels.
              {...typeCap("control")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("control"),
              }}
            >
              No data for this range yet.
            </Text>
          </View>
        ) : null}
      </View>

      {/* First and last x labels only — one label per point is unreadable at
          phone width, and scrubbing covers everything in between. */}
      {labels.length > 1 ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingLeft: PAD_LEFT,
            paddingRight: PAD_RIGHT,
          }}
        >
          <AxisLabel text={labels[0] ?? ""} />
          <AxisLabel text={labels[labels.length - 1] ?? ""} />
        </View>
      ) : null}

      <ScrubHint visible={hasAnyPoint && labels.length > 1 && !scrubbed} />

      <ChartLegend series={series} palette={palette} />

      {hasAnyPoint ? (
        <ChartDataTable
          labels={labels}
          series={series}
          valueNoun={valueNoun}
          open={showTable}
          onToggle={() => setShowTable((v) => !v)}
        />
      ) : null}
    </View>
  );
}

function AxisLabel({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      // Axis labels are chrome pinned to the plot's padding, not prose.
      {...typeCap("badgeSmall")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("badgeSmall"),
      }}
    >
      {text}
    </Text>
  );
}
