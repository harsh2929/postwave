/**
 * CampaignAnalyticsSlideover — a wide, right-side slide-over with the
 * full analytics drill-down for ONE campaign.
 *
 * Distinct from the existing CampaignDetailSlideover (which is editor /
 * draft / preview focused). This slideover answers questions like:
 *   - Where did this campaign's clicks come from? (top links)
 *   - Who opened it? (mail clients, geography)
 *   - Did anything bounce? Hard/soft/spam-trap split.
 *   - How did it compare to my 90d baseline? (benchmark)
 *   - Did it produce revenue?
 *
 * Uses a custom wider variant of the slideover so charts fit; the base
 * .slideover class is 380px and that's not enough for a per-link table
 * plus geography bars and a donut.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The labelled benchmark region is intentionally keyboard-scrollable at narrow desktop and zoomed layouts. */

import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type BenchmarkMetric,
  type BounceCounts,
  type CampaignBenchmarkResponse,
  type CampaignAnomaly,
  type CampaignLocaleStat,
  type CampaignGoalResults,
  type CampaignReport,
  type CampaignTimeseries,
  type DeviceRow,
  type EngagementPanel,
  type GeographyRow,
  type LinkRow,
  buildStreamUrl,
} from "../../lib/api-client";
import { downloadUrlToFile } from "../../lib/file-transfer";
import { type RemoteFailure } from "../../lib/remote-resource";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { ConfirmModal } from "../ConfirmModal";
import { ExternalLink } from "../ExternalLink";
import { Notice } from "../Notice";
import { SlideoverShell } from "../SlideoverShell";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { Donut, type DonutSlice } from "../charts/Donut";
import { Funnel, type FunnelRow } from "../charts/Funnel";
import { MultiLineChart } from "../charts/MultiLineChart";
import { Sparkline } from "../charts/Sparkline";
import { toast } from "../Toast";

import { EngagementPanelSection } from "./EngagementPanel";
import {
  CAMPAIGN_ANALYTICS_RESOURCE_LABELS,
  CAMPAIGN_ANALYTICS_TAB_RESOURCES,
  type CampaignAnalyticsCache,
  type CampaignAnalyticsResource,
  type CampaignAnalyticsResourceKey,
  type CampaignAnalyticsTab,
  campaignAnalyticsTabStatus,
  useCampaignAnalyticsDrilldown,
} from "./useCampaignAnalyticsDrilldown";
import "../../styles-campaign-analytics-slideover.css";

interface Props {
  campaignId: string;
  campaignName: string;
  onClose: () => void;
}

type CampaignSectionErrors = Partial<
  Record<
    | "links"
    | "geo"
    | "devices"
    | "bounces"
    | "benchmark"
    | "engagement"
    | "timeseries"
    | "goal"
    | "anomalies"
    | "locales",
    RemoteFailure
  >
>;

type CampaignSectionStatus = CampaignAnalyticsResource<unknown>["status"];
type CampaignSectionStatuses = Partial<
  Record<
    | "report"
    | "links"
    | "geo"
    | "devices"
    | "bounces"
    | "benchmark"
    | "engagement"
    | "timeseries"
    | "goal"
    | "anomalies"
    | "locales",
    CampaignSectionStatus
  >
>;

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

/**
 * Format a FRACTION-unit rate (0.083 → "8.3%"). No unit guessing — a
 * genuine 0.8% rate must never render as 80%. The API mixes units:
 * LinkRow.ctr (analytics/service.go) and BenchmarkMetric value/baseline
 * (campaign_benchmarks.go) are fractions; CampaignReport rates are
 * percent-unit (analytics.go pct() multiplies by 100) and must be
 * divided by 100 at the call site.
 */
