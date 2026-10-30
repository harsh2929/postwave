/**
 * ListGrowthSourcesCard — "where are new subscribers coming from?"
 *
 * The one genuinely glanceable number the mobile list detail was missing.
 * Desktop's Lists page carries a whole growth-sources section; a phone needs
 * the mix and nothing else.
 *
 * It renders bars rather than a pie because a phone-width pie with eight
 * slices is unreadable, and because a horizontal bar can carry its exact
 * count as text beside it — the compacted share is never the only value
 * present.
 *
 * ABSENCE IS NOT ZERO is the whole design here. An empty counter map means
 * "not recorded" (the sidecar counter is written best-effort after the
 * membership row, so a list built before it existed has none), and the
 * server's `live_count` fallback answers a different question than the one
 * the card asks. Both get a plain sentence instead of a zeroed chart.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { chartPalette } from "@/lib/chartPalette";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import {
  growthSourceNote,
  type GrowthSourceMix,
} from "@/lib/listGrowthSources";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ListGrowthSourcesCard({
  mix,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  mix: GrowthSourceMix | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t, theme } = useTheme();
  // Colours ONLY from the shared palette; `seriesColor` returns the muted
  // "Other" grey past the last honest slot rather than wrapping, because a
  // wrapped colour would give two different sources the same swatch.
  const palette = chartPalette(theme);

  const note = mix ? growthSourceNote(mix) : "";

  return (
    <Card style={{ marginTop: 12, gap: 10 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        Where they came from
      </Text>

      {isLoading ? (
        <Skeleton height={72} />
      ) : isError ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <>
          {mix && mix.slices.length > 0
            ? mix.slices.map((slice, index) => (
                <View key={slice.key} style={{ gap: 4 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <Text
                      {...typeCap("bodySmall")}
                      style={{
                        color: t.fg,
                        ...typeStyle("bodySmall"),
                        fontFamily: FONT.regular,
                        flexShrink: 1,
                      }}
                      numberOfLines={1}
                    >
                      {slice.label}
                    </Text>
                    {/* The exact count sits beside the compacted share, so
                        the number is never only available as a bar length. */}
                    <Text
                      {...typeCap("bodySmall")}
                      style={{
                        color: t.fgMuted,
                        ...typeStyle("bodySmall"),
                        fontFamily: FONT.regular,
                        fontVariant: ["tabular-nums"],
                      }}
                      accessibilityLabel={`${slice.label}: ${num(slice.count)} subscribers, ${percent(slice.share)}`}
                    >
                      {`${num(slice.count)} · ${percent(slice.share)}`}
                    </Text>
                  </View>
                  <View
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    style={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: t.bgSubtle,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        width: `${Math.max(2, Math.round(slice.share * 100))}%`,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: palette.seriesColor(index),
                      }}
                    />
                  </View>
                </View>
              ))
            : null}
          {note ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {note}
            </Text>
          ) : null}
        </>
      )}
    </Card>
  );
}
