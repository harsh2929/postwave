/**
 * Skeleton — content-shaped loading placeholders.
 *
 * Before this component every mobile screen loaded the same way: a centered
 * `<ActivityIndicator/>` on an otherwise blank page. That is the cheapest
 * loading state to write and the worst one to look at, for two reasons:
 *
 *  1. It communicates nothing about what is coming, so the layout jumps when
 *     data lands — the page reflows from "one spinner" to "nine rows".
 *  2. It reads as *slower* than it is. A skeleton that already occupies the
 *     final shape makes the same wait feel shorter, because the eye has
 *     something to parse and the arrival is a fill rather than a jump.
 *
 * Usage — mirror the real content's shape, not a generic block:
 *
 *   {q.isLoading ? <SkeletonList rows={6} /> : rows.map(...)}
 *   {q.isLoading ? <SkeletonStatRow /> : <StatCard .../>}
 *
 * Accessibility: the whole group is announced once as "Loading" with
 * `accessibilityRole="progressbar"` and children hidden from the a11y tree,
 * so VoiceOver says one useful thing instead of reading nine empty boxes.
 *
 * Reduce Motion: the shimmer is a *decorative* loop. When the OS setting is
 * on we render the same shapes at a fixed mid-opacity with no animation.
 */
import { useEffect } from "react";
import { View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { SKELETON_FILL_TOKEN } from "@/lib/contrast";
import { useMotion } from "@/lib/motion";
import { Card } from "@/components/Card";
import { useTheme } from "@/lib/theme";

/** Opacity endpoints of the breathing loop. Subtle on purpose — a skeleton
 *  that pulses hard competes with the content that is about to replace it. */
const DIM = 0.45;
const BRIGHT = 0.9;
/** One full breath. Slower than a typical shimmer so it reads as calm. */
const PULSE_MS = 1100;

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle | undefined;
}

/**
 * A single placeholder block. Composed by the higher-level shapes below;
 * use it directly only when none of them fit.
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 6,
  style,
}: SkeletonProps) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const pulse = useSharedValue(reduceMotion ? (DIM + BRIGHT) / 2 : DIM);

  useEffect(() => {
    if (reduceMotion) {
      // Park at the midpoint: same visual weight, no motion.
      cancelAnimation(pulse);
      pulse.value = (DIM + BRIGHT) / 2;
      return;
    }
    pulse.value = withRepeat(
      withTiming(BRIGHT, {
        duration: PULSE_MS,
        easing: Easing.inOut(Easing.quad),
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [reduceMotion, pulse]);

  const animated = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      // Individually hidden — the wrapping group carries the announcement.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius,
          // NOT `borderSubtle`: in the dark palette that token is #242424 —
          // byte-identical to `surfaceElevated` — which against `surface`
          // (#1A1A1A) is 1.12:1. A skeleton painted with it is invisible, so a
          // loading screen reads as an EMPTY one. `fgMuted` clears the 3:1
          // non-text floor in both palettes; asserted in lib/contrast.test.ts.
          backgroundColor: t[SKELETON_FILL_TOKEN],
          // The pulse dips opacity, so the floor must hold at the dim end too —
          // hence a muted foreground rather than a border token.
        },
        style,
        animated,
      ]}
    />
  );
}

/**
 * Wraps a set of skeletons so screen readers hear one "Loading" instead of
 * a stream of anonymous boxes. Every composite below already uses it.
 */
export function SkeletonGroup({
  children,
  label = "Loading",
  style,
}: {
  children: React.ReactNode;
  label?: string;
  style?: ViewStyle | undefined;
}) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={style}
    >
      {children}
    </View>
  );
}

/**
 * A card-shaped skeleton matching the `Card` primitive's geometry
 * (16px radius, 16px padding, 1px border) so the swap is seamless.
 */
export function SkeletonCard({
  lines = 3,
  style,
}: {
  lines?: number;
  style?: ViewStyle | undefined;
}) {
  // The shared primitive, not a copy of it: a skeleton that does not have the
  // EXACT geometry of the thing it stands in for produces a layout jump at the
  // moment the data lands, which is the one defect a skeleton exists to
  // prevent. Inlining the chrome meant a change to card radius silently
  // desynchronised every loading state in the app.
  return (
    <Card style={[{ gap: 10 }, style]}>
      <Skeleton width="55%" height={16} />
      {Array.from({ length: Math.max(0, lines - 1) }).map((_, i) => (
        <Skeleton
          key={i}
          // Vary the last line's width so the block reads as text, not a table.
          width={i === lines - 2 ? "40%" : "85%"}
          height={12}
        />
      ))}
    </Card>
  );
}

/**
 * The default list loading state: N card-shaped rows at the same rhythm the
 * real rows will use (8px gap, matching the app's list screens).
 */
export function SkeletonList({
  rows = 5,
  lines = 2,
  label = "Loading",
  style,
}: {
  rows?: number;
  lines?: number;
  label?: string;
  style?: ViewStyle | undefined;
}) {
  return (
    <SkeletonGroup label={label} style={style}>
      <View style={{ gap: 8 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonCard key={i} lines={lines} />
        ))}
      </View>
    </SkeletonGroup>
  );
}

/**
 * The dashboard's stat-tile row: a 2-up grid of short number blocks.
 * Matches StatCard's proportions so the numbers land where the bars were.
 */
export function SkeletonStatRow({
  tiles = 4,
  label = "Loading metrics",
}: {
  tiles?: number;
  label?: string;
}) {
  return (
    <SkeletonGroup label={label}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {Array.from({ length: tiles }).map((_, i) => (
          <Card
            key={i}
            style={{ flexGrow: 1, flexBasis: "45%", gap: 10 }}
          >
            <Skeleton width="60%" height={11} />
            <Skeleton width="45%" height={24} radius={8} />
          </Card>
        ))}
      </View>
    </SkeletonGroup>
  );
}

/** Detail-screen skeleton: a title block plus stacked field rows. */
export function SkeletonDetail({ sections = 3 }: { sections?: number }) {
  return (
    <SkeletonGroup label="Loading details">
      <View style={{ gap: 16 }}>
        <View style={{ gap: 8 }}>
          <Skeleton width="70%" height={22} radius={8} />
          <Skeleton width="40%" height={13} />
        </View>
        {Array.from({ length: sections }).map((_, i) => (
          <SkeletonCard key={i} lines={3} />
        ))}
      </View>
    </SkeletonGroup>
  );
}
