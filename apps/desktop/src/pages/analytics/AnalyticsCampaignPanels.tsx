import type { ReactElement } from "react";

import {
  BenchmarkBadge,
  campaignKey,
} from "../../components/analytics/AnalyticsPresentation";
import { CampaignCompareCard } from "../../components/analytics/CampaignCompareCard";
import { BarChart } from "../../components/charts/BarChart";
import { InlineHelp } from "../../components/InlineHelp";
import type { AnalyticsDashboardProps } from "./analytics-dashboard-types";

export function CampaignPerformancePanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { benchmark, benchmarkResponse, campaigns, setDrillTarget } =
    dashboard.controller;
  const view = dashboard.view;
  const benchmarkMeta = benchmarkResponse as
    | (NonNullable<typeof benchmarkResponse> & {
        baseline_unavailable_reason?: string;
        minimum_sample_size?: number;
      })
    | null;
  const minimumSampleSize = benchmarkMeta?.minimum_sample_size ?? 5;
  const baselineSampleSize = benchmarkMeta?.baseline_sample_size ?? 0;
  const benchmarkCanVerdict =
    benchmarkMeta != null &&
    benchmarkMeta.baseline_available !== false &&
    baselineSampleSize >= minimumSampleSize;
  const benchmarkMetrics = (benchmarkMeta?.metrics ?? benchmark) as Array<
    (typeof benchmark)[number] & {
      available?: boolean;
      delta_pct: number | null;
      reason?: string;
      verdict?: string;
    }
  >;
  const verdictMetrics = benchmarkCanVerdict
    ? benchmarkMetrics.filter(
        (metric) =>
          metric.available !== false &&
          typeof metric.verdict === "string" &&
          metric.verdict.length > 0,
      )
    : [];
  const baselineLabel = benchmarkMeta
    ? `${benchmarkMeta.baseline_days}d baseline · ${baselineSampleSize} prior campaign${baselineSampleSize === 1 ? "" : "s"}`
    : null;
  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Campaign performance
          <InlineHelp
            text={`Opens and clicks for your most recent five campaigns. When at least ${minimumSampleSize} prior campaigns exist, benchmark verdicts compare the latest campaign with the trailing ${benchmarkMeta?.baseline_days ?? 90}-day baseline. Otherwise the comparison is explicitly withheld.`}
          />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Most recent {Math.min(5, campaigns.length)}
          {baselineLabel ? ` · ${baselineLabel}` : ""}
        </div>
      </div>
      {view.campaignsHaveData ? (
        <>
          <BarChart
            categories={view.cats}
            series={[
              { label: "Opens", values: view.opensSeries },
              { label: "Clicks", values: view.clicksSeries },
            ]}
            height={220}
            title="Recent campaign opens and clicks"
            valueLabel="Events"
            provenance={{
              source: "Moosewave campaign analytics API",
              asOf:
                dashboard.controller.lastUpdated != null
                  ? new Date(dashboard.controller.lastUpdated).toISOString()
                  : null,
              scope: `Most recent ${Math.min(5, campaigns.length)} campaigns`,
              note:
                benchmarkMeta != null
                  ? benchmarkCanVerdict
                    ? `Benchmark verdicts use ${baselineSampleSize} prior campaigns from a separate trailing ${benchmarkMeta.baseline_days}-day baseline.`
                    : `Benchmark verdicts are withheld: ${baselineSampleSize} of ${minimumSampleSize} required prior campaigns are available.`
                  : "No benchmark baseline is included in this chart export.",
            }}
            exportFileName="recent-campaign-opens-clicks.csv"
            exportPrivacy="confidential"
          />
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>
              Drill in:
            </span>
            {campaigns.map((campaign) => {
              const id = campaignKey(campaign);
              if (!id) return null;
              const name = campaign.name ?? campaign.subject ?? "Untitled";
              return (
                <button
                  key={id}
                  type="button"
                  className="chip"
                  onClick={() => setDrillTarget({ id, name })}
                  aria-label={`Open analytics for ${name}`}
                  style={{
                    maxWidth: 220,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {name} →
                </button>
              );
            })}
          </div>
          {benchmarkMeta != null ? (
            <div
              style={{
                marginTop: 12,
                borderTop: "1px solid var(--pw-border)",
                paddingTop: 10,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                fontSize: 11,
                color: "var(--pw-fg-muted)",
              }}
            >
              {benchmarkCanVerdict ? (
                <>
                  <span style={{ color: "var(--pw-fg)" }}>
                    Latest campaign:
                  </span>
                  {verdictMetrics.slice(0, 5).map((metric) => (
                    <span
                      key={metric.name}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span>{metric.name.replace(/_/g, " ")}</span>
                      <BenchmarkBadge verdict={metric.verdict ?? "on_par"} />
                      {metric.delta_pct != null ? (
                        <span className="analytics-benchmark-delta tabular">
                          ({metric.delta_pct >= 0 ? "+" : ""}
                          {metric.delta_pct.toFixed(1)}%)
                        </span>
                      ) : (
                        <span className="analytics-benchmark-delta">
                          baseline is zero
                        </span>
                      )}
                    </span>
                  ))}
                </>
              ) : (
                <span
                  className="muted"
                  role="status"
                  style={{ color: "var(--pw-fg-subtle)" }}
                >
                  Benchmark withheld · {baselineSampleSize}/{minimumSampleSize}{" "}
                  required prior campaigns. Add more comparable sends before
                  treating a relative verdict as evidence.
                  {benchmarkMeta.baseline_unavailable_reason
                    ? ` (${benchmarkMeta.baseline_unavailable_reason.replace(/_/g, " ")})`
                    : ""}
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="pw-chart-empty">No campaigns yet</div>
      )}
    </div>
  );
}

export function AnalyticsCampaignPanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { allCampaigns } = dashboard.controller;
  return (
    <>
      <CampaignPerformancePanel dashboard={dashboard} />
      <div style={{ marginTop: 12 }}>
        <CampaignCompareCard
          candidates={allCampaigns}
          initialIds={allCampaigns.slice(0, 3).map(campaignKey).filter(Boolean)}
        />
      </div>
    </>
  );
}
