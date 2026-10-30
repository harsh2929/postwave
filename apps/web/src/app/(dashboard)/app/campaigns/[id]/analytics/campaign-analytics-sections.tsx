// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Presentational half of the campaign analytics drill-down. Every section
// takes a `SectionState` and renders exactly one of four outcomes — failed,
// loading, empty, or evidence — so a failed read can never read as "nothing
// happened". Each resource fails on its own: a 500 from the geography query
// costs the reader the geography card and nothing else.

import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Globe2,
  Languages,
  Link2,
  MailWarning,
  Monitor,
  Target,
} from "lucide-react";

import { LineChart } from "@/components/charts/line-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  benchmarkCanVerdict,
  botInflationPoints,
  showsHumanOpenRate,
  type CampaignAnomaly,
  type CampaignBenchmark,
  type CampaignBounceCounts,
  type CampaignDeviceRow,
  type CampaignEngagementPanel,
  type CampaignGeographyRow,
  type CampaignGoalResults,
  type CampaignLinkRow,
  type CampaignLocaleStat,
  type CampaignReport,
  type CampaignTimeseries,
} from "@/lib/campaign-analytics-api";

import {
  displayLinkDestination,
  finiteMagnitude,
  formatBenchmarkValue,
  formatCount,
  formatDeltaPercent,
  formatFractionRate,
  formatGoalWindow,
  formatHourLabel,
  formatInstant,
  formatMinorUnits,
  fractionFromPercent,
  humanizeServerEnum,
} from "./campaign-analytics-format";

/** One resource's outcome, flattened out of its query so the sections stay
 *  free of TanStack types and can be rendered from fixtures in a test. */
export interface SectionState<T> {
  data: T | null;
  loading: boolean;
  /** The SERVER's refusal sentence when the read failed. Never invented. */
  error: string | null;
  retry: () => void;
}

function SectionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display text-sm font-semibold tracking-tight">
            {title}
          </h3>
          {hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The four-outcome renderer. `isEmpty` is the caller's, because "empty" means
 * something different per resource — no bounce events, no link ever clicked,
 * a benchmark with no comparable metrics — and only the caller knows which.
 */
function ResourceBlock<T>({
  label,
  state,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  children,
}: {
  label: string;
  state: SectionState<T>;
  isEmpty: (data: T) => boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon?: typeof BarChart3;
  children: (data: T) => ReactNode;
}) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load {label}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{state.error}</p>
          <Button type="button" variant="outline" size="sm" onClick={state.retry}>
            Retry {label}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (state.loading || state.data === null) {
    return (
      <div role="status" aria-live="polite" className="space-y-2">
        <span className="sr-only">Loading {label}…</span>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isEmpty(state.data)) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  return <>{children(state.data)}</>;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

/** The same tile as `Stat`, in `<dt>`/`<dd>` markup for use inside a `<dl>`
 *  so the label/value pairing is in the semantics, not only the layout. */
function StatDefinition({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      {hint ? (
        <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd>
      ) : null}
    </div>
  );
}

/** A labelled proportional bar. The bar itself is decorative — the number
 *  beside it is the evidence, so the bar is aria-hidden. */
function MagnitudeRow({
  label,
  value,
  maximum,
  trailing,
}: {
  label: string;
  value: number;
  maximum: number;
  trailing: string;
}) {
  const width = maximum > 0 ? (finiteMagnitude(value) / maximum) * 100 : 0;
  return (
    <div className="grid grid-cols-[minmax(6rem,auto)_1fr_auto] items-center gap-3 text-xs">
      <span className="truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <span
        aria-hidden="true"
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="tabular-nums text-muted-foreground">{trailing}</span>
    </div>
  );
}

/* ==========================================================================
 * Overview
 * ======================================================================= */

export function CampaignTotalsSection({
  report,
}: {
  report: SectionState<CampaignReport>;
}) {
  return (
    <ResourceBlock
      label="campaign totals"
      state={report}
      isEmpty={() => false}
      emptyTitle="Campaign totals unavailable"
      emptyDescription="The campaign report returned no cumulative totals."
    >
      {(data) => (
        <dl
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          aria-label="Campaign performance totals"
        >
          <StatDefinition label="Sent" value={formatCount(data.sent)} />
          <StatDefinition
            label="Open rate"
            value={formatFractionRate(fractionFromPercent(data.open_rate))}
            hint={`${formatCount(data.unique_opens)} unique`}
          />
          <StatDefinition
            label="Click rate"
            value={formatFractionRate(fractionFromPercent(data.click_rate))}
            hint={`${formatCount(data.unique_clicks)} unique`}
          />
          <StatDefinition
            label="CTOR"
            value={formatFractionRate(
              fractionFromPercent(data.click_to_open_rate),
            )}
            hint="clicks ÷ opens"
          />
        </dl>
      )}
    </ResourceBlock>
  );
}

export function CampaignBenchmarkSection({
  benchmark,
}: {
  benchmark: SectionState<CampaignBenchmark>;
}) {
  return (
    <SectionCard title="Benchmark vs your own baseline">
      <ResourceBlock
        label="the benchmark"
        state={benchmark}
        isEmpty={(data) => data.metrics.length === 0}
        emptyTitle="No benchmark evidence"
        emptyDescription="The benchmark service returned no comparable metrics for this campaign."
        emptyIcon={BarChart3}
      >
        {(data) => {
          const canVerdict = benchmarkCanVerdict(data);
          return (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {formatCount(data.baseline_sample_size)} comparison campaign
                {data.baseline_sample_size === 1 ? "" : "s"} over{" "}
                {formatCount(data.baseline_days)} days · as of{" "}
                {formatInstant(data.as_of)}
              </p>
              {canVerdict ? null : (
                <Alert>
                  <AlertTitle>Baseline verdicts are withheld</AlertTitle>
                  <AlertDescription>
                    {data.baseline_unavailable_reason
                      ? `Reason: ${humanizeServerEnum(data.baseline_unavailable_reason)}.`
                      : `Fewer than ${formatCount(data.minimum_sample_size)} comparison campaigns are available.`}{" "}
                    The rates below stay visible as descriptive evidence, not
                    as a performance verdict.
                  </AlertDescription>
                </Alert>
              )}
              <TableContainer aria-label="Campaign benchmark comparison">
                <Table>
                  <caption className="sr-only">
                    Campaign rates compared with this workspace&apos;s{" "}
                    {formatCount(data.baseline_days)}-day baseline
                  </caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Metric</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Baseline</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Verdict</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.metrics.map((metric) => {
                      const hasVerdict =
                        canVerdict && metric.available && metric.verdict !== "";
                      return (
                        <TableRow key={metric.name}>
                          {/* The metric names the row, and nothing infers a
                              row header inside <tbody> — so it is declared. */}
                          <TableHead scope="row" className="font-medium">
                            {humanizeServerEnum(metric.name)}
                          </TableHead>
                          <TableCell className="tabular-nums">
                            {formatBenchmarkValue(metric.name, metric.value)}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {formatBenchmarkValue(metric.name, metric.baseline)}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {formatDeltaPercent(metric.delta_pct)}
                          </TableCell>
                          <TableCell>
                            {hasVerdict ? (
                              <Badge
                                variant={
                                  metric.verdict === "above"
                                    ? "success"
                                    : metric.verdict === "below"
                                      ? "destructive"
                                      : "secondary"
                                }
                              >
                                {humanizeServerEnum(metric.verdict)}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                withheld
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              <p className="text-xs text-muted-foreground">
                Baseline window {formatInstant(data.baseline_from)} –{" "}
                {formatInstant(data.baseline_to)} · {data.timezone} · selection{" "}
                {humanizeServerEnum(data.baseline_selection)}.
              </p>
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignEngagementSection({
  engagement,
}: {
  engagement: SectionState<CampaignEngagementPanel>;
}) {
  return (
    <SectionCard title="Trust signals" hint="Counted, not estimated">
      <ResourceBlock
        label="engagement trust signals"
        state={engagement}
        isEmpty={() => false}
        emptyTitle="No engagement signals"
        emptyDescription="The engagement endpoint returned no trust signals for this campaign."
      >
        {(data) => {
          const human = showsHumanOpenRate(data);
          const inflation = botInflationPoints(data);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat
                  label={human ? "Human open rate" : "Open rate"}
                  value={formatFractionRate(
                    human ? data.human_open_rate : data.raw_open_rate,
                  )}
                  hint={
                    human
                      ? `raw ${formatFractionRate(data.raw_open_rate)} · ${inflation.toFixed(1)}pp bot inflation`
                      : "bot filtering is not enabled — this is the raw rate"
                  }
                />
                <Stat
                  label="Reply rate"
                  value={formatFractionRate(data.reply_rate)}
                  hint={`${formatCount(data.distinct_replyers)} replyers / ${formatCount(data.delivered)} delivered`}
                />
                <Stat
                  label="Open-decoupled conversions"
                  value={formatCount(data.open_decoupled_conversions)}
                  hint={
                    data.total_attributed_conversions > 0
                      ? `acted on without a recorded open · ${formatCount(data.open_decoupled_conversions)}/${formatCount(data.total_attributed_conversions)} attributed`
                      : "no attributed conversions yet"
                  }
                />
              </div>
              {data.bot_signatures_applied.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Stripped:
                  </span>
                  {data.bot_signatures_applied.map((signature) => (
                    <Badge key={signature} variant="outline">
                      {signature}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="space-y-1 border-t pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-display text-sm font-semibold tracking-tight">
                    AI-surfacing estimate
                  </h4>
                  <Badge variant="warning">Estimate</Badge>
                </div>
                <p className="font-display text-2xl font-semibold tabular-nums">
                  {formatFractionRate(data.ai_surfacing_score)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Derived from engagement proxies only — not an inbox-provider
                  signal. Sample:{" "}
                  {formatCount(data.ai_surfacing_sample_opens)} opens analysed
                  {data.ai_surfacing_confidence_level === "low"
                    ? " · confidence is low at this sample size"
                    : ""}
                  .
                </p>
                {data.ai_surfacing_basis.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Based on: {data.ai_surfacing_basis.join(", ")}.
                  </p>
                ) : null}
              </div>
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignAnomaliesSection({
  anomalies,
}: {
  anomalies: SectionState<CampaignAnomaly[]>;
}) {
  return (
    <SectionCard title="Anomalies" hint="Hourly z-score outliers">
      <ResourceBlock
        label="the anomaly analysis"
        state={anomalies}
        isEmpty={(data) => data.length === 0}
        emptyTitle="No statistical anomalies detected"
        emptyDescription="No hourly spike or drop crossed the campaign anomaly threshold."
        emptyIcon={AlertTriangle}
      >
        {(data) => (
          <ul className="space-y-2">
            {data.slice(0, 6).map((anomaly) => (
              <li
                key={`${anomaly.metric}-${anomaly.hour}`}
                className="flex flex-wrap items-baseline gap-2 text-sm"
              >
                <Badge
                  variant={
                    anomaly.direction === "drop" ? "destructive" : "warning"
                  }
                >
                  {anomaly.direction}
                </Badge>
                <span className="font-medium">
                  {humanizeServerEnum(anomaly.metric)}
                </span>
                <span className="tabular-nums">
                  {formatCount(anomaly.value)}
                </span>
                <span className="text-muted-foreground">
                  at {formatInstant(anomaly.hour)} (
                  {anomaly.z_score > 0 ? "+" : ""}
                  {anomaly.z_score.toFixed(2)}σ vs mean{" "}
                  {anomaly.mean.toFixed(2)})
                </span>
              </li>
            ))}
          </ul>
        )}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignTimeseriesSection({
  timeseries,
}: {
  timeseries: SectionState<CampaignTimeseries>;
}) {
  return (
    <SectionCard
      title="Engagement over time"
      hint="Hourly opens · clicks · unsubscribes"
    >
      <ResourceBlock
        label="the hourly engagement series"
        state={timeseries}
        isEmpty={(data) => data.buckets.length < 2}
        emptyTitle="Not enough hourly evidence"
        emptyDescription="At least two recorded hourly buckets are needed before a trend can be drawn."
        emptyIcon={BarChart3}
      >
        {(data) => {
          const labels = data.buckets.map((bucket) =>
            formatHourLabel(bucket.hour),
          );
          const series = [
            {
              key: "opens" as const,
              label: "Opens",
              values: data.buckets.map((bucket) => bucket.opens),
              colorVar: "--chart-1",
            },
            {
              key: "clicks" as const,
              label: "Clicks",
              values: data.buckets.map((bucket) => bucket.clicks),
              colorVar: "--chart-2",
            },
            {
              key: "unsubs" as const,
              label: "Unsubscribes",
              values: data.buckets.map((bucket) => bucket.unsubs),
              colorVar: "--chart-3",
            },
          ];
          return (
            <div className="space-y-4">
              {data.truncated ? (
                <p className="text-xs text-muted-foreground">
                  This series is truncated to the most recent 30 days of hourly
                  buckets.
                </p>
              ) : null}
              {series.map((line) => (
                <div key={line.key} className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {line.label} ·{" "}
                    {formatCount(
                      line.values.reduce((sum, value) => sum + value, 0),
                    )}
                  </h4>
                  <LineChart
                    values={line.values}
                    labels={labels}
                    colorVar={line.colorVar}
                    height={120}
                    ariaLabel={`${line.label} per hour for this campaign`}
                  />
                </div>
              ))}
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignGoalSection({
  goal,
}: {
  goal: SectionState<CampaignGoalResults>;
}) {
  return (
    <SectionCard title="Conversion goal">
      <ResourceBlock
        label="the conversion goal"
        state={goal}
        isEmpty={(data) => !data.configured}
        emptyTitle="No conversion goal configured"
        emptyDescription="This campaign has no goal event and attribution window to evaluate."
        emptyIcon={Target}
      >
        {(data) => (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {data.goal_event} · within{" "}
              {formatGoalWindow(data.goal_window_hours)}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label="Conversion events"
                value={formatCount(data.conversion_count)}
                hint="Repeat and attributed anonymous events are included"
              />
              <Stat
                label="Recipient conversion rate"
                value={formatFractionRate(data.conversion_rate)}
                hint={`${formatCount(data.converted_recipients)} identified converters / ${formatCount(data.recipients)} sent recipients`}
              />
              <Stat
                label="Goal revenue"
                value={
                  data.currency === ""
                    ? "Unavailable"
                    : formatMinorUnits(
                        data.attributed_revenue_cents,
                        data.currency,
                      )
                }
                hint={
                  data.revenue_status === "mixed_currency"
                    ? "Multiple currencies were recorded; they are not combined into a misleading total."
                    : data.revenue_status === "missing_currency"
                      ? "Some monetary conversions have no currency; revenue is withheld until the source is corrected."
                      : data.currency === ""
                        ? "No currency-qualified monetary conversion was recorded in this window."
                        : `attributed within ${formatGoalWindow(data.goal_window_hours)}`
                }
              />
            </div>
          </div>
        )}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignFunnelSection({
  report,
}: {
  report: SectionState<CampaignReport>;
}) {
  return (
    <SectionCard
      title="Funnel"
      hint="Sent → delivered → opened → clicked"
    >
      <ResourceBlock
        label="the funnel"
        state={report}
        isEmpty={(data) => finiteMagnitude(data.sent) === 0}
        emptyTitle="Nothing has been sent yet"
        emptyDescription="A funnel needs at least one recorded send to have a first step."
      >
        {(data) => {
          const rows = [
            { label: "Sent", value: finiteMagnitude(data.sent) },
            { label: "Delivered", value: finiteMagnitude(data.delivered) },
            { label: "Opened", value: finiteMagnitude(data.unique_opens) },
            { label: "Clicked", value: finiteMagnitude(data.unique_clicks) },
          ];
          const top = rows[0]?.value ?? 0;
          return (
            <div className="space-y-2">
              {rows.map((row) => (
                <MagnitudeRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  maximum={top}
                  trailing={`${formatCount(row.value)} · ${formatFractionRate(
                    top > 0 ? row.value / top : 0,
                  )}`}
                />
              ))}
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

/* ==========================================================================
 * Audience & links
 * ======================================================================= */

export function CampaignLinksSection({
  links,
}: {
  links: SectionState<CampaignLinkRow[]>;
}) {
  return (
    <SectionCard title="Top links">
      <ResourceBlock
        label="the link report"
        state={links}
        isEmpty={(data) => data.length === 0}
        emptyTitle="No link activity recorded"
        emptyDescription="No tracked destination received a click for this campaign."
        emptyIcon={Link2}
      >
        {(data) => {
          const sorted = data
            .slice()
            .sort(
              (left, right) =>
                finiteMagnitude(right.clicks) - finiteMagnitude(left.clicks) ||
                left.url.localeCompare(right.url),
            );
          const top = finiteMagnitude(sorted[0]?.clicks ?? 0);
          return (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                A person who clicked more than one link appears in more than one
                per-link unique count. These are not campaign-level uniques.
              </p>
              <div className="space-y-2">
                {sorted.slice(0, 8).map((link) => (
                  <MagnitudeRow
                    key={link.url}
                    label={displayLinkDestination(link.url)}
                    value={link.clicks}
                    maximum={top}
                    trailing={`${formatCount(link.clicks)} clicks · ${formatCount(link.unique_clickers)} unique · ${formatFractionRate(link.ctr)} CTR`}
                  />
                ))}
              </div>
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignDevicesSection({
  devices,
}: {
  devices: SectionState<CampaignDeviceRow[]>;
}) {
  return (
    <SectionCard
      title="Mail clients"
      hint="Inferred from open-beacon user agents"
    >
      <ResourceBlock
        label="the mail-client mix"
        state={devices}
        isEmpty={(data) => data.length === 0}
        emptyTitle="No mail-client signals"
        emptyDescription="No open-beacon client evidence was returned for this campaign."
        emptyIcon={Monitor}
      >
        {(data) => {
          const sorted = data
            .slice()
            .sort(
              (left, right) =>
                finiteMagnitude(right.opens) - finiteMagnitude(left.opens) ||
                left.client.localeCompare(right.client),
            );
          const top = finiteMagnitude(sorted[0]?.opens ?? 0);
          return (
            <div className="space-y-2">
              {sorted.slice(0, 6).map((row) => (
                <MagnitudeRow
                  key={row.client || "unknown"}
                  label={row.client || "Unknown"}
                  value={row.opens}
                  maximum={top}
                  trailing={`${formatCount(row.opens)} opens`}
                />
              ))}
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignGeographySection({
  geography,
}: {
  geography: SectionState<CampaignGeographyRow[]>;
}) {
  return (
    <SectionCard
      title="Top countries"
      hint="Derived from the IP recorded with each open"
    >
      <ResourceBlock
        label="the geography report"
        state={geography}
        isEmpty={(data) => data.length === 0}
        emptyTitle="No geography signals"
        emptyDescription="No country-level open or click evidence was returned."
        emptyIcon={Globe2}
      >
        {(data) => {
          const sorted = data
            .slice()
            .sort(
              (left, right) =>
                finiteMagnitude(right.opens) - finiteMagnitude(left.opens) ||
                left.country.localeCompare(right.country),
            );
          const top = finiteMagnitude(sorted[0]?.opens ?? 0);
          return (
            <div className="space-y-2">
              {sorted.slice(0, 6).map((row) => (
                <MagnitudeRow
                  key={row.country || "unknown"}
                  label={row.country || "Unknown"}
                  value={row.opens}
                  maximum={top}
                  trailing={`${formatCount(row.opens)} opens · ${formatCount(row.clicks)} clicks`}
                />
              ))}
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

export function CampaignLocalesSection({
  locales,
}: {
  locales: SectionState<CampaignLocaleStat[]>;
}) {
  return (
    <SectionCard
      title="Recipient languages"
      hint="Recorded locale groups · lifetime engagement"
    >
      <ResourceBlock
        label="the recipient-language report"
        state={locales}
        isEmpty={(data) => data.length === 0}
        emptyTitle="No recipient-language evidence"
        emptyDescription="No locale groups were returned for this campaign."
        emptyIcon={Languages}
      >
        {(data) => {
          const sorted = data
            .slice()
            .sort(
              (left, right) =>
                finiteMagnitude(right.sent) - finiteMagnitude(left.sent) ||
                left.locale.localeCompare(right.locale),
            );
          return (
            <ul className="space-y-2">
              {sorted.map((row) => {
                const sent = finiteMagnitude(row.sent);
                return (
                  <li
                    key={row.locale || "unspecified"}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <Badge variant="outline">
                      {row.locale || "Unspecified"}
                    </Badge>
                    <span className="text-muted-foreground">
                      {formatCount(row.sent)} sent · {formatCount(row.opens)}{" "}
                      opens · {formatCount(row.clicks)} clicks
                    </span>
                    <span className="tabular-nums">
                      {formatFractionRate(sent > 0 ? row.opens / sent : 0)} open
                      rate
                    </span>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}

/* ==========================================================================
 * Delivery
 * ======================================================================= */

export function CampaignDeliveryTotalsSection({
  report,
}: {
  report: SectionState<CampaignReport>;
}) {
  return (
    <ResourceBlock
      label="delivery totals"
      state={report}
      isEmpty={() => false}
      emptyTitle="Delivery totals unavailable"
      emptyDescription="The campaign report returned no cumulative delivery totals."
    >
      {(data) => {
        const sent = finiteMagnitude(data.sent);
        const delivered = finiteMagnitude(data.delivered);
        return (
          <dl
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            aria-label="Campaign delivery totals"
          >
            <StatDefinition
              label="Delivered"
              value={formatCount(data.delivered)}
              hint={`${formatFractionRate(sent > 0 ? delivered / sent : 0)} of sent`}
            />
            <StatDefinition
              label="Bounce rate"
              value={formatFractionRate(fractionFromPercent(data.bounce_rate))}
              hint={`${formatCount(data.bounces)} recorded`}
            />
            <StatDefinition
              label="Complaints"
              value={formatCount(data.complaints)}
              hint={`${formatFractionRate(
                delivered > 0 ? data.complaints / delivered : 0,
              )} of delivered`}
            />
            <StatDefinition
              label="Unsubscribe rate"
              value={formatFractionRate(fractionFromPercent(data.unsub_rate))}
              hint={`${formatCount(data.unsubscribes)} recorded`}
            />
          </dl>
        );
      }}
    </ResourceBlock>
  );
}

export function CampaignBounceMixSection({
  bounces,
}: {
  bounces: SectionState<CampaignBounceCounts>;
}) {
  return (
    <SectionCard title="Bounce mix">
      <ResourceBlock
        label="the bounce classification"
        state={bounces}
        isEmpty={(data) => finiteMagnitude(data.total) === 0}
        emptyTitle="No recorded bounces"
        emptyDescription="No hard, soft, or spam-trap bounce events were returned."
        emptyIcon={MailWarning}
      >
        {(data) => {
          const rows = [
            { label: "Hard", value: finiteMagnitude(data.hard) },
            { label: "Soft", value: finiteMagnitude(data.soft) },
            { label: "Spam trap", value: finiteMagnitude(data.spam_trap) },
          ];
          const total = finiteMagnitude(data.total);
          return (
            <div className="space-y-2">
              {rows.map((row) => (
                <MagnitudeRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  maximum={total}
                  trailing={`${formatCount(row.value)} · ${formatFractionRate(
                    total > 0 ? row.value / total : 0,
                  )}`}
                />
              ))}
              <p className="text-xs text-muted-foreground">
                {formatCount(data.total)} bounce events classified.
              </p>
            </div>
          );
        }}
      </ResourceBlock>
    </SectionCard>
  );
}
