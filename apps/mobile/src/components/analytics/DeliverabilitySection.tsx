/**
 * DeliverabilitySection — the three rates an operator checks when something
 * feels wrong, with the previous window beside them.
 *
 * Sourced from the dashboard-stats payload the app already fetches
 * (`?compare=true` supplies the `previous` block), so this section costs zero
 * additional requests.
 *
 * Denominator honesty is the whole point of the section:
 *
 *  - open and click rates use unique DELIVERED recipients, falling back to
 *    unique sent — gross event counts include repeat opens and privacy-proxy
 *    activity and would inflate both;
 *  - bounce rate uses unique SENT, because a bounce is by definition a message
 *    that was never delivered.
 *
 * A rise in bounce rate is bad news, so its delta is rendered in neutral ink:
 * the tile's up-arrow is painted with the success colour, and asserting "up is
 * good" about bounces would be worse than saying nothing.
 */
import { Text, View } from "react-native";

import { StatCard } from "@/components/StatCard";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonStatRow } from "@/components/Skeleton";
import type { DashboardStats } from "@/hooks/useDashboard";
import {
  pickBounceRate,
  pickClickRate,
  pickOpenRate,
  pickPreviousBounceRate,
  pickPreviousClickRate,
  pickPreviousOpenRate,
} from "@/hooks/useDashboard";
import { neutralDelta, rateDelta } from "@/lib/dashboardMetrics";
import { FONT } from "@/lib/fonts";
import { EMDASH, percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DeliverabilitySectionProps {
  stats: DashboardStats | undefined;
  loading: boolean;
  rangeLabel: string;
}

function rateTileValue(rate: number | null): string {
  return rate === null ? EMDASH : percent(rate);
}

/**
 * The spoken VALUE only. `StatCard` composes its announcement as
 * `${label}, ${exact}`, so repeating the label here made VoiceOver say
 * "Open rate, Open rate, 24.3%".
 */
function spokenRate(rate: number | null): string {
  return rate === null ? "not reported" : percent(rate);
}

export function DeliverabilitySection({
  stats,
  loading,
  rangeLabel,
}: DeliverabilitySectionProps) {
  const { t } = useTheme();
  const openRate = pickOpenRate(stats);
  const clickRate = pickClickRate(stats);
  const bounceRate = pickBounceRate(stats);

  const tiles = [
    {
      key: "open",
      label: "Open rate",
      rate: openRate,
      delta: rateDelta(openRate, pickPreviousOpenRate(stats)),
    },
    {
      key: "click",
      label: "Click rate",
      rate: clickRate,
      delta: rateDelta(clickRate, pickPreviousClickRate(stats)),
    },
    {
      key: "bounce",
      label: "Bounce rate",
      rate: bounceRate,
      delta: neutralDelta(rateDelta(bounceRate, pickPreviousBounceRate(stats))),
    },
  ];

  return (
    <View>
      <SectionLabel topMargin={20}>Deliverability</SectionLabel>
      {loading ? (
        <SkeletonStatRow tiles={3} label="Loading deliverability" />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {tiles.map((tile) => (
            <View
              key={tile.key}
              style={{ flexBasis: "30%", flexGrow: 1, minWidth: 104 }}
            >
              <StatCard
                label={tile.label}
                value={rateTileValue(tile.rate)}
                exact={spokenRate(tile.rate)}
                delta={tile.delta}
              />
            </View>
          ))}
        </View>
      )}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          marginTop: 8,
        }}
      >
        {rangeLabel}. Opens and clicks are unique recipients over delivered
        recipients; bounces are over messages sent. An em-dash means the
        recipient counts needed for that rate were not reported.
      </Text>
    </View>
  );
}
