/**
 * DashboardStatGrid — the six headline numbers.
 *
 * What changed, and why each one mattered:
 *
 *  - ABSENCE READS AS ABSENCE. The pickers now return `number | null` and a
 *    null renders as an em-dash, not a confident `0`. A workspace with no
 *    reported figure and a workspace measured at zero are different facts.
 *  - THE GRID CARRIES HEALTH, NOT JUST INVENTORY. "Sent" and "Active
 *    sequences" are counts of things that exist; click rate and bounce rate are
 *    the two numbers an operator checks when something feels wrong, and there
 *    was no bounce metric anywhere on the phone. Their denominators were
 *    already in the payload being fetched.
 *  - EVERY NUMBER IS AN ENTRY POINT. Five of six tiles were inert Views. A
 *    headline figure with nowhere to go is a dead end on the app's most-visited
 *    screen.
 *  - BIG NUMBERS STAY LEGIBLE, AND SPOKEN IN FULL. Values are compacted
 *    ("2.4M") so they fit a phone tile, and every tile carries the exact figure
 *    for VoiceOver — a compact display without an exact spoken value loses the
 *    real number for the people who most need it. Wide tablets use three
 *    columns; large Dynamic Type can return that same screen to two so each
 *    tile keeps at least phone-equivalent reading room.
 *
 * NativeWind v4: every Pressable here uses a STATIC style object. A
 * function-style `style={({pressed}) => …}` silently drops layout.
 */
import {
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { router } from "expo-router";

import { Card } from "@/components/Card";
import { StatCard } from "@/components/StatCard";
import {
  Skeleton,
  SkeletonGroup,
  SkeletonStatRow,
} from "@/components/Skeleton";
import { type DashboardRange, type DashboardStats } from "@/hooks/useDashboard";
import {
  MOBILE_TILE_KEYS,
  tilePickerLabel,
  type MobileTileKey,
} from "@/lib/dashboardLayout";
import {
  arrangeTiles,
  buildTiles,
  tileSpokenSentence,
} from "@/components/dashboard/statTiles";
import { unverifiableRatesNotice } from "@/lib/dashboardIntegrity";
import { compactNum } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { msg } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DashboardStatGridProps {
  stats: DashboardStats | undefined;
  loading: boolean;
  /** True when the online gate is closed and nothing is cached: show em-dashes. */
  blocked: boolean;
  range: DashboardRange;
  /**
   * Long-press handler. The grid does not own the sheet — the screen does, so
   * one modal serves six tiles instead of six modals racing each other.
   */
  onInspect?: ((tile: InspectedTile) => void) | undefined;
  /** Called with the tile KEY when a tile is tapped. Telemetry seam: the grid
   *  knows which tile was pressed, and nothing else on the screen does. */
  onDrilldown?: ((metric: string) => void) | undefined;
  /**
   * Render order, resolved from the per-user layout the desktop saved
   * (`GET /api/v1/dashboard/layout`). Omit to use the built-in default order.
   */
  order?: readonly MobileTileKey[] | undefined;
  /** Tiles the reader has hidden ON THIS DEVICE. */
  hidden?: readonly MobileTileKey[] | undefined;
  /**
   * Opens the metric picker. Absent — for instance while the preference is
   * still hydrating — hides the control rather than offering a dead one.
   */
  onConfigure?: (() => void) | undefined;
}

/** What the long-press hands the screen. */
export interface InspectedTile {
  label: string;
  value: string;
  metric?: string | undefined;
}

/**
 * A width breakpoint alone is not enough here. At the largest scale used by
 * the tile's dense text roles, 768pt has roughly the same usable reading room
 * as a phone; keeping three columns there would trade empty tablet whitespace
 * for cramped labels. The effective-width floor preserves the phone layout as
 * the known-good minimum while still giving an ordinary portrait iPad a true
 * three-up grid.
 */
const TABLET_WINDOW_MIN_WIDTH = 700;
const THREE_COLUMN_EFFECTIVE_WIDTH = 560;
const DENSE_TILE_FONT_SCALE_CAP = 1.4;

const GRID_STYLE = {
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 10,
} as const satisfies ViewStyle;

/** The phone style is intentionally byte-for-byte the existing contract. */
const PHONE_TILE_STYLE = {
  flexBasis: "48%",
  flexGrow: 1,
} as const satisfies ViewStyle;

const TABLET_TILE_STYLE = {
  flexBasis: "32%",
  flexGrow: 1,
} as const satisfies ViewStyle;

/** Incomplete tablet rows keep the same column width instead of ballooning. */
const TABLET_TRAILING_TILE_STYLE = {
  flexBasis: "32%",
  flexGrow: 0,
} as const satisfies ViewStyle;

const TABLET_STAT_CARD_STYLE = { flexGrow: 1 } as const satisfies ViewStyle;

export function dashboardStatGridColumns(
  windowWidth: unknown,
  fontScale: unknown,
): 2 | 3 {
  const width =
    typeof windowWidth === "number" && Number.isFinite(windowWidth)
      ? windowWidth
      : 0;
  if (width < TABLET_WINDOW_MIN_WIDTH) return 2;

  const requestedScale =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? fontScale
      : 1;
  const effectiveScale = Math.min(requestedScale, DENSE_TILE_FONT_SCALE_CAP);
  return width / effectiveScale >= THREE_COLUMN_EFFECTIVE_WIDTH ? 3 : 2;
}

function tileStyleAt(columns: 2 | 3, total: number, index: number): ViewStyle {
  if (columns === 2) return PHONE_TILE_STYLE;
  const trailingCount = total % columns;
  const inIncompleteRow = trailingCount > 0 && index >= total - trailingCount;
  return inIncompleteRow ? TABLET_TRAILING_TILE_STYLE : TABLET_TILE_STYLE;
}

/** Tablet-only loading shape; phones retain SkeletonStatRow unchanged. */
function TabletStatSkeletonRow() {
  return (
    <SkeletonGroup label={msg("dashboard.tile.loading")}>
      <View testID="dashboard-stat-skeleton-grid" style={GRID_STYLE}>
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={index} style={[TABLET_TILE_STYLE, { gap: 10 }]}>
            <Skeleton width="60%" height={11} />
            <Skeleton width="45%" height={24} radius={8} />
          </Card>
        ))}
      </View>
    </SkeletonGroup>
  );
}

