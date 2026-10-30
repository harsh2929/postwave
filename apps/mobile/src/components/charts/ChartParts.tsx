/**
 * ChartParts — the chrome every chart shares: title, legend, scrub readout,
 * and the accessible data table.
 *
 * Split out of `TimeSeriesChart` so the chart file stays inside the repo's
 * source-size budget (`scripts/check-source-budgets.mjs`) and so a second chart
 * type gets identical chrome for free rather than a near-copy that drifts.
 */
import { Pressable, Text, View } from "react-native";

import type { ChartPalette } from "@/lib/chartPalette";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ChartSeriesLike {
  id: string;
  label: string;
  values: readonly (number | null | undefined)[];
}

export function ChartTitle({ title }: { title: string }) {
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

/**
 * The value readout revealed while scrubbing. Rendered at a FIXED height even
 * when empty: letting it appear and disappear would reflow the plot under the
 * user's finger mid-drag.
 */
export function ScrubReadout({
  index,
  labels,
  series,
  palette,
}: {
  index: number | null;
  labels: readonly string[];
  series: readonly ChartSeriesLike[];
  palette: ChartPalette;
}) {
  const { t } = useTheme();
  const label = index === null ? null : labels[index];

  return (
    <View style={{ minHeight: 18 }}>
      {label ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Text
            // Dense: the readout sits in a fixed-height strip that must not
            // reflow under a finger mid-drag.
            {...typeCap("numeric")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("numeric"),
            }}
          >
            {label}
          </Text>
          {series.map((s, i) => (
            <View
              key={s.id}
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: palette.seriesColor(i),
                }}
              />
              {/* Values wear TEXT ink, never the series colour — the swatch
                  beside them already carries identity. */}
              <Text
                {...typeCap("numeric")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.medium,
                  ...typeStyle("numeric"),
                }}
              >
                {num(s.values[index as number])}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The chart is scrubable, and nothing said so.
 *
 * A crosshair that only exists after you happen to drag a finger across an
 * unlabelled rectangle is a feature only its author knows about — every
 * on-screen number was already direct-labelled, so there was no cue that the
 * plot held any more. One recessive line, shown only while the reader has not
 * yet scrubbed, and gone the moment they have.
 *
 * Hidden from assistive tech on purpose: dragging is not how a VoiceOver user
 * reaches a point (the chart publishes increment/decrement for that, and says
 * so in its own hint), so this sentence would be an instruction they cannot
 * follow.
 */
export function ScrubHint({ visible }: { visible: boolean }) {
  const { t } = useTheme();
  if (!visible) return null;
  return (
    <Text
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("caption"),
      }}
    >
      Drag across the chart for exact values.
    </Text>
  );
}

/**
 * Legend. Present whenever there are two or more series, because with one
 * colour per series identity would otherwise be conveyed by colour alone —
 * unusable for a colour-blind reader and invisible to a screen reader. A single
 * series gets no legend: the title already names it.
 */
export function ChartLegend({
  series,
  palette,
}: {
  series: readonly ChartSeriesLike[];
  palette: ChartPalette;
}) {
  const { t } = useTheme();
  if (series.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {series.map((s, i) => (
        <View
          key={s.id}
          accessible
          accessibilityLabel={`${s.label} series`}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <View
            style={{
              width: 10,
              height: 3,
              borderRadius: 2,
              backgroundColor: palette.seriesColor(i),
            }}
          />
          <Text
            // The legend wraps, so it is prose: `label` may grow the whole
            // 2.1x without pushing anything off screen.
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("label"),
            }}
          >
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The escape hatch that keeps chart data from being locked inside an image:
 * a plain, readable table of every point. Collapsed by default so it costs
 * sighted users nothing.
 */
export function ChartDataTable({
  labels,
  series,
  valueNoun,
  open,
  onToggle,
}: {
  labels: readonly string[];
  series: readonly ChartSeriesLike[];
  valueNoun: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide data table" : "View data as table"}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        style={{ minHeight: 32, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            fontFamily: FONT.medium,
            ...typeStyle("control"),
          }}
        >
          {open ? "Hide table" : "View as table"}
        </Text>
      </Pressable>

      {open ? (
        <View
          style={{
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {labels.map((label, index) => (
            <View
              key={`${label}-${index}`}
              accessible
              accessibilityLabel={`${label}: ${series
                .map((s) => `${s.label} ${num(s.values[index])} ${valueNoun}`)
                .join(", ")}`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: index % 2 ? t.bgSubtle : t.surface,
              }}
            >
              <Text
                {...typeCap("numeric")}
                style={{
                  color: t.fgMuted,
                  fontFamily: FONT.regular,
                  ...typeStyle("numeric"),
                }}
              >
                {label}
              </Text>
              <Text
                {...typeCap("numeric")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.medium,
                  ...typeStyle("numeric"),
                }}
              >
                {series.map((s) => num(s.values[index])).join(" · ")}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}
