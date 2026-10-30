/**
 * StatCard — single tile in a stat grid.
 *
 * Layout is fixed-height to prevent row jiggle when delta is absent.
 * The "ghost em-dash" issue from earlier was caused by always-rendering
 * the delta row with "—" as a fallback; now an empty placeholder View
 * reserves the same vertical space without painting visible text.
 *
 * Two later additions, both about the tile being *readable* rather than just
 * visible:
 *
 *  - ACCESSIBILITY GROUPING. Without `accessible`, VoiceOver reads a tile as
 *    three unrelated stops — "OPENS", then "12.4K", then "▲ +12 30d", where the
 *    arrow is announced literally as "black up-pointing triangle". Grouped, it
 *    is one stop that says "Opens, 12,432, up 12 over 30 days". The `exact`
 *    prop exists for the common case where the visible number is compacted:
 *    "1.2K" is right for the tile and wrong for the spoken value.
 *  - COUNT-UP. When a number changes, animating it to its new value tells the
 *    user *that* it changed — a silently replaced figure is easy to miss on a
 *    dashboard that refreshes underneath you. It is opt-in, skipped entirely
 *    under Reduce Motion, and never animates the first paint (counting up from
 *    zero on load is decoration, not information).
 */
import { useEffect, useRef, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { Skeleton } from "@/components/Skeleton";
import { Sparkline } from "@/components/charts/Sparkline";
import { STAT_CARD_SKELETON_TOKEN } from "@/lib/contrast";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { durationFor, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface StatCardProps {
  label: string;
  value: string;
  /** Optional delta indicator, like "+12 30d". */
  delta?: { dir: "up" | "down" | "flat"; text: string } | null;
  /** When true the value renders as a placeholder bar (loading state). */
  loading?: boolean;
  style?: ViewStyle;
  /**
   * Full-precision value for assistive tech, used when `value` is compacted.
   * Falls back to `value`.
   */
  exact?: string | undefined;
  /**
   * Numeric value behind `value`. When supplied AND the number changes after
   * first paint, the tile counts to the new figure. Purely presentational —
   * `value` remains the source of the rendered string once settled.
   */
  numeric?: number | undefined;
  /** Formatter used during the count-up. Defaults to a grouped integer. */
  formatNumeric?: ((n: number) => string) | undefined;
  /**
   * Set when a drill-down ancestor already owns the accessibility grouping.
   * The tile then hides itself from the a11y tree so VoiceOver announces ONE
   * element ("Subscribers, 12,345, up 120. Open subscribers.") instead of a
   * button and a nested group that repeat each other.
   */
  groupedByParent?: boolean | undefined;
  /**
   * Daily series drawn under the delta row. Decoration for the sighted reader
   * only — the chart is hidden from assistive tech because the tile's own
   * label already carries the value and its movement, and a second
   * "chart, 30 points, latest 412" stop says nothing new.
   */
  sparkline?: number[] | undefined;
  /**
   * The server flagged this metric as anomalous for the window. Rendered as a
   * warning-toned badge, NOT as a colour change on the value: state must
   * never be carried by colour alone.
   */
  anomaly?: boolean | undefined;
  /**
   * Plain-language reason, spoken after the value. Deliberately NOT printed
   * inside the tile: a two-line sentence in a 48%-width grid cell stretches
   * its row-mate to match and turns a scannable grid into a ragged one. The
   * sighted reader gets the badge here and the sentence once, below the grid.
   */
  anomalyReason?: string | undefined;
}

/**
 * Minimum height of the delta row. It used to be a hard `height`, which clipped
 * the 12px delta text the moment the OS text scale went up — RN scales text
 * with Dynamic Type by default, and `adjustsFontSizeToFit` only protects the
 * value. It is a floor now, so the row grows instead of cropping.
 */
const DELTA_MIN_HEIGHT = 16;
/** Frame cadence for the count-up. 16ms would be smoother and pointlessly
 *  expensive for a number that is legible at ~20fps. */
const TICK_MS = 45;
/**
 * Trend-line box. Width is not the tile's — the tile is a flex cell in a
 * two-column grid whose measured width is unknown at render, and
 * react-native-svg needs a number, not a percentage.
 *
 * Sized for the NARROWEST supported device, not the common one: at 320pt a
 * 48%-basis tile is ~133pt wide and 32pt of that is padding, leaving ~101pt of
 * content box. 96 clears it. A wider chart would look better on a 390pt phone
 * and clip on an SE, and a clipped chart is a wrong chart.
 */
const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 24;

export function StatCard({
  label,
  value,
  delta,
  loading,
  style,
  exact,
  numeric,
  formatNumeric,
  groupedByParent = false,
  sparkline,
  anomaly = false,
  anomalyReason,
}: StatCardProps) {
  const { t } = useTheme();
  const displayed = useCountUp(numeric, formatNumeric);

  const deltaColor =
    delta?.dir === "up"
      ? t.success
      : delta?.dir === "down"
        ? t.danger
        : t.fgSubtle;

  // Spoken direction — the arrow glyph is decoration and must not be read out.
  const spokenDelta = delta
    ? `${delta.dir === "up" ? "up" : delta.dir === "down" ? "down" : "unchanged"} ${delta.text}`
    : "";
  // The badge glyph is decoration; the anomaly is spoken as a sentence, and
  // its reason travels with it so VoiceOver users are not left with a word.
  const spokenAnomaly = anomaly
    ? `, unusual${anomalyReason ? `. ${anomalyReason}` : ""}`
    : "";
  const spoken = loading
    ? `${label}, loading`
    : `${label}, ${exact ?? value}${spokenDelta ? `, ${spokenDelta}` : ""}${spokenAnomaly}`;

  return (
    // The shared card primitive, not a private copy of its chrome: a stat tile
    // sits directly beside real cards on the dashboard, so the two must share
    // one radius and one border by construction rather than by coincidence.
    <Card
      {...(groupedByParent
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: "no-hide-descendants" as const,
          }
        : { accessible: true, accessibilityLabel: spoken })}
      style={[
        {
          minHeight: 104,
          // gap between label, value, delta = 8 / 4
          justifyContent: "flex-start",
        },
        style ?? null,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("badgeSmall"),
            letterSpacing: 0.6,
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
        {/* The word "UNUSUAL" carries the state, not the warning tint — the
            tile still reads correctly in greyscale and to a colour-blind eye.
            Hidden from assistive tech because `spoken` above already says it,
            in a full sentence with the reason attached. */}
        {anomaly ? (
          <Pill label="Unusual" tone="warning" style={{ marginTop: -2 }} />
        ) : null}
      </View>
      {loading ? (
        // Contrast, measured rather than eyeballed. The original placeholder
        // painted `surfaceElevated` on a `surface` card; Skeleton's default
        // `borderSubtle` is NOT an improvement on that, because in the dark
        // palette the two tokens are the same value (#242424 both), which is
        // 1.12:1 against surface #1A1A1A — invisible, so a loading tile reads
        // as an EMPTY one. `fgMuted` measures 4.7:1 (dark) and 3.2:1 (light)
        // at the pulse's parked midpoint, which is also the value Reduce
        // Motion freezes it at, so the static case clears 3:1 in both themes.
        // Skeleton spreads `style` after its own base, so this wins. The
        // pairing is asserted against both palettes in lib/contrast.test.ts.
        <Skeleton
          width={84}
          height={28}
          radius={6}
          style={{
            marginTop: 10,
            backgroundColor: t[STAT_CARD_SKELETON_TOKEN],
          }}
        />
      ) : (
        <Text
          // `figure` carries the tightest ceiling in the scale (1.25x): this
          // tile is one cell of a fixed two-column grid, so an unbounded 30pt
          // number breaks the PAGE, not just the tile. No `lineHeight` — an
          // explicit leading fights `adjustsFontSizeToFit`'s shrink pass.
          {...typeCap("figure")}
          style={{
            color: t.fg,
            fontSize: fontSizeFor("figure"),
            fontFamily: FONT.display,
            marginTop: 6,
            letterSpacing: -0.6,
            // Tabular figures keep the number from shifting width as it counts.
            fontVariant: ["tabular-nums"],
          }}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {displayed ?? value}
        </Text>
      )}
      {/* Delta row — always rendered (with consistent height) so cards
          don't jump when one has a delta and another doesn't. When
          there's no delta, this is an empty space-holder. */}
      <View style={{ minHeight: DELTA_MIN_HEIGHT, marginTop: 6 }}>
        {delta ? (
          <Text
            {...typeCap("numeric")}
            style={{
              color: deltaColor,
              ...typeStyle("numeric"),
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
            }}
          >
            {/* Direction is carried by the glyph as well as the colour, so it
                survives colour-blindness and greyscale. */}
            {delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "·"}{" "}
            {delta.text}
          </Text>
        ) : null}
      </View>
      {/* Trend line. Hidden from the a11y tree: the tile is announced as one
          element whose label already carries the value and its movement, so a
          second "chart, 30 points" stop would repeat without adding a fact. */}
      {sparkline && !loading ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ marginTop: 4 }}
        >
          <Sparkline
            values={sparkline}
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
            color={anomaly ? t.warning : t.accent}
          />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Animates from the previous number to the next one, returning the string to
 * render — or `null` when there is nothing to animate, so the caller falls back
 * to its own formatted `value`.
 *
 * Returns null on first paint by design: counting up from zero when a screen
 * loads is decoration. The animation exists to signal a CHANGE.
 */
function useCountUp(
  numeric: number | undefined,
  formatNumeric: ((n: number) => string) | undefined,
): string | null {
  const { reduceMotion } = useMotion();
  const previous = useRef<number | undefined>(undefined);
  const [frame, setFrame] = useState<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = numeric;

    if (
      reduceMotion ||
      typeof numeric !== "number" ||
      typeof from !== "number" ||
      from === numeric ||
      !Number.isFinite(numeric) ||
      !Number.isFinite(from)
    ) {
      setFrame(null);
      return;
    }

    const totalMs = durationFor("fill", reduceMotion);
    const steps = Math.max(1, Math.round(totalMs / TICK_MS));
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (step >= steps) {
        clearInterval(timer);
        setFrame(null);
        return;
      }
      // Ease-out: most of the distance early, so the figure settles rather
      // than arriving at constant speed.
      const progress = 1 - (1 - step / steps) ** 3;
      setFrame(from + (numeric - from) * progress);
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [numeric, reduceMotion]);

  if (frame === null) return null;
  // `num` rather than a bare `toLocaleString()`: format.ts owns a cached
  // Intl.NumberFormat AND the app-wide locale override (`setFormatLocale`),
  // so a raw call here would count up in the device locale while the settled
  // value beside it renders in the app's — a digit-grouping flicker at the
  // end of every animation.
  const format = formatNumeric ?? ((n: number) => num(Math.round(n)));
  return format(frame);
}