export function DashboardStatGrid({
  stats,
  loading,
  blocked,
  range,
  onInspect,
  onDrilldown,
  order,
  hidden,
  onConfigure,
}: DashboardStatGridProps) {
  const { t } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const columns = dashboardStatGridColumns(width, fontScale);
  if (loading) {
    return columns === 3 ? (
      <TabletStatSkeletonRow />
    ) : (
      <SkeletonStatRow tiles={6} />
    );
  }

  const tiles = arrangeTiles(
    buildTiles(blocked ? undefined : stats, range),
    order,
    hidden,
  );
  const hiddenCount = MOBILE_TILE_KEYS.length - tiles.length;
  // An em-dash for "we were sent an impossible ratio" is indistinguishable
  // from an em-dash for "nothing was reported" — and those are the two most
  // different things a tile can be saying. Only the first gets a sentence.
  const unverifiable = blocked ? null : unverifiableRatesNotice(stats);
  // One sentence for the whole grid rather than one per tile: printing the
  // reason inside a narrow grid cell stretches its row-mate and makes the grid
  // ragged. The tiles carry the badge; this carries the why.
  const anomalyNotices = tiles
    .filter((tile) => tile.anomaly && tile.anomalyReason)
    .map((tile) => `${tile.label}: ${tile.anomalyReason ?? ""}`);

  return (
    <View>
      <View style={GRID_STYLE}>
        {tiles.map((tile, index) => (
          <Pressable
            key={tile.key}
            style={tileStyleAt(columns, tiles.length, index)}
            onPress={() => {
              haptics.tap();
              onDrilldown?.(tile.key);
              router.push(tile.route);
            }}
            {...(onInspect
              ? {
                  onLongPress: () => {
                    haptics.impact();
                    onInspect({
                      label: tile.label,
                      value: tile.value,
                      metric: tile.briefMetric,
                    });
                  },
                }
              : {})}
            accessibilityRole="button"
            // The anomaly is announced FIRST after the value, before the
            // delta and the destination: a bounce spike is the reason to stop
            // on this tile, and burying it at the end of the sentence means a
            // VoiceOver user hears it last or swipes past it.
            accessibilityLabel={tileSpokenSentence(tile)}
            // A long press is invisible to VoiceOver unless it is published as
            // an action: without this the Explain/Share menu is unreachable
            // for anyone driving the screen with the rotor.
            {...(onInspect
              ? {
                  accessibilityActions: [
                    { name: "magicTap", label: msg("dashboard.tile.options") },
                  ],
                  onAccessibilityAction: () =>
                    onInspect({
                      label: tile.label,
                      value: tile.value,
                      metric: tile.briefMetric,
                    }),
                }
              : {})}
          >
            <StatCard
              label={tile.label}
              value={tile.value}
              exact={tile.spoken}
              numeric={tile.numeric}
              formatNumeric={(n) => compactNum(Math.round(n))}
              delta={tile.delta}
              sparkline={tile.sparkline}
              anomaly={tile.anomaly}
              anomalyReason={tile.anomalyReason}
              // Tablet rows share a height even when the first tile carries a
              // sparkline. It is flex growth, never a fixed height, so labels
              // and deltas still expand under Dynamic Type.
              {...(columns === 3 ? { style: TABLET_STAT_CARD_STYLE } : {})}
              // The Pressable above owns the announcement, so the tile stays out
              // of the a11y tree and VoiceOver reads one element, not two.
              groupedByParent
            />
          </Pressable>
        ))}
      </View>
      {unverifiable ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            marginTop: 10,
          }}
        >
          {unverifiable}
        </Text>
      ) : null}
      {/* Placed AFTER the tiles and before the notices, and it names the
          hidden count: a reader who hid two metrics months ago must be able to
          tell a configured grid from a workspace that stopped reporting. */}
      {onConfigure ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            onConfigure();
          }}
          accessibilityRole="button"
          accessibilityLabel={
            hiddenCount > 0
              ? msg("dashboard.tile.configure.hidden", { count: hiddenCount })
              : msg("dashboard.tile.configure")
          }
          hitSlop={8}
          style={{
            alignSelf: "flex-end",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 4,
            marginTop: 4,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.semibold,
              ...typeStyle("label"),
            }}
          >
            {tilePickerLabel(hiddenCount)}
          </Text>
        </Pressable>
      ) : null}
      {anomalyNotices.map((notice) => (
        <Text
          key={notice}
          // `alert` rather than plain text: this appears mid-session on a
          // screen the reader has already scanned past.
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            marginTop: 10,
          }}
        >
          {notice}
        </Text>
      ))}
    </View>
  );
}
