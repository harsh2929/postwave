/**
 * CampaignCompareSheet — two or three campaigns, side by side.
 *
 * Desktop's CampaignCompareCard is a 590-line N-way table. The phone form is
 * a narrow grid: metric name on the left, one column per campaign, capped at
 * three because a fourth column on a 390pt screen is unreadable. Same
 * endpoint, `GET /api/v1/analytics/campaigns/compare?ids=…` (read:reports).
 *
 * THE HONESTY RULES, all enforced in lib/campaignCompare and rendered here:
 *
 *  - A campaign the server has no events for comes back ZERO-FILLED rather
 *    than omitted. Those cells are em-dashes, not "0.0%", and that campaign
 *    is excluded from every "led on" claim instead of losing every metric.
 *  - The leader is marked with a WORD ("higher" / "lower") beside the value
 *    and in the spoken label, never by colour alone.
 *  - A tie, or a metric only one campaign has, produces NO leader — the sheet
 *    would otherwise crown a winner on a single measurement.
 *  - Bounce, complaint and unsubscribe rates are compared LOWER-IS-BETTER.
 *    A screen that highlighted the higher bounce rate as the winner would be
 *    actively misleading on the metric that gets a domain blocked.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { ScrollView, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { ModalHeader } from "@/components/campaigns/CampaignDetailControls";
import { SkeletonList } from "@/components/Skeleton";
import {
  COMPARE_METRICS,
  compareHeadline,
  compareLeader,
  type CampaignCompareRow,
} from "@/lib/campaignCompare";
import { campaignRate } from "@/lib/campaignFormat";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignCompareSheetProps {
  visible: boolean;
  onClose: () => void;
  rows: readonly CampaignCompareRow[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Display name for a campaign id — the sheet never shows a raw UUID. */
  nameFor: (campaignId: string) => string;
}

export function CampaignCompareSheet({
  visible,
  onClose,
  rows,
  loading,
  error,
  onRetry,
  nameFor,
}: CampaignCompareSheetProps) {
  const { t } = useTheme();
  const list = rows ?? [];

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Compare campaigns"
    >
      <ModalHeader title="Compare" onClose={onClose} />

      {loading ? (
        <SkeletonList rows={5} />
      ) : error ? (
        <ErrorState
          error={error}
          message="Couldn't load the comparison."
          onRetry={onRetry}
        />
      ) : list.length < 2 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            lineHeight: 19,
            fontFamily: FONT.regular,
          }}
        >
          The report came back with fewer than two campaigns, so there is
          nothing to place side by side.
        </Text>
      ) : (
        <>
          <Text
            {...typeCap("bodySmall")}
            accessibilityRole="summary"
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              lineHeight: 20,
              marginBottom: 16,
              fontFamily: FONT.regular,
            }}
          >
            {compareHeadline(list, nameFor)}
          </Text>

          {/* Horizontal scroll rather than shrinking type: three campaign
              names cannot fit a phone width at an accessible size, and this
              screen's whole job is comparing numbers people can read. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={{ flexDirection: "row", marginBottom: 8 }}>
                <View style={{ width: 130 }} />
                {list.map((row) => (
                  <View key={row.campaignId} style={{ width: 120, paddingStart: 8 }}>
                    <Text
                      {...typeCap("label")}
                      numberOfLines={2}
                      style={{
                        color: t.fg,
                        ...typeStyle("label"),
                        fontFamily: FONT.semibold,
                        writingDirection: "auto",
                      }}
                    >
                      {nameFor(row.campaignId)}
                    </Text>
                    <Text
                      {...typeCap("caption")}
                      style={{
                        color: t.fgSubtle,
                        ...typeStyle("caption"),
                        marginTop: 2,
                        fontFamily: FONT.regular,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {row.totalRecipients === null
                        ? "no delivery yet"
                        : `${num(row.totalRecipients)} recipients`}
                    </Text>
                  </View>
                ))}
              </View>

              {COMPARE_METRICS.map((metric) => {
                const leader = compareLeader(list, metric);
                return (
                  <View
                    key={metric.key}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 10,
                      borderTopColor: t.borderSubtle,
                      borderTopWidth: 1,
                    }}
                  >
                    <View style={{ width: 130 }}>
                      <Text
                        {...typeCap("bodySmall")}
                        style={{
                          color: t.fgMuted,
                          ...typeStyle("bodySmall"),
                          fontFamily: FONT.regular,
                        }}
                      >
                        {metric.label}
                      </Text>
                    </View>
                    {list.map((row) => {
                      const value = row[metric.key];
                      const isLeader = leader === row.campaignId;
                      // The endpoint ships 0..1 fractions — see the scale map
                      // in lib/campaignFormat.
                      const shown = campaignRate(value, { scale: "fraction" });
                      return (
                        <View
                          key={row.campaignId}
                          style={{ width: 120, paddingStart: 8 }}
                          accessible
                          accessibilityLabel={
                            value === null
                              ? `${nameFor(row.campaignId)}, ${metric.label}, not measured`
                              : `${nameFor(row.campaignId)}, ${metric.label}, ${shown}${
                                  isLeader ? `, the ${metric.betterWord} of the two` : ""
                                }`
                          }
                        >
                          <Text
                            {...typeCap("body")}
                            style={{
                              color: isLeader ? t.success : t.fg,
                              ...typeStyle("body"),
                              fontFamily: isLeader
                                ? FONT.semibold
                                : FONT.regular,
                              fontVariant: ["tabular-nums"],
                            }}
                          >
                            {shown}
                          </Text>
                          {isLeader ? (
                            <Text
                              {...typeCap("caption")}
                              style={{
                                color: t.fgSubtle,
                                ...typeStyle("caption"),
                                fontFamily: FONT.regular,
                              }}
                            >
                              {metric.betterWord}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          </ScrollView>

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              lineHeight: 16,
              marginTop: 16,
              fontFamily: FONT.regular,
            }}
          >
            Rates are measured against recipients, so campaigns sent to very
            different audience sizes are not like for like. A dash means the
            server has no delivery events for that campaign — not a zero.
          </Text>
        </>
      )}
    </KeyboardFormSheet>
  );
}
