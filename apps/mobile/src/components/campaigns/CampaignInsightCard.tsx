/**
 * CampaignInsightCard — one collapsible analytics drilldown.
 *
 * Collapsed by default and disclosure-driven, because each card owns a real
 * aggregate query on the gateway and a phone opens a campaign far more often
 * than it wants any single breakdown. Expanding is what enables the query.
 *
 * The disclosure control is a single 44pt row carrying
 * `accessibilityState={{ expanded }}`, so the open/closed state is announced
 * rather than being conveyed only by a rotated chevron.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import type { InsightRow } from "@/lib/campaignInsights";

export interface CampaignInsightCardProps {
  title: string;
  /** One-line description shown under the title when expanded. */
  caption?: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Copy for the "this deployment doesn't expose it / nothing here" case. */
  emptyMessage: string;
  /** True when the query resolved but there is nothing to render. */
  empty: boolean;
  children?: ReactNode;
}

export function CampaignInsightCard({
  title,
  caption,
  expanded,
  onToggle,
  loading,
  error,
  onRetry,
  emptyMessage,
  empty,
  children,
}: CampaignInsightCardProps) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        marginBottom: 8,
      }}
    >
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        accessibilityHint={
          expanded ? "Collapses this section" : "Loads and shows this section"
        }
        style={{
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            fontSize: 14,
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {title}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgMuted, fontSize: 13, fontFamily: FONT.regular }}
        >
          {expanded ? "Hide" : "Show"}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ paddingBottom: 14 }}>
          {caption ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontSize: 11,
                lineHeight: 16,
                marginBottom: 8,
                fontFamily: FONT.regular,
              }}
            >
              {caption}
            </Text>
          ) : null}
          {loading ? (
            <SkeletonCard lines={3} />
          ) : error ? (
            <ErrorState compact error={error} onRetry={onRetry} />
          ) : empty ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                fontSize: 12,
                lineHeight: 17,
                fontFamily: FONT.regular,
              }}
            >
              {emptyMessage}
            </Text>
          ) : (
            children
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A ranked list with an inline share bar. The bar is decorative — the count
 * is always present as text and the row carries an exact spoken label — so a
 * colour-blind reader loses nothing.
 */
export function InsightRankedList({ rows }: { rows: readonly InsightRow[] }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      {rows.map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={row.spoken ?? `${row.label}, ${row.value}`}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              numberOfLines={1}
              style={{
                color: t.fg,
                fontSize: 13,
                fontFamily: FONT.regular,
                flex: 1,
                writingDirection: "auto",
              }}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("mono")}
              style={{
                color: t.fgMuted,
                fontSize: 13,
                fontFamily: FONT.medium,
                fontVariant: ["tabular-nums"],
              }}
            >
              {row.value}
            </Text>
          </View>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              height: 3,
              borderRadius: 2,
              backgroundColor: t.borderSubtle,
              overflow: "hidden",
              marginTop: 4,
            }}
          >
            <View
              style={{
                width: `${Math.round(row.share * 100)}%`,
                height: 3,
                backgroundColor: t.accent,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}
