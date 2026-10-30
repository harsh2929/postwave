/**
 * WeightDriftSection — how a bandit test MOVED its traffic, not just where it
 * ended up.
 *
 * The gap this closes: mobile's Variants section shows the static end state, so
 * a multi-armed bandit and a fixed 50/50 split rendered identically. That is
 * the difference between "we chose this split" and "the algorithm learned this
 * split", and the second is the entire reason to run a bandit. Mobile can even
 * CREATE bandit tests (CampaignSubjectModal's A/B hand-off) — so it could start
 * something it had no way to observe.
 *
 * Mirrors the desktop guard exactly: the block renders only when some arm has
 * two or more recorded weights (`reading.drifted`). One point per arm draws a
 * flat line that asserts "the split never moved", when the truth is "we have
 * one reading". Silence is the honest answer.
 *
 * It is also self-effacing on purpose — no card, no empty state, no error
 * banner. A fixed split legitimately has no history, and a deployment without
 * the endpoint answers 404. Neither is a fault worth a red box under a results
 * screen the operator opened to read numbers.
 */
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { getABWeightHistory } from "@/api/abTests";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { SectionLabel } from "@/components/SectionLabel";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { readWeightHistory, weightDriftSummary } from "@/lib/abWeightHistory";
import { FONT } from "@/lib/fonts";
import { time } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface WeightDriftSectionProps {
  campaignId: string;
}

export function WeightDriftSection({ campaignId }: WeightDriftSectionProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();

  const q = useQuery({
    queryKey: ["ab-weight-history", gate.tenantId, campaignId],
    queryFn: () => getABWeightHistory(campaignId),
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    // The allocator recomputes on an interval measured in minutes, so a
    // freshly-fetched ledger stays true for a while; re-reading it on every
    // metric switch would cost a query for a chart that cannot have changed.
    staleTime: 60_000,
  });

  const reading = useMemo(
    () => readWeightHistory(q.data?.data),
    [q.data?.data],
  );
  const summary = useMemo(() => weightDriftSummary(reading), [reading]);

  // Not "drifted yet" covers all four quiet cases at once: still loading, a
  // fixed split, an absent endpoint, and a bandit with a single recompute.
  if (!reading.drifted) return null;

  const labels = reading.ticks.map((ms) => time(ms));

  return (
    <View style={{ marginTop: 4 }}>
      <SectionLabel topMargin={12}>Traffic allocation</SectionLabel>

      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 12,
        }}
      >
        {/*
          `zeroBased` is left at its default: share-of-traffic is a count-like
          measure where a truncated axis would turn a 4-point move into a
          visual collapse. The chart's own legend carries each arm's colour AND
          name, and its "View as table" toggle exposes the numbers, so identity
          here is never colour-alone.
        */}
        <TimeSeriesChart
          series={reading.series}
          labels={labels}
          title="Share of traffic per variant (%)"
          valueNoun="percent of traffic"
          height={170}
        />

        {summary ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 8,
            }}
          >
            {summary}
          </Text>
        ) : null}

        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          Each point is one allocation recompute. A break in a line is a
          recompute that recorded no weight for that variant — not a drop to
          zero.
        </Text>
      </View>
    </View>
  );
}
