/**
 * BarChart — magnitude comparison across a small set of named categories
 * (top links clicked, sends by ISP, bounces by class, revenue by campaign).
 *
 * Deliberately HORIZONTAL. On a phone, vertical bars force category names into
 * rotated, truncated x-axis labels; horizontal bars give every label a full
 * line of readable text and let the list scroll naturally. Vertical bars are
 * the right call for time on a wide screen — which is what `TimeSeriesChart`
 * is for.
 *
 * Mark decisions:
 *  - bars are anchored to a common zero baseline and share one scale, so length
 *    is directly comparable;
 *  - the data-end is rounded (4px) and the baseline end is square, which reads
 *    as "grows from here" rather than as a floating pill;
 *  - adjacent bars are separated by a surface gap rather than a border line;
 *  - values are direct-labelled at the end of each bar — with only a handful of
 *    categories there is room, and a label beats making the reader measure
 *    against an axis;
 *  - a single-measure chart uses ONE colour, not a rainbow. Different hues per
 *    bar would imply the categories belong to different series. Colour varies
 *    only when `emphasise` marks a specific row.
 */
import { useState } from "react";
import { LayoutChangeEvent, Pressable, Text, View } from "react-native";

import { chartPalette } from "@/lib/chartPalette";
import { FONT } from "@/lib/fonts";
import { compactNum, num, percent } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface BarDatum {
  id: string;
  label: string;
  value: number;
  /** Optional secondary line under the label (a rate, a domain, a date). */
  hint?: string | undefined;
}

export interface BarChartProps {
  data: readonly BarDatum[];
  title?: string;
  /** Noun for the spoken summary and value labels, e.g. "clicks". */
  valueNoun?: string;
  /** Show each bar's share of the total beside its value. */
  showShare?: boolean;
  /** Row id to paint in the accent colour — e.g. the currently-selected item. */
  emphasise?: string | undefined;
  onPressRow?: ((datum: BarDatum) => void) | undefined;
  /** Rows beyond this fold into an "Other" row rather than scrolling forever. */
  maxRows?: number;
}

export function BarChart({
  data,
  title,
  valueNoun = "value",
  showShare = false,
  emphasise,
  onPressRow,
  maxRows = 8,
}: BarChartProps) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);
  const [trackWidth, setTrackWidth] = useState(0);

  const sorted = [...data].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, maxRows);
  const tail = sorted.slice(maxRows);
  // Fold rather than truncate: a silently dropped tail turns "top 8 of 40" into
  // a chart that claims to show everything.
  const rows: BarDatum[] =
    tail.length > 0
      ? [
          ...head,
          {
            id: "__other__",
            label: `Other (${tail.length})`,
            value: tail.reduce((sum, row) => sum + (row.value || 0), 0),
          },
        ]
      : head;

  const total = sorted.reduce((sum, row) => sum + (row.value || 0), 0);
  // Bars scale against the largest value, so the biggest bar fills the track
  // and the rest are read relative to it.
  const peak = Math.max(...rows.map((row) => row.value || 0), 0);

  if (rows.length === 0) {
    return (
      <View style={{ gap: 8 }}>
        {title ? <ChartTitle title={title} /> : null}
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          Nothing to compare yet.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {title ? <ChartTitle title={title} /> : null}

      <View
        onLayout={(event: LayoutChangeEvent) =>
          setTrackWidth(event.nativeEvent.layout.width)
        }
        style={{ gap: 10 }}
      >
        {rows.map((row) => {
          const isOther = row.id === "__other__";
          const ratio = peak > 0 ? Math.max(0, row.value) / peak : 0;
          const color = isOther
            ? palette.other
            : emphasise === row.id
              ? palette.categorical[0]
              : palette.categorical[1];

          const spoken = `${row.label}: ${num(row.value)} ${valueNoun}${
            showShare && total > 0
              ? `, ${percent(row.value / total, { digits: 0 })} of total`
              : ""
          }`;

          const body = (
            <View style={{ gap: 5 }}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "flex-end",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text
                    {...typeCap("body")}
                    numberOfLines={1}
                    style={{
                      color: t.fg,
                      fontFamily: FONT.medium,
                      ...typeStyle("body"),
                    }}
                  >
                    {row.label}
                  </Text>
                  {row.hint ? (
                    <Text
                      {...typeCap("caption")}
                      numberOfLines={1}
                      style={{
                        color: t.fgSubtle,
                        fontFamily: FONT.regular,
                        ...typeStyle("caption"),
                      }}
                    >
                      {row.hint}
                    </Text>
                  ) : null}
                </View>
                {/* Direct label, in text ink — the bar carries magnitude, the
                    number carries precision. */}
                <Text
                  {...typeCap("numeric")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.semibold,
                    ...typeStyle("numeric"),
                  }}
                >
                  {compactNum(row.value)}
                  {showShare && total > 0 ? (
                    // Nested run: size only. An explicit leading inside a
                    // parent Text mis-centres it, and the ceiling is
                    // inherited from the parent anyway.
                    <Text
                      style={{
                        color: t.fgSubtle,
                        fontFamily: FONT.regular,
                        fontSize: fontSizeFor("badgeSmall"),
                      }}
                    >
                      {"  "}
                      {percent(row.value / total, { digits: 0 })}
                    </Text>
                  ) : null}
                </Text>
              </View>

              {/* Track + bar. The track makes "small but non-zero" legible; a
                  bare 2px sliver on an empty row reads as a rendering glitch. */}
              <View
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: t.bgSubtle,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: Math.max(
                      row.value > 0 ? 3 : 0,
                      ratio * Math.max(0, trackWidth),
                    ),
                    height: "100%",
                    backgroundColor: color,
                    // Square at the baseline, rounded at the data end.
                    borderTopRightRadius: 4,
                    borderBottomRightRadius: 4,
                  }}
                />
              </View>
            </View>
          );

          return onPressRow && !isOther ? (
            <Pressable
              key={row.id}
              onPress={() => {
                haptics.tap();
                onPressRow(row);
              }}
              accessibilityRole="button"
              accessibilityLabel={spoken}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              {body}
            </Pressable>
          ) : (
            <View key={row.id} accessible accessibilityLabel={spoken}>
              {body}
            </View>
          );
        })}
      </View>

      {tail.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          Showing the top {maxRows} of {sorted.length}; the rest are folded into
          Other.
        </Text>
      ) : null}
    </View>
  );
}

function ChartTitle({ title }: { title: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("callout")}
      style={{
        color: t.fg,
        fontFamily: FONT.semibold,
        ...typeStyle("callout"),
      }}
    >
      {title}
    </Text>
  );
}
