/**
 * CampaignEngagementInsightCards — the two campaign-report drilldowns added
 * for desktop parity in the 2026-08 pass:
 *
 *   Engagement over time  GET /campaigns/{id}/timeseries      (viewer)
 *   By locale             GET /campaigns/{id}/locale-report    (viewer)
 *
 * Whole CARDS, not bare bodies: CampaignInsightsSection's job is choosing
 * WHICH panel is open, and two more inline card blocks pushed its component
 * past the 300-line function budget. Each of these mounts there as one
 * element.
 *
 * The hourly chart plots three series, not two, because that is what the
 * endpoint reports and what the desktop slideover draws
 * (CampaignAnalyticsSlideover.tsx:370-379): the hour a send starts costing
 * subscribers is the one an operator most wants beside the hour it earned
 * opens.
 *
 * All interpretation lives in lib/campaignEngagementInsights, where it is
 * node-tested; this file only lays it out.
 *
 * CampaignInsightCard is reached by RELATIVE path on purpose: jest.routes
 * .config stubs every `@/components/campaigns/*` leaf to a null component, so
 * going through the alias would make the render test a test of the stub. The
 * section still imports THIS file by alias, so the detail-screen composition
 * tests keep their cheap stub.
 */
import { Text, View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import {
  hourlyEmptyMessage,
  hourlyWindowCaption,
  localeEmptyMessage,
  localeReportRows,
  readHourlyEngagement,
  type HourlyEngagementReading,
} from "@/lib/campaignEngagementInsights";
import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { CampaignInsightCard, InsightRankedList } from "./CampaignInsightCard";

/**
 * The slice of a `useCampaignInsight` result these cards read. Structural
 * rather than `ReturnType<typeof useCampaignInsight>` so the file carries no
 * react-query import and a test can hand it a plain object.
 */
export interface InsightCardQuery {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  refetch: () => unknown;
}

function EngagementOverTimeBody({
  reading,
  t,
}: {
  reading: HourlyEngagementReading;
  t: ThemeTokens;
}) {
  return (
    <View style={{ gap: 8 }}>
      <TimeSeriesChart
        series={[
          { id: "opens", label: "Opens", values: reading.opens },
          { id: "clicks", label: "Clicks", values: reading.clicks },
          { id: "unsubs", label: "Unsubscribes", values: reading.unsubs },
        ]}
        labels={reading.labels}
        title="Engagement by hour"
        valueNoun="events"
        height={160}
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {hourlyWindowCaption(reading)}
      </Text>
    </View>
  );
}

export function CampaignEngagementOverTimeCard({
  query,
  expanded,
  onToggle,
}: {
  query: InsightCardQuery;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  const reading = readHourlyEngagement(query.data);
  return (
    <CampaignInsightCard
      title="Engagement over time"
      caption="How the send's opens, clicks and unsubscribes unfolded, hour by hour."
      expanded={expanded}
      onToggle={onToggle}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={query.data == null || reading.empty}
      emptyMessage={hourlyEmptyMessage(reading)}
    >
      <EngagementOverTimeBody reading={reading} t={t} />
    </CampaignInsightCard>
  );
}

export function CampaignLocaleReportCard({
  query,
  expanded,
  onToggle,
}: {
  query: InsightCardQuery;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = localeReportRows(query.data);
  return (
    <CampaignInsightCard
      title="By locale"
      caption="Which language variant performed, ranked by recipients sent."
      expanded={expanded}
      onToggle={onToggle}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={query.data == null || rows.length === 0}
      emptyMessage={localeEmptyMessage(query.data)}
    >
      <InsightRankedList rows={rows} />
    </CampaignInsightCard>
  );
}
