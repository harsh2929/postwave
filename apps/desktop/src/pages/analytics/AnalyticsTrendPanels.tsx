import type { ReactElement } from "react";

import { ChartActions } from "../../components/analytics/ChartActions";
import { GroupedTimeseriesChart } from "../../components/analytics/GroupedTimeseriesChart";
import { xTickStrideFor } from "../../components/analytics/AnalyticsPresentation";
import { Funnel } from "../../components/charts/Funnel";
import { LineChart } from "../../components/charts/LineChart";
import { MultiLineChart } from "../../components/charts/MultiLineChart";
import { InlineHelp } from "../../components/InlineHelp";
import type { AnalyticsDashboardProps } from "./analytics-dashboard-types";

export function SubscriberGrowthPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { highlightedChart, range, series, subscriberChartRef } =
    dashboard.controller;
  return (
    <div
      id="subscriber-growth"
      ref={subscriberChartRef}
      className={
        "card pw-chart-card" +
        (highlightedChart === "subscriber-growth"
          ? " is-drilldown-highlight"
          : "")
      }
      style={{ marginTop: 12, marginBottom: 12 }}
    >
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Subscriber growth
          <InlineHelp text="Total subscribers each day. Plotted from the daily snapshot — additions minus unsubs and bounces." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {series && series.length > 0 ? `Live · ${range}` : "No daily series"}
        </div>
        <ChartActions
          chartId="subscriber-growth"
          chartName="Subscriber growth"
          rangeLabel={range}
          getChartEl={() => subscriberChartRef.current}
        />
      </div>
      {series && series.length > 0 ? (
        <LineChart
          data={series}
          height={200}
          xTickStride={xTickStrideFor(range)}
          title="Subscriber growth"
          valueLabel="Subscribers"
          provenance={{
            source: "Moosewave subscriber-timeseries API",
            asOf:
              dashboard.controller.lastUpdated != null
                ? new Date(dashboard.controller.lastUpdated).toISOString()
                : null,
            scope: `Current workspace · ${range}`,
          }}
          exportFileName="subscriber-growth.csv"
          exportPrivacy="confidential"
        />
      ) : (
        <div className="pw-chart-empty">
          Daily subscriber history is empty for this range.
        </div>
      )}
    </div>
  );
}

export function EngagementVelocityPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { engagementChartRef, highlightedChart, range } = dashboard.controller;
  const series = dashboard.view.engagementSeries;
  return (
    <div
      id="engagement-velocity"
      ref={engagementChartRef}
      className={
        "card pw-chart-card" +
        (highlightedChart === "engagement-velocity"
          ? " is-drilldown-highlight"
          : "")
      }
    >
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Engagement velocity
          <InlineHelp text="Daily totals across all campaigns for opens, clicks, and replies. Use this to spot day-over-day spikes or dips." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Daily opens · clicks · replies · {range}
        </div>
        <ChartActions
          chartId="engagement-velocity"
          chartName="Engagement velocity"
          rangeLabel={range}
          getChartEl={() => engagementChartRef.current}
        />
      </div>
      {series.opens.length > 1 ||
      series.clicks.length > 1 ||
      series.replies.length > 1 ? (
        <MultiLineChart
          height={240}
          xTickStride={xTickStrideFor(range)}
          series={[
            { label: "Opens", values: series.opens },
            { label: "Clicks", values: series.clicks },
            { label: "Replies", values: series.replies },
          ]}
          title="Engagement velocity"
          valueLabel="Events"
          provenance={{
            source: "Moosewave analytics dashboard API",
            asOf:
              dashboard.controller.lastUpdated != null
                ? new Date(dashboard.controller.lastUpdated).toISOString()
                : null,
            scope: `Current workspace · daily engagement · ${range}`,
          }}
          exportFileName="engagement-velocity.csv"
          exportPrivacy="confidential"
        />
      ) : (
        <div className="pw-chart-empty">
          No engagement events in this window
        </div>
      )}
    </div>
  );
}

export function EngagementFunnelPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Engagement funnel
          <InlineHelp text="Conversion at each step: Sent → Delivered → Opened → Clicked. Percentages are calculated against the previous step." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {dashboard.controller.range} aggregate
        </div>
      </div>
      {dashboard.view.funnelHasData ? (
        <Funnel
          rows={dashboard.view.funnelRows}
          showConversion
          title="Engagement funnel"
          valueLabel="Messages"
          provenance={{
            source: "Moosewave analytics dashboard API",
            asOf:
              dashboard.controller.lastUpdated != null
                ? new Date(dashboard.controller.lastUpdated).toISOString()
                : null,
            scope: `Current workspace · ${dashboard.controller.range} aggregate`,
          }}
          exportFileName="engagement-funnel.csv"
          exportPrivacy="confidential"
        />
      ) : (
        <div className="pw-chart-empty">
          No per-email send counts for this window yet — the funnel appears once
          sends are recorded
        </div>
      )}
    </div>
  );
}

export function AnalyticsTrendPanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <SubscriberGrowthPanel dashboard={dashboard} />
      <div className="dash-grid">
        {dashboard.controller.groupedDimension ? (
          <GroupedTimeseriesChart
            dimension={dashboard.controller.groupedDimension}
            height={240}
          />
        ) : (
          <EngagementVelocityPanel dashboard={dashboard} />
        )}
        <EngagementFunnelPanel dashboard={dashboard} />
      </div>
    </>
  );
}