function fmtRate(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  const v = frac * 100;
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

function finiteMagnitude(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatEvidenceTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unavailable";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
}

export function campaignBenchmarkCanVerdict(
  benchmark: CampaignBenchmarkResponse,
): boolean {
  return (
    benchmark.baseline_available &&
    Number.isFinite(benchmark.baseline_sample_size) &&
    benchmark.baseline_sample_size >= benchmark.minimum_sample_size
  );
}

interface CampaignOverviewProps {
  campaignId: string;
  campaignName: string;
  report: CampaignReport | null;
  benchmark: CampaignBenchmarkResponse | null;
  engagement: EngagementPanel | null;
  states: CampaignSectionStatuses;
  errors: CampaignSectionErrors;
  anomalies: CampaignAnomaly[];
  timeseries: CampaignTimeseries | null;
  goal: CampaignGoalResults | null;
}

function CampaignOverviewStats({
  report,
  status,
}: {
  report: CampaignReport | null;
  status: CampaignSectionStatus | undefined;
}): ReactElement | null {
  if (status === "loading") {
    return <LoadingEvidence label="campaign totals" />;
  }
  if (report) {
    return (
      <dl
        className="campaign-analytics-stats"
        aria-label="Campaign performance totals"
      >
        <Stat label="Sent" value={fmtNum(report.sent)} />
        <Stat
          label="Open rate"
          value={fmtRate(report.open_rate / 100)}
          hint={`${fmtNum(report.unique_opens)} uniq`}
        />
        <Stat
          label="Click rate"
          value={fmtRate(report.click_rate / 100)}
          hint={`${fmtNum(report.unique_clicks)} uniq`}
        />
        <Stat
          label="CTOR"
          value={fmtRate(report.click_to_open_rate / 100)}
          hint="click ÷ open"
        />
      </dl>
    );
  }
  return status === "ready" ? (
    <EmptyEvidence
      title="Campaign totals unavailable"
      detail="The campaign report returned no cumulative totals."
    />
  ) : null;
}

function CampaignOverview({
  campaignId,
  campaignName,
  report,
  benchmark,
  engagement,
  states,
  errors,
  anomalies,
  timeseries,
  goal,
}: CampaignOverviewProps): ReactElement {
  const funnelRows: FunnelRow[] = report
    ? [
        { label: "Sent", value: finiteMagnitude(report.sent) },
        { label: "Delivered", value: finiteMagnitude(report.delivered) },
        {
          label: "Opened",
          value: finiteMagnitude(report.unique_opens ?? report.opens),
        },
        {
          label: "Clicked",
          value: finiteMagnitude(report.unique_clicks ?? report.clicks),
        },
      ]
    : [];
  const timeseriesBuckets = (timeseries?.buckets ?? [])
    .filter((bucket) => Number.isFinite(Date.parse(bucket.hour)))
    .map((bucket) => ({
      ...bucket,
      opens: finiteMagnitude(bucket.opens),
      clicks: finiteMagnitude(bucket.clicks),
      unsubs: finiteMagnitude(bucket.unsubs),
    }));
  return (
    <>
      <CampaignOverviewStats report={report} status={states.report} />

      {errors.benchmark ? (
        <SectionError what="benchmark" failure={errors.benchmark} />
      ) : states.benchmark === "loading" ? (
        <LoadingEvidence label="90-day benchmark" />
      ) : benchmark && benchmark.metrics.length > 0 ? (
        <CampaignBenchmarkPanel benchmark={benchmark} />
      ) : states.benchmark === "ready" ? (
        <EmptyEvidence
          title="No benchmark evidence"
          detail="The benchmark service returned no comparable metrics."
        />
      ) : null}

      <EngagementPanelSection
        panel={engagement}
        loading={states.engagement === "loading"}
        error={errors.engagement?.message ?? null}
      />

      {errors.anomalies ? (
        <SectionError what="anomaly analysis" failure={errors.anomalies} />
      ) : states.anomalies === "loading" ? (
        <LoadingEvidence label="anomaly analysis" compact />
      ) : anomalies.length > 0 ? (
        <div
          className="card"
          style={{
            padding: "8px 12px",
            borderLeft: "3px solid var(--pw-warning)",
          }}
        >
          <h3 className="section-title" style={{ marginBottom: 4 }}>
            Anomalies detected
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {anomalies.slice(0, 6).map((anomaly, index) => (
              <div key={index} style={{ fontSize: 12 }}>
                <span
                  className={`badge ${anomaly.direction === "drop" ? "danger" : "warning"}`}
                  style={{ fontSize: 9, marginRight: 6 }}
                >
                  {anomaly.direction}
                </span>
                <span style={{ fontWeight: 600 }}>{anomaly.metric}</span>{" "}
                {fmtNum(anomaly.value)} at {formatEvidenceTime(anomaly.hour)}{" "}
                <span className="muted">
                  ({anomaly.z_score > 0 ? "+" : ""}
                  {fmtNum(anomaly.z_score)}σ vs mean {fmtNum(anomaly.mean)})
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : states.anomalies === "ready" ? (
        <EmptyEvidence
          title="No statistical anomalies detected"
          detail="No hourly spike or drop crossed the campaign anomaly threshold."
          compact
        />
      ) : null}

      {errors.timeseries ? (
        <SectionError
          what="engagement timeseries"
          failure={errors.timeseries}
        />
      ) : states.timeseries === "loading" ? (
        <LoadingEvidence label="hourly engagement" />
      ) : timeseriesBuckets.length >= 2 ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Engagement over time
            </h3>
            <div className="muted" style={{ fontSize: 11 }}>
              Hourly opens · clicks · unsubscribes
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {(
              [
                ["Opens", timeseriesBuckets.map((bucket) => bucket.opens)],
                ["Clicks", timeseriesBuckets.map((bucket) => bucket.clicks)],
                ["Unsubs", timeseriesBuckets.map((bucket) => bucket.unsubs)],
              ] as [string, number[]][]
            ).map(([label, values]) => (
              <div key={label} style={{ minWidth: 110 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  {label} ·{" "}
                  {values
                    .reduce((sum, value) => sum + value, 0)
                    .toLocaleString()}
                </div>
                <Sparkline
                  values={values}
                  labels={timeseriesBuckets.map((bucket) => bucket.hour)}
                  valueLabel={label.toLocaleLowerCase()}
                  ariaLabel={`${label} by hour for ${campaignName}`}
                />
              </div>
            ))}
          </div>
          <MultiLineChart
            series={[
              {
                label: "Opens",
                values: timeseriesBuckets.map((bucket) => ({
                  date: bucket.hour,
                  count: bucket.opens,
                })),
              },
              {
                label: "Clicks",
                values: timeseriesBuckets.map((bucket) => ({
                  date: bucket.hour,
                  count: bucket.clicks,
                })),
              },
              {
                label: "Unsubs",
                values: timeseriesBuckets.map((bucket) => ({
                  date: bucket.hour,
                  count: bucket.unsubs,
                })),
              },
            ]}
            formatDate={(date) =>
              date.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
              })
            }
            title="Campaign engagement over time"
            valueLabel="Events"
            provenance={{
              source: "Moosewave campaign hourly-timeseries API",
              asOf: null,
              scope: `Campaign ${campaignId} · complete recorded lifetime`,
            }}
            exportFileName="campaign-engagement-over-time.csv"
            exportPrivacy="confidential"
          />
        </div>
      ) : states.timeseries === "ready" ? (
        <EmptyEvidence
          title="Not enough hourly evidence"
          detail="At least two recorded time buckets are required to show a trend."
        />
      ) : null}

      {errors.goal ? (
        <SectionError what="conversion goal" failure={errors.goal} />
      ) : states.goal === "loading" ? (
        <LoadingEvidence label="conversion-goal evidence" />
      ) : goal && goal.configured ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Conversion goal
            </h3>
            <div className="muted" style={{ fontSize: 11 }}>
              {goal.goal_event} · within{" "}
              {Number.isFinite(goal.goal_window_hours) &&
              goal.goal_window_hours > 0
                ? goal.goal_window_hours >= 24
                  ? `${goal.goal_window_hours / 24}d`
                  : `${goal.goal_window_hours}h`
                : "window unavailable"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Conversions
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {fmtNum(goal.conversion_count)}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Conversion rate
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {fmtRate(goal.conversion_rate)}
              </div>
            </div>
            {goal.conversion_count > 0 ? (
              <div className="campaign-analytics-integrity-note">
                <div className="muted" style={{ fontSize: 11 }}>
                  Goal revenue
                </div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  Unavailable — currency integrity not provided
                </div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                  This response has no per-currency breakdown, so Moosewave does
                  not sum its amounts.
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : states.goal === "ready" ? (
        <EmptyEvidence
          title="No conversion goal configured"
          detail="This campaign has no goal event and attribution window to evaluate."
        />
      ) : null}

      {report && funnelRows[0]!.value > 0 ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Funnel
            </h3>
            <div className="muted" style={{ fontSize: 11 }}>
              Sent → Delivered → Opened → Clicked
            </div>
          </div>
          <Funnel
            rows={funnelRows}
            showConversion
            title="Campaign engagement funnel"
            valueLabel="Recipients"
            provenance={{
              source: "Moosewave campaign report API",
              asOf: null,
              scope: `Campaign ${campaignId} · cumulative totals`,
            }}
            exportFileName="campaign-engagement-funnel.csv"
            exportPrivacy="confidential"
          />
        </div>
      ) : null}
    </>
  );
}

interface CampaignBreakdownsProps {
  campaignId: string;
  links: LinkRow[];
  devices: DeviceRow[];
  geography: GeographyRow[];
  locales: CampaignLocaleStat[];
  errors: CampaignSectionErrors;
  states: CampaignSectionStatuses;
}

function CampaignTopLinks({
  links,
  status,
  failure,
}: {
  links: LinkRow[];
  status: CampaignSectionStatus | undefined;
  failure: RemoteFailure | undefined;
}): ReactElement | null {
  const sortedLinks = links
    .slice()
    .sort(
      (left, right) =>
        finiteMagnitude(right.clicks) - finiteMagnitude(left.clicks) ||
        left.url.localeCompare(right.url),
    );
  if (failure) {
    return <SectionError what="link report" failure={failure} />;
  }
  if (status === "loading") {
    return <LoadingEvidence label="link-performance evidence" />;
  }
  if (sortedLinks.length === 0) {
    return status === "ready" ? (
      <EmptyEvidence
        title="No link activity recorded"
        detail="No tracked destination received a click for this campaign."
      />
    ) : null;
  }
  const maximumClicks = finiteMagnitude(sortedLinks[0]?.clicks ?? 0);
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <h3 className="section-title" style={{ marginBottom: 0 }}>
          Top links
        </h3>
        <div className="muted" style={{ fontSize: 11 }}>
          Click-through{" "}
          {fmtNum(
            sortedLinks.reduce(
              (sum, link) => sum + finiteMagnitude(link.clicks),
              0,
            ),
          )}{" "}
          clicks ·{" "}
          {fmtNum(
            sortedLinks.reduce(
              (sum, link) => sum + finiteMagnitude(link.unique_clickers),
              0,
            ),
          )}{" "}
          per-link unique clickers
        </div>
      </div>
      <p className="campaign-analytics-section-disclosure">
        A person who clicked more than one link can appear in more than one
        per-link unique count. This is not a campaign-level unique total.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sortedLinks.slice(0, 8).map((link, index) => {
          const width =
            maximumClicks > 0
              ? (finiteMagnitude(link.clicks) / maximumClicks) * 100
              : 0;
          return (
            <div
              key={`${link.url}-${index}`}
              className="campaign-analytics-link-row"
            >
              <ExternalLink
                href={link.url}
                style={{
                  color: "var(--pw-fg)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textDecoration: "none",
                }}
              >
                {displayLinkDestination(link.url)}
              </ExternalLink>
              <div
                aria-hidden="true"
                style={{
                  height: 14,
                  background: "var(--pw-bg-elev-2)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${width}%`,
                    height: "100%",
                    background: "var(--pw-accent)",
                    opacity: 0.85,
                  }}
                />
              </div>
              <div
                className="tabular muted"
                style={{ fontSize: 11, textAlign: "right" }}
              >
                {fmtNum(link.clicks)} clicks · {fmtNum(link.unique_clickers)}{" "}
                unique · {fmtRate(link.ctr)} CTR
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CampaignBreakdowns({
  campaignId,
  links,
  devices,
  geography,
  locales,
  errors,
  states,
}: CampaignBreakdownsProps): ReactElement {
  const sortedMailClients = devices
    .slice()
    .sort(
      (left, right) =>
        finiteMagnitude(right.opens) - finiteMagnitude(left.opens) ||
        (left.client || "Unknown").localeCompare(right.client || "Unknown"),
    );
  const sortedGeography = geography
    .slice()
    .sort(
      (left, right) =>
        finiteMagnitude(right.opens) - finiteMagnitude(left.opens) ||
        (left.country || "Unknown").localeCompare(right.country || "Unknown"),
    );
  const sortedLocales = locales
    .slice()
    .sort(
      (left, right) =>
        finiteMagnitude(right.sent) - finiteMagnitude(left.sent) ||
        (left.locale || "Unspecified").localeCompare(
          right.locale || "Unspecified",
        ),
    );
  const mailClientSlices: DonutSlice[] = sortedMailClients
    .slice(0, 5)
    .map((device) => ({
      label: device.client || "Unknown",
      value: finiteMagnitude(device.opens),
    }));
  const otherMailClientOpens = sortedMailClients
    .slice(5)
    .reduce((sum, device) => sum + finiteMagnitude(device.opens), 0);
  if (otherMailClientOpens > 0) {
    mailClientSlices.push({ label: "Other", value: otherMailClientOpens });
  }
  return (
    <>
      <CampaignTopLinks
        links={links}
        status={states.links}
        failure={errors.links}
      />

      <div className="campaign-analytics-split">
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Mail clients
            </h3>
          </div>
          {errors.devices ? (
            <SectionError what="mail clients" failure={errors.devices} />
          ) : states.devices === "loading" ? (
            <LoadingEvidence label="mail-client evidence" compact />
          ) : mailClientSlices.some((slice) => slice.value > 0) ? (
            <Donut
              slices={mailClientSlices}
              centerLabel="opens"
              size={110}
              thickness={14}
              title="Campaign mail-client mix"
              valueLabel="Opens"
              provenance={{
                source: "Moosewave campaign device analytics API",
                asOf: null,
                scope: `Campaign ${campaignId} · recorded opens`,
                note: "Mail client is inferred from open-beacon user-agent data.",
              }}
              exportFileName="campaign-mail-client-mix.csv"
              exportPrivacy="confidential"
            />
          ) : states.devices === "ready" ? (
            <EmptyEvidence
              title="No mail-client signals"
              detail="No open-beacon client evidence was returned."
              compact
            />
          ) : null}
        </div>
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Top countries
            </h3>
          </div>
          {errors.geo ? (
            <SectionError what="geography" failure={errors.geo} />
          ) : states.geo === "loading" ? (
            <LoadingEvidence label="geography evidence" compact />
          ) : sortedGeography.length > 0 ? (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {sortedGeography.slice(0, 5).map((row, index) => {
                  const max = finiteMagnitude(sortedGeography[0]?.opens ?? 0);
                  const width =
                    max > 0 ? (finiteMagnitude(row.opens) / max) * 100 : 0;
                  return (
                    <div
                      key={index}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "70px 1fr 56px",
                        gap: 6,
                        alignItems: "center",
                        fontSize: 11,
                      }}
                    >
                      <span className="muted" style={{ overflow: "hidden" }}>
                        {row.country || "Unknown"}
                      </span>
                      <div
                        aria-hidden="true"
                        style={{
                          height: 8,
                          background: "var(--pw-bg-elev-2)",
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${width}%`,
                            height: "100%",
                            background: "var(--pw-accent)",
                            opacity: 0.8,
                          }}
                        />
                      </div>
                      <span
                        className="tabular muted"
                        style={{ fontSize: 10, textAlign: "right" }}
                      >
                        {fmtNum(row.opens)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <AccessibleChartData
                title="Campaign top countries"
                summary={`${sortedGeography.length} country rows returned; the visual ranking shows the top ${Math.min(5, sortedGeography.length)} by opens.`}
                rowHeaderLabel="Country"
                columns={[
                  { key: "opens", label: "Opens" },
                  { key: "clicks", label: "Clicks" },
                ]}
                rows={sortedGeography.map((row, index) => ({
                  key: `${index}-${row.country}`,
                  label: row.country || "Unknown",
                  values: {
                    opens: fmtNum(row.opens),
                    clicks: fmtNum(row.clicks),
                  },
                  exportValues: {
                    opens: finiteMagnitude(row.opens),
                    clicks: finiteMagnitude(row.clicks),
                  },
                }))}
                provenance={{
                  source: "Moosewave campaign geography API",
                  asOf: null,
                  scope: `Campaign ${campaignId} · recorded opens and clicks`,
                  note: "Country is derived from the IP address recorded with each open event.",
                }}
                exportFileName="campaign-top-countries.csv"
                exportPrivacy="confidential"
              />
            </>
          ) : states.geo === "ready" ? (
            <EmptyEvidence
              title="No geography signals"
              detail="No country-level open or click evidence was returned."
              compact
            />
          ) : null}
        </div>
      </div>

      {errors.locales ? (
        <SectionError
          what="recipient-language report"
          failure={errors.locales}
        />
      ) : states.locales === "loading" ? (
        <LoadingEvidence label="recipient-language evidence" />
      ) : sortedLocales.length > 0 ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              Recipient languages
            </h3>
            <div className="muted" style={{ fontSize: 11 }}>
              Recorded locale groups · lifetime engagement
            </div>
          </div>
          <div className="campaign-analytics-locale-list">
            {sortedLocales.map((locale) => {
              const openRate =
                finiteMagnitude(locale.sent) > 0
                  ? finiteMagnitude(locale.opens) / finiteMagnitude(locale.sent)
                  : 0;
              return (
                <div
                  key={locale.locale || "unspecified"}
                  className="campaign-analytics-locale-row"
                >
                  <span className="badge">
                    {locale.locale || "Unspecified"}
                  </span>
                  <span className="muted">
                    {fmtNum(locale.sent)} sent · {fmtNum(locale.opens)} opens ·{" "}
                    {fmtNum(locale.clicks)} clicks
                  </span>
                  <span className="tabular">{fmtRate(openRate)} open rate</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : states.locales === "ready" ? (
        <EmptyEvidence
          title="No recipient-language evidence"
          detail="No locale groups were returned for this campaign."
        />
      ) : null}
    </>
  );
}

interface CampaignDeliveryProps {
  campaignId: string;
  report: CampaignReport | null;
  bounces: BounceCounts | null;
  errors: CampaignSectionErrors;
  states: CampaignSectionStatuses;
  exportBusy: boolean;
  exportTriggerRef: RefObject<HTMLButtonElement | null>;
  onReviewExport: () => void;
}

function CampaignDelivery({
  campaignId,
  report,
  bounces,
  errors,
  states,
  exportBusy,
  exportTriggerRef,
  onReviewExport,
}: CampaignDeliveryProps): ReactElement {
  const exportTitleId = useId();
  const bounceSlices: DonutSlice[] = bounces
    ? [
        { label: "Hard", value: finiteMagnitude(bounces.hard) },
        { label: "Soft", value: finiteMagnitude(bounces.soft) },
        { label: "Spam trap", value: finiteMagnitude(bounces.spam_trap) },
      ]
    : [];
  return (
    <>
      {states.report === "loading" ? (
        <LoadingEvidence label="delivery totals" />
      ) : report ? (
        <dl
          className="campaign-analytics-stats campaign-analytics-delivery-stats"
          aria-label="Campaign delivery totals"
        >
          <Stat
            label="Delivered"
            value={fmtNum(report.delivered)}
            hint={`${fmtRate(
              finiteMagnitude(report.sent) > 0
                ? finiteMagnitude(report.delivered) /
                    finiteMagnitude(report.sent)
                : 0,
            )} of sent`}
          />
          <Stat
            label="Bounce rate"
            value={fmtRate(report.bounce_rate / 100)}
            hint={`${fmtNum(report.bounces)} recorded`}
          />
          <Stat
            label="Complaints"
            value={fmtNum(report.complaints)}
            hint={`${fmtRate(
              finiteMagnitude(report.delivered) > 0
                ? finiteMagnitude(report.complaints) /
                    finiteMagnitude(report.delivered)
                : 0,
            )} of delivered`}
          />
          <Stat
            label="Unsubscribe rate"
            value={fmtRate(report.unsub_rate / 100)}
            hint={`${fmtNum(report.unsubscribes)} recorded`}
          />
        </dl>
      ) : states.report === "ready" ? (
        <EmptyEvidence
          title="Delivery totals unavailable"
          detail="The campaign report returned no cumulative delivery totals."
        />
      ) : null}

      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <h3 className="section-title" style={{ marginBottom: 0 }}>
            Bounce mix
          </h3>
        </div>
        {errors.bounces ? (
          <SectionError what="bounce mix" failure={errors.bounces} />
        ) : states.bounces === "loading" ? (
          <LoadingEvidence label="bounce classification" compact />
        ) : bounces && bounces.total > 0 ? (
          <Donut
            slices={bounceSlices}
            centerLabel="bounces"
            size={110}
            thickness={14}
            title="Campaign bounce mix"
            valueLabel="Bounces"
            provenance={{
              source: "Moosewave campaign bounce analytics API",
              asOf: null,
              scope: `Campaign ${campaignId} · cumulative bounce events`,
            }}
            exportFileName="campaign-bounce-mix.csv"
            exportPrivacy="confidential"
          />
        ) : states.bounces === "ready" ? (
          <EmptyEvidence
            title="No recorded bounces"
            detail="No hard, soft, or spam-trap bounce events were returned."
            compact
          />
        ) : null}
      </div>

      {report ? (
        <section
          className="campaign-analytics-export-card"
          aria-labelledby={exportTitleId}
        >
          <div className="campaign-analytics-export-copy">
            <h3 id={exportTitleId} className="section-title">
              Recipient-level evidence
            </h3>
            <p>
              Sensitive export containing subscriber email and lifecycle
              timestamps. Review its fields and scope before download.
            </p>
          </div>
          <button
            ref={exportTriggerRef}
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onReviewExport}
            disabled={exportBusy}
            aria-busy={exportBusy ? "true" : undefined}
          >
            {exportBusy ? "Preparing export…" : "Review recipient export"}
          </button>
        </section>
      ) : null}
    </>
  );
}

interface CampaignAnalyticsTabDefinition {
  id: CampaignAnalyticsTab;
  label: string;
  shortDescription: string;
  description: string;
}

const CAMPAIGN_ANALYTICS_TABS: readonly CampaignAnalyticsTabDefinition[] = [
  {
    id: "overview",
    label: "Overview",
    shortDescription: "Performance & goals",
    description:
      "Cumulative delivery-to-click performance, trust signals, hourly movement, conversion-goal evidence, anomalies, and a separately scoped tenant benchmark.",
  },
  {
    id: "audience",
    label: "Audience & links",
    shortDescription: "Destinations & context",
    description:
      "Aggregate link, mail-client, country, and recipient-language signals. No recipient identities are loaded into this view.",
  },
  {
    id: "delivery",
    label: "Delivery",
    shortDescription: "Bounce & recipient evidence",
    description:
      "Cumulative bounce classification plus a separately confirmed, permission-checked recipient lifecycle export.",
  },
] as const;

function untypedResource(
  cache: CampaignAnalyticsCache,
  key: CampaignAnalyticsResourceKey,
): CampaignAnalyticsResource<unknown> {
  return (
    cache as unknown as Record<
      CampaignAnalyticsResourceKey,
      CampaignAnalyticsResource<unknown>
    >
  )[key];
}

function campaignSectionErrors(
  cache: CampaignAnalyticsCache,
): CampaignSectionErrors {
  return {
    ...(cache.links.failure ? { links: cache.links.failure } : null),
    ...(cache.geo.failure ? { geo: cache.geo.failure } : null),
    ...(cache.devices.failure ? { devices: cache.devices.failure } : null),
    ...(cache.bounces.failure ? { bounces: cache.bounces.failure } : null),
    ...(cache.benchmark.failure
      ? { benchmark: cache.benchmark.failure }
      : null),
    ...(cache.engagement.failure
      ? { engagement: cache.engagement.failure }
      : null),
    ...(cache.timeseries.failure
      ? { timeseries: cache.timeseries.failure }
      : null),
    ...(cache.goal.failure ? { goal: cache.goal.failure } : null),
    ...(cache.anomalies.failure
      ? { anomalies: cache.anomalies.failure }
      : null),
    ...(cache.locales.failure ? { locales: cache.locales.failure } : null),
  };
}

function campaignSectionStatuses(
  cache: CampaignAnalyticsCache,
): CampaignSectionStatuses {
  return {
    report: cache.report.status,
    links: cache.links.status,
    geo: cache.geo.status,
    devices: cache.devices.status,
    bounces: cache.bounces.status,
    benchmark: cache.benchmark.status,
    engagement: cache.engagement.status,
    timeseries: cache.timeseries.status,
    goal: cache.goal.status,
    anomalies: cache.anomalies.status,
    locales: cache.locales.status,
  };
}

function failureCopy(failure: RemoteFailure): string {
  const diagnostics = [
    failure.code ? `code ${failure.code}` : null,
    failure.requestId ? `request ${failure.requestId}` : null,
  ].filter(Boolean);
  return diagnostics.length > 0
    ? `${failure.message} Reference: ${diagnostics.join(" · ")}.`
    : failure.message;
}

function tabState(
  status: ReturnType<typeof campaignAnalyticsTabStatus>,
): "error" | "loading" | "ready" | "idle" {
  if (status.errorCount > 0) return "error";
  if (status.loadingCount > 0) return "loading";
  if (status.readyCount === status.totalCount) return "ready";
  return "idle";
}

function tabStateCopy(
  status: ReturnType<typeof campaignAnalyticsTabStatus>,
): string {
  if (status.errorCount > 0) {
    return `${status.errorCount} source${status.errorCount === 1 ? "" : "s"} need retry`;
  }
  if (status.loadingCount > 0) {
    return `Loading ${status.readyCount} of ${status.totalCount}`;
  }
  if (status.readyCount === status.totalCount) return "Loaded";
  return "On demand";
}

function sourceStateLabel(
  resource: CampaignAnalyticsResource<unknown>,
): string {
  switch (resource.status) {
    case "ready":
      return "Loaded";
    case "loading":
      return "Loading";
    case "error":
      return "Needs retry";
    case "idle":
      return "On demand";
  }
}

function formatLoadedAt(value: number | null): string {
  if (value === null) return "Not loaded yet";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function CampaignEvidenceScope({
  campaignName,
  cache,
  tab,
  title,
  description,
  status,
  onRetry,
}: {
  campaignName: string;
  cache: CampaignAnalyticsCache;
  tab: CampaignAnalyticsTab;
  title: string;
  description: string;
  status: ReturnType<typeof campaignAnalyticsTabStatus>;
  onRetry: () => void;
}): ReactElement {
  const titleId = useId();
  const state = tabState(status);
  const statusCopy =
    state === "error"
      ? `${status.readyCount} of ${status.totalCount} sources loaded; ${status.errorCount} need${status.errorCount === 1 ? "s" : ""} retry${status.loadingCount > 0 ? `; ${status.loadingCount} still loading` : ""}. Loaded sections remain available.`
      : state === "loading"
        ? `${status.readyCount} of ${status.totalCount} sources loaded; ${status.loadingCount} still loading. You can close this panel safely.`
        : state === "ready"
          ? `All ${status.totalCount} sources are loaded for this section.`
          : "Evidence loads only when this section is opened.";
  return (
    <section className="campaign-evidence-scope" aria-labelledby={titleId}>
      <div className="campaign-evidence-scope-head">
        <div>
          <span className="campaign-evidence-kicker">
            Active evidence scope
          </span>
          <h3 id={titleId}>{title}</h3>
          <p>{description}</p>
        </div>
        <div className="campaign-evidence-snapshot">
          <span>Campaign lifetime</span>
          <strong>{campaignName}</strong>
          <span>Response received · {formatLoadedAt(status.verifiedAt)}</span>
        </div>
      </div>
      <div className="campaign-evidence-status" data-state={state}>
        <div
          className="campaign-evidence-status-message"
          role="status"
          aria-live="polite"
          aria-busy={status.loadingCount > 0 ? "true" : undefined}
        >
          <span className="campaign-evidence-status-mark" aria-hidden="true" />
          <span>{statusCopy}</span>
        </div>
        {status.errorCount > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetry}
            disabled={status.loadingCount > 0}
          >
            {status.loadingCount > 0
              ? "Wait for active reads"
              : "Retry failed sources"}
          </button>
        ) : null}
      </div>
      <ul
        className="campaign-evidence-sources"
        aria-label={`${title} evidence sources`}
      >
        {CAMPAIGN_ANALYTICS_TAB_RESOURCES[tab].map((key) => {
          const resource = untypedResource(cache, key);
          return (
            <li key={key} data-state={resource.status}>
              <span aria-hidden="true" />
              <span>{CAMPAIGN_ANALYTICS_RESOURCE_LABELS[key]}</span>
              <strong>{sourceStateLabel(resource)}</strong>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function renderCampaignTab({
  activeTab,
  cache,
  campaignId,
  campaignName,
  errors,
  states,
  exportBusy,
  exportTriggerRef,
  onReviewExport,
}: {
  activeTab: CampaignAnalyticsTab;
  cache: CampaignAnalyticsCache;
  campaignId: string;
  campaignName: string;
  errors: CampaignSectionErrors;
  states: CampaignSectionStatuses;
  exportBusy: boolean;
  exportTriggerRef: RefObject<HTMLButtonElement | null>;
  onReviewExport: () => void;
}): ReactElement {
  if (activeTab === "audience") {
    return (
      <CampaignBreakdowns
        campaignId={campaignId}
        links={cache.links.data ?? []}
        devices={cache.devices.data ?? []}
        geography={cache.geo.data ?? []}
        locales={cache.locales.data ?? []}
        errors={errors}
        states={states}
      />
    );
  }
  if (activeTab === "delivery") {
    return (
      <CampaignDelivery
        campaignId={campaignId}
        report={cache.report.data}
        bounces={cache.bounces.data}
        errors={errors}
        states={states}
        exportBusy={exportBusy}
        exportTriggerRef={exportTriggerRef}
        onReviewExport={onReviewExport}
      />
    );
  }
  return (
    <CampaignOverview
      campaignId={campaignId}
      campaignName={campaignName}
      report={cache.report.data}
      benchmark={cache.benchmark.data}
      engagement={cache.engagement.data}
      states={states}
      errors={errors}
      anomalies={cache.anomalies.data ?? []}
      timeseries={cache.timeseries.data}
      goal={cache.goal.data}
    />
  );
}

function CampaignRecipientExportDialog({
  open,
  campaignName,
  busy,
  error,
  triggerRef,
  onClose,
  onConfirm,
}: {
  open: boolean;
  campaignName: string;
  busy: boolean;
  error: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}): ReactElement {
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Export recipient-level campaign evidence?"
      description="Review the sensitive fields, campaign scope, and access boundary before a file is created."
      confirmLabel="Download up to 50,000 rows"
      busy={busy}
      returnFocusRef={triggerRef}
    >
      <div className="campaign-recipient-export-review">
        <Notice tone="warning" title="Restricted personal data">
          The CSV identifies subscribers and records their message lifecycle.
          Store it only in an approved location and share it only with people
          authorized for this workspace.
        </Notice>
        <dl>
          <div>
            <dt>Campaign</dt>
            <dd>{campaignName}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>
              Cumulative recipient lifecycle, first bounded page of up to 50,000
              rows, with a 10 MiB desktop transfer limit
            </dd>
          </div>
          <div>
            <dt>Fields</dt>
            <dd>
              Subscriber email; sent, delivered, opened, first-click, bounced,
              complained, and unsubscribed timestamps; click count
            </dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>
              The server rechecks campaign, report, and subscriber-read
              permission at download time. Viewer sessions may read this
              evidence; API keys need all three read scopes.
            </dd>
          </div>
        </dl>
        <p className="campaign-recipient-export-boundary">
          A generated authorization URL remains in memory only long enough to
          complete this transfer. It is never shown or copied into the
          interface.
        </p>
        {error ? (
          <Notice tone="danger" title="Export not created">
            {error}
          </Notice>
        ) : null}
      </div>
    </ConfirmModal>
  );
}

export function CampaignAnalyticsSlideover({
  campaignId,
  campaignName,
  onClose,
}: Props): ReactElement {
  const [tabSelection, setTabSelection] = useState<{
    campaignId: string;
    tab: CampaignAnalyticsTab;
  }>({ campaignId, tab: "overview" });
  const activeTab =
    tabSelection.campaignId === campaignId
      ? tabSelection.tab
      : ("overview" as const);
  const { cache, retryTab } = useCampaignAnalyticsDrilldown(
    campaignId,
    activeTab,
  );
  const [exportReviewOpen, setExportReviewOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const exportGenerationRef = useRef(0);
  const exportFlightRef = useRef<{
    id: symbol;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const initialTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setTabSelection({ campaignId, tab: "overview" });
    setExportReviewOpen(false);
    setExportError(null);
    setExportBusy(false);
    exportGenerationRef.current += 1;
    exportFlightRef.current?.controller.abort();
    exportFlightRef.current = null;
  }, [campaignId]);

  useEffect(
    () => () => {
      exportGenerationRef.current += 1;
      exportFlightRef.current?.controller.abort();
      exportFlightRef.current = null;
    },
    [],
  );

  const tabs = useTabsInteraction<CampaignAnalyticsTab>({
    value: activeTab,
    items: CAMPAIGN_ANALYTICS_TABS.map((tab) => ({ value: tab.id })),
    activation: "manual",
    onChange: (tab) => setTabSelection({ campaignId, tab }),
  });
  const status = campaignAnalyticsTabStatus(cache, activeTab);
  const errors = campaignSectionErrors(cache);
  const states = campaignSectionStatuses(cache);
  const activeDefinition = CAMPAIGN_ANALYTICS_TABS.find(
    (tab) => tab.id === activeTab,
  )!;

  const runRecipientExport = (): Promise<void> => {
    const existing = exportFlightRef.current;
    if (existing) return existing.promise;
    const generation = exportGenerationRef.current;
    const exportCampaignId = campaignId;
    const flightId = Symbol("recipient-export");
    const controller = new AbortController();
    setExportBusy(true);
    setExportError(null);
    const promise = (async (): Promise<void> => {
      try {
        const url = await buildStreamUrl(
          `/api/v1/campaigns/${encodeURIComponent(exportCampaignId)}/report.csv?limit=50000`,
        );
        if (
          exportGenerationRef.current !== generation ||
          campaignId !== exportCampaignId
        ) {
          return;
        }
        const saved = await downloadUrlToFile({
          url,
          suggestedName: `campaign-${exportCampaignId}-recipients.csv`,
          label: `${campaignName} recipient lifecycle report`,
          privacy: "personal",
          mimeType: "text/csv;charset=utf-8",
          maxBytes: 10 * 1024 * 1024,
          signal: controller.signal,
          captureResponseHeaders: [
            "x-postwave-truncated",
            "x-postwave-total-rows",
            "x-postwave-returned-rows",
          ],
          allowExternalFallback: false,
        });
        if (
          exportGenerationRef.current !== generation ||
          campaignId !== exportCampaignId
        ) {
          return;
        }
        if (!saved.ok) {
          if (saved.code !== "cancelled") {
            setExportError(
              "Moosewave could not save this restricted export. Check the connection and try again.",
            );
          }
          return;
        }
        setExportReviewOpen(false);
        toast.success("Recipient lifecycle export saved.");
        if (saved.responseHeaders?.["x-postwave-truncated"] === "true") {
          const returned =
            saved.responseHeaders["x-postwave-returned-rows"] ?? "50,000";
          const total =
            saved.responseHeaders["x-postwave-total-rows"] ?? "more rows";
          toast.info({
            message: `Saved ${returned} of ${total} recipient rows`,
            detail:
              "This download is the API's bounded first page. Use the paginated report API for the remaining rows.",
          });
        }
      } catch {
        if (
          exportGenerationRef.current === generation &&
          campaignId === exportCampaignId
        ) {
          setExportError(
            "Moosewave could not authorize this restricted export. Confirm your report and subscriber access, then try again.",
          );
        }
      } finally {
        if (exportFlightRef.current?.id === flightId) {
          exportFlightRef.current = null;
          setExportBusy(false);
        }
      }
    })();
    exportFlightRef.current = { id: flightId, controller, promise };
    return promise;
  };

  return (
    <>
      <SlideoverShell
        open
        onClose={onClose}
        size="xl"
        eyebrow="Campaign analytics"
        title={campaignName}
        subtitle="Campaign-lifetime evidence, loaded only for the active drill-down."
        initialFocusRef={initialTabRef}
        busy={exportBusy}
        className="campaign-analytics-slideover"
      >
        <div
          ref={tabs.listRef}
          {...tabs.listProps}
          className="campaign-analytics-tabs"
          aria-label="Campaign analytics sections"
        >
          {CAMPAIGN_ANALYTICS_TABS.map((tab, index) => {
            const tabStatus = campaignAnalyticsTabStatus(cache, tab.id);
            return (
              <button
                key={tab.id}
                ref={index === 0 ? initialTabRef : undefined}
                type="button"
                {...tabs.getTabProps(tab.id)}
                className="campaign-analytics-tab"
                data-active={activeTab === tab.id ? "true" : undefined}
              >
                <span className="campaign-analytics-tab-copy">
                  <strong>{tab.label}</strong>
                  <span>{tab.shortDescription}</span>
                </span>
                <span
                  className="campaign-analytics-tab-state"
                  data-state={tabState(tabStatus)}
                  aria-hidden="true"
                >
                  {tabStateCopy(tabStatus)}
                </span>
                <span className="sr-only"> · {tabStateCopy(tabStatus)}</span>
              </button>
            );
          })}
        </div>

        <CampaignEvidenceScope
          campaignName={campaignName}
          cache={cache}
          tab={activeTab}
          title={activeDefinition.label}
          description={activeDefinition.description}
          status={status}
          onRetry={() => retryTab(activeTab)}
        />

        {CAMPAIGN_ANALYTICS_TABS.map((tab) => (
          <section
            key={tab.id}
            {...tabs.getPanelProps(tab.id)}
            className="campaign-analytics-tab-panel"
            aria-busy={
              activeTab === tab.id && status.loadingCount > 0
                ? "true"
                : undefined
            }
          >
            {activeTab === tab.id ? (
              <>
                {cache.report.failure ? (
                  <Notice tone="danger" title="Campaign totals are unavailable">
                    {failureCopy(cache.report.failure)}
                  </Notice>
                ) : null}
                {renderCampaignTab({
                  activeTab,
                  cache,
                  campaignId,
                  campaignName,
                  errors,
                  states,
                  exportBusy,
                  exportTriggerRef,
                  onReviewExport: () => {
                    setExportError(null);
                    setExportReviewOpen(true);
                  },
                })}
              </>
            ) : null}
          </section>
        ))}
      </SlideoverShell>

      <CampaignRecipientExportDialog
        open={exportReviewOpen}
        campaignName={campaignName}
        busy={exportBusy}
        error={exportError}
        triggerRef={exportTriggerRef}
        onClose={() => {
          setExportReviewOpen(false);
          setExportError(null);
        }}
        onConfirm={runRecipientExport}
      />
    </>
  );
}

/** Small inline error for a failed secondary fetch — keeps a server
 *  failure visually distinct from a genuinely-empty section. */
function SectionError({
  what,
  failure,
}: {
  what: string;
  failure: RemoteFailure;
}): ReactElement {
  return (
    <Notice
      tone="danger"
      title={`Couldn't load ${what}`}
      className="campaign-analytics-section-error"
      announcement="polite"
    >
      {failureCopy(failure)}
    </Notice>
  );
}

function EmptyEvidence({
  title,
  detail,
  compact = false,
}: {
  title: string;
  detail: string;
  compact?: boolean;
}): ReactElement {
  return (
    <div
      className="campaign-analytics-empty"
      data-compact={compact ? "true" : undefined}
    >
      <span className="campaign-analytics-empty-mark" aria-hidden="true">
        —
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function LoadingEvidence({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}): ReactElement {
  return (
    <div
      className="campaign-analytics-loading"
      data-compact={compact ? "true" : undefined}
    >
      <span className="campaign-analytics-loading-mark" aria-hidden="true" />
      <span>Loading {label}…</span>
    </div>
  );
}

function displayLinkDestination(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "Unsupported destination";
    }
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${path}${parsed.search ? " · query hidden" : ""}`;
  } catch {
    return "Unrecognized destination";
  }
}

function CampaignBenchmarkPanel({
  benchmark,
}: {
  benchmark: CampaignBenchmarkResponse;
}): ReactElement {
  const canVerdict = campaignBenchmarkCanVerdict(benchmark);
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <h3 className="section-title" style={{ marginBottom: 0 }}>
          Benchmark vs your {benchmark.baseline_days}-day baseline
        </h3>
        <div className="muted" style={{ fontSize: 11 }}>
          {benchmark.baseline_sample_size.toLocaleString()} comparison campaign
          {benchmark.baseline_sample_size === 1 ? "" : "s"} · as of{" "}
          {new Date(benchmark.as_of).toLocaleString()}
        </div>
      </div>
      {!canVerdict ? (
        <Notice tone="warning" title="Baseline verdicts are withheld">
          {benchmark.baseline_unavailable_reason
            ? `Reason: ${benchmark.baseline_unavailable_reason.replaceAll("_", " ")}.`
            : `Fewer than ${benchmark.minimum_sample_size} comparison campaigns are available.`}{" "}
          Rates remain visible as descriptive evidence, not a performance
          verdict.
        </Notice>
      ) : null}
      <div
        className="campaign-analytics-benchmark-scroll"
        role="region"
        aria-label="Campaign benchmark comparison table"
        tabIndex={0}
      >
        <table className="campaign-analytics-benchmark">
          <caption className="sr-only">
            Campaign rates compared with the tenant&apos;s{" "}
            {benchmark.baseline_days}-day baseline
          </caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Value</th>
              <th scope="col">Baseline</th>
              <th scope="col">Change</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {benchmark.metrics.map((metric) => (
              <BenchmarkRow
                key={metric.name}
                m={metric}
                showVerdict={canVerdict}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="campaign-analytics-section-disclosure">
        Baseline window {new Date(benchmark.baseline_from).toLocaleDateString()}
        –{new Date(benchmark.baseline_to).toLocaleDateString()} ·{" "}
        {benchmark.timezone} · selection{" "}
        {benchmark.baseline_selection.replaceAll("_", " ")}.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div className="campaign-analytics-stat">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
      {hint ? <div className="campaign-analytics-stat-hint">{hint}</div> : null}
    </div>
  );
}

function BenchmarkRow({
  m,
  showVerdict,
}: {
  m: BenchmarkMetric;
  showVerdict: boolean;
}): ReactElement {
  const metricHasVerdict = showVerdict && m.available && Boolean(m.verdict);
  const color = !metricHasVerdict
    ? "var(--pw-fg-muted)"
    : m.verdict === "above"
      ? "var(--pw-accent)"
      : m.verdict === "below"
        ? "var(--pw-danger)"
        : "var(--pw-fg-muted)";
  const fmt = (n: number): string => {
    if (m.name.toLowerCase().includes("rate")) {
      // BenchmarkMetric value/baseline are FRACTIONS (campaign_benchmarks.go
      // computes opens/recipients with no ×100) — no unit guessing.
      return `${(n * 100).toFixed(1)}%`;
    }
    return fmtNum(n);
  };
  return (
    <tr>
      <th scope="row">{m.name.replace(/_/g, " ")}</th>
      <td className="tabular">{fmt(m.value)}</td>
      <td className="tabular">{fmt(m.baseline)}</td>
      <td className="tabular" style={{ color }}>
        {m.delta_pct == null
          ? "—"
          : `${m.delta_pct >= 0 ? "+" : ""}${m.delta_pct.toFixed(1)}%`}
      </td>
      <td style={{ color }}>
        {metricHasVerdict
          ? m.verdict === "above"
            ? "above"
            : m.verdict === "below"
              ? "below"
              : "on par"
          : "withheld"}
      </td>
    </tr>
  );
}
