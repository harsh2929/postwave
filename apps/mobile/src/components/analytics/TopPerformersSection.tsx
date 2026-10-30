/**
 * TopPerformersSection — which templates are actually working.
 *
 * Backed by GET /api/v1/analytics/template-leaderboard, which ranks templates
 * by the engagement of the campaigns built from them over a trailing window.
 *
 * A ranked list is the most phone-native data shape there is, so this is a
 * horizontal BarChart rather than anything cleverer. Bars are scaled by SENDS —
 * the volume behind the number — while each row's hint carries the open and
 * click rates. Ranking by rate alone would put a template with three sends and
 * two opens above the one that carries the programme, which is how leaderboards
 * lie.
 */
import { View } from "react-native";

import { Card } from "@/components/Card";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { LeaderboardRow } from "@/lib/analyticsSeries";
import { percent, plural } from "@/lib/format";

export interface TopPerformersSectionProps {
  query: QueryLike;
  rows: readonly LeaderboardRow[];
  gate: Pick<OnlineQueryGate, "enabled">;
  rangeLabel: string;
}

function hintFor(row: LeaderboardRow): string {
  const parts = [plural(row.campaignsUsed, "campaign")];
  if (row.openRate !== null) parts.push(`${percent(row.openRate)} opened`);
  if (row.clickRate !== null) parts.push(`${percent(row.clickRate)} clicked`);
  return parts.join(" · ");
}

export function TopPerformersSection({
  query,
  rows,
  gate,
  rangeLabel,
}: TopPerformersSectionProps) {
  const data: BarDatum[] = rows.map((row) => ({
    id: row.id,
    label: row.name,
    value: row.sent,
    hint: hintFor(row),
  }));

  return (
    <View>
      <SectionLabel>Top performers</SectionLabel>
      <Card>
        <QueryStates
          query={query}
          isEmpty={data.length === 0}
          gate={gate}
          skeleton={<SkeletonCard lines={4} />}
          empty={{
            title: "No template performance yet",
            description:
              "Templates appear here once campaigns built from them have been sent in this window.",
          }}
        >
          <BarChart
            data={data}
            title={`Sends by template · ${rangeLabel}`}
            valueNoun="sends"
            showShare
            maxRows={6}
          />
        </QueryStates>
      </Card>
    </View>
  );
}
