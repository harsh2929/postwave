// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// The Analytics page's campaign-derived panels (desktop
// AnalyticsCampaignPanels / AnalyticsAudiencePanels / AnalyticsHealthPanels):
//
//   * CampaignPerformancePanel   opens + clicks for the five most recent
//                                campaigns, each a link into that campaign's
//                                analytics drill-down, and the latest
//                                campaign's benchmark verdicts — or an
//                                explicit "withheld" when the baseline is too
//                                thin to judge against.
//   * RecentCampaignAudiencePanels  mail-client open mix, top countries, and
//                                top links (each destination openable), summed
//                                across the same five campaigns.
//   * RecentBounceMixPanel       hard / soft / spam-trap bounces across them.
//
// Each panel renders exactly one of: the server's refusal sentence with a
// Retry, a loading skeleton, an honest empty state, or evidence. A failed
// read is never drawn as zero, and a total is never drawn from a subset of
// the campaigns it claims to cover.

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRate } from "@/lib/analytics-format";
import {
  benchmarkVerdictMetrics,
  buildBounceSlices,
  buildCampaignChartEvidence,
  buildMailClientSlices,
  openableLinkUrl,
  type DonutSlice,
} from "@/lib/analytics-recent-campaigns";
import {
  benchmarkCanVerdict,
  type CampaignBenchmark,
} from "@/lib/campaign-analytics-api";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

import { ChartActions } from "./chart-actions";
import {
  useRecentCampaignAnalytics,
  type RecentCampaignScope,
  type ResourceOutcome,
} from "./use-recent-campaign-analytics";
import { useAnalyticsView, useScrollToTarget } from "./use-analytics-view";

export const CAMPAIGN_PERFORMANCE_CHART_ID = "campaign-performance";

const SLICE_COLORS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
];

function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** The drill-down route the campaign-analytics sibling built. */
export function campaignAnalyticsHref(campaignId: string): string {
  return `/app/campaigns/${encodeURIComponent(campaignId)}/analytics`;
}

/* -------------------------------------------------------------------------
 * Shared states
 * ---------------------------------------------------------------------- */

/** The server's sentence + Retry. `what` names the thing that failed. */
function FailedRead({
  what,
  outcome,
}: {
  what: string;
  outcome: Pick<ResourceOutcome, "error" | "retry">;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm sm:flex-row sm:items-center"
    >
      <span>
        <span className="font-medium">{what} couldn&apos;t be loaded.</span>{" "}
        <span className="text-destructive">{outcome.error}</span>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={outcome.retry}>
        Retry
      </Button>
    </div>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}

function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The list read gates everything: until it resolves there is no set of
 * campaigns to compute over, and if it fails there is nothing to say but the
 * server's sentence.
 */
function ListGate({
  list,
  children,
}: {
  list: ResourceOutcome;
  children: ReactNode;
}) {
  if (list.error) return <FailedRead what="Recent campaigns" outcome={list} />;
  if (list.loading) return <PanelSkeleton />;
  return <>{children}</>;
}

/* -------------------------------------------------------------------------
 * Donut (desktop charts/Donut) — the legend is the accessible data
 * ---------------------------------------------------------------------- */

function Donut({
  slices,
  centerLabel,
  title,
}: {
  slices: DonutSlice[];
  centerLabel: string;
  title: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let offset = 0;
  const arcs = slices.map((slice, index) => {
    const share = total > 0 ? (slice.value / total) * 100 : 0;
    const arc = {
      slice,
      share,
      offset,
      color: SLICE_COLORS[index % SLICE_COLORS.length] ?? "--chart-1",
    };
    offset += share;
    return arc;
  });
  return (
    <figure className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="relative h-32 w-32 shrink-0">
        <svg
          viewBox="0 0 36 36"
          className="h-full w-full -rotate-90"
          aria-hidden
        >
          <circle
            cx="18"
            cy="18"
            r="15.9155"
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth="4"
          />
          {arcs.map((arc) =>
            arc.share > 0 ? (
              <circle
                key={arc.slice.label}
                cx="18"
                cy="18"
                r="15.9155"
                fill="none"
                stroke={`hsl(var(${arc.color}))`}
                strokeWidth="4"
                strokeDasharray={`${arc.share} ${100 - arc.share}`}
                strokeDashoffset={-arc.offset}
              />
            ) : null,
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums">
            {count(total)}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {centerLabel}
          </span>
        </div>
      </div>
      <figcaption className="w-full min-w-0 space-y-1">
        <span className="sr-only">{title}</span>
        <ul className="space-y-1 text-sm" aria-label={title}>
          {arcs.map((arc) => (
            <li
              key={arc.slice.label}
              data-testid="donut-slice"
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: `hsl(var(${arc.color}))` }}
                />
                <span className="truncate">{arc.slice.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {count(arc.slice.value)} ·{" "}
                {formatRate(total > 0 ? arc.slice.value / total : null)}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** A ranked row with a proportional bar (decorative; the numbers are text). */
function RankedBar({
  label,
  value,
  maximum,
  trailing,
}: {
  label: ReactNode;
  value: number;
  maximum: number;
  trailing: string;
}) {
  const width = maximum > 0 ? Math.min(100, (value / maximum) * 100) : 0;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {trailing}
      </span>
      <span
        aria-hidden
        className="col-span-2 block h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full rounded-full bg-primary/80"
          style={{ width: `${width}%` }}
        />
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------
 * Campaign performance (analytics-46)
 * ---------------------------------------------------------------------- */

const VERDICT_COPY: Record<string, string> = {
  above: "above baseline",
  below: "below baseline",
  on_par: "on par",
};

function BenchmarkStrip({
  benchmark,
  outcome,
  latestName,
}: {
  benchmark: CampaignBenchmark | null;
  outcome: ResourceOutcome;
  latestName: string;
}) {
  if (outcome.error) {
    return (
      <FailedRead what="The latest campaign's benchmark" outcome={outcome} />
    );
  }
  if (outcome.loading) return <Skeleton className="h-6 w-2/3" />;
  if (!benchmark) return null;
  const sample = benchmark.baseline_sample_size;
  const minimum = benchmark.minimum_sample_size;
  if (!benchmarkCanVerdict(benchmark)) {
    return (
      <p
        role="status"
        data-testid="benchmark-withheld"
        className="text-xs text-muted-foreground"
      >
        Benchmark withheld · {count(sample)}/{count(minimum)} required prior
        campaigns. Add more comparable sends before treating a relative verdict
        as evidence.
        {benchmark.baseline_unavailable_reason
          ? ` (${benchmark.baseline_unavailable_reason.replaceAll("_", " ")})`
          : ""}
      </p>
    );
  }
  const metrics = benchmarkVerdictMetrics(benchmark);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Latest campaign, <span className="text-foreground">{latestName}</span>,
        against its {count(benchmark.baseline_days)}-day baseline of{" "}
        {count(sample)} prior {plural(sample, "campaign")}:
      </p>
      {metrics.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The benchmark returned no metric with a verdict.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {metrics.map((metric) => (
            <li
              key={metric.name}
              data-testid="benchmark-verdict"
              className="inline-flex items-center gap-1.5"
            >
              <span>{metric.name.replaceAll("_", " ")}</span>
              <Badge
                variant={
                  metric.verdict === "above"
                    ? "success"
                    : metric.verdict === "below"
                      ? "destructive"
                      : "secondary"
                }
              >
                {VERDICT_COPY[metric.verdict] ??
                  metric.verdict.replaceAll("_", " ")}
              </Badge>
              <span className="tabular-nums text-muted-foreground">
                {metric.delta_pct === null
                  ? "(baseline is zero)"
                  : `(${metric.delta_pct >= 0 ? "+" : ""}${metric.delta_pct.toFixed(1)}%)`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CampaignPerformancePanel(scope: RecentCampaignScope) {
  const data = useRecentCampaignAnalytics(scope, {
    reports: true,
    benchmark: true,
  });
  const { view } = useAnalyticsView();
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = view.focus === CAMPAIGN_PERFORMANCE_CHART_ID;
  useScrollToTarget(focused, cardRef);

  const evidence = buildCampaignChartEvidence(data.campaigns, data.reports);
  const maximum = Math.max(
    0,
    ...evidence.rows.flatMap((row) => [row.opens, row.clicks]),
  );
  const latest = data.campaigns[0];

  return (
    <Card
      ref={cardRef}
      data-analytics-focus={CAMPAIGN_PERFORMANCE_CHART_ID}
      data-focused={focused || undefined}
      className={cn(focused && "ring-2 ring-primary/60")}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>Campaign performance</CardTitle>
            <CardDescription>
              {data.campaigns.length > 0
                ? `Unique opens and clicks for your ${data.campaigns.length} most recent ${plural(data.campaigns.length, "campaign")}, across all time. Pick one for its full analytics.`
                : "Unique opens and clicks for your most recent campaigns, across all time. Pick one for its full analytics."}
            </CardDescription>
          </div>
          <ChartActions
            chartId={CAMPAIGN_PERFORMANCE_CHART_ID}
            chartName="Campaign performance"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ListGate list={data.list}>
          {data.campaigns.length === 0 ? (
            <PanelEmpty>No campaigns yet.</PanelEmpty>
          ) : (
            <>
              {data.reportsOutcome.error ? (
                <FailedRead
                  what={`${data.reportsOutcome.failed} of ${data.campaigns.length} campaign ${plural(data.campaigns.length, "report")}`}
                  outcome={data.reportsOutcome}
                />
              ) : null}
              {data.reportsOutcome.loading && evidence.rows.length === 0 ? (
                <PanelSkeleton rows={data.campaigns.length} />
              ) : evidence.rows.length > 0 && !evidence.hasData ? (
                <PanelEmpty>
                  None of your recent campaigns has recorded a send, open or
                  click yet.
                </PanelEmpty>
              ) : evidence.rows.length > 0 ? (
                <ul
                  className="space-y-3"
                  aria-label="Recent campaign opens and clicks"
                >
                  {evidence.rows.map((row) => (
                    <li
                      key={row.id}
                      data-testid="campaign-performance-row"
                      className="space-y-1"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                        <Link
                          href={asRoute(campaignAnalyticsHref(row.id))}
                          aria-label={`Open analytics for ${row.name}`}
                          className="min-w-0 max-w-full truncate font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {row.name} →
                        </Link>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {count(row.opens)} {plural(row.opens, "open")} ·{" "}
                          {count(row.clicks)} {plural(row.clicks, "click")}
                        </span>
                      </div>
                      <div aria-hidden className="space-y-0.5">
                        <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${maximum > 0 ? (row.opens / maximum) * 100 : 0}%`,
                              background: "hsl(var(--chart-1))",
                            }}
                          />
                        </span>
                        <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${maximum > 0 ? (row.clicks / maximum) * 100 : 0}%`,
                              background: "hsl(var(--chart-2))",
                            }}
                          />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {evidence.missingReports > 0 &&
              !data.reportsOutcome.loading &&
              !data.reportsOutcome.error ? (
                <p className="text-xs text-muted-foreground">
                  {evidence.missingReports} recent{" "}
                  {plural(evidence.missingReports, "campaign")} returned no
                  report.
                </p>
              ) : null}
              <div className="border-t pt-3">
                <BenchmarkStrip
                  benchmark={data.benchmark}
                  outcome={data.benchmarkOutcome}
                  latestName={latest?.name ?? "Untitled"}
                />
              </div>
            </>
          )}
        </ListGate>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * Audience panels (analytics-50)
 * ---------------------------------------------------------------------- */

function scopeLine(campaigns: number): string {
  return `Across your ${campaigns} most recent ${plural(campaigns, "campaign")}`;
}

export function RecentCampaignAudiencePanels(scope: RecentCampaignScope) {
  const data = useRecentCampaignAnalytics(scope, { audience: true });
  const n = data.campaigns.length;
  const noCampaigns = !data.list.loading && !data.list.error && n === 0;
  const slices = data.devices ? buildMailClientSlices(data.devices) : [];
  const countries = Array.isArray(data.geography) ? data.geography : [];
  const topCountries = countries.slice(0, 7);
  const links = Array.isArray(data.links) ? data.links : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Mail clients</CardTitle>
            <CardDescription>
              {scopeLine(n)} · inferred from the user agent on each open beacon.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ListGate list={data.list}>
              {noCampaigns ? (
                <PanelEmpty>No campaigns yet.</PanelEmpty>
              ) : data.devicesOutcome.error ? (
                <FailedRead
                  what="The mail-client mix"
                  outcome={data.devicesOutcome}
                />
              ) : data.devicesOutcome.loading || !data.devices ? (
                <PanelSkeleton rows={3} />
              ) : slices.some((slice) => slice.value > 0) ? (
                <Donut
                  slices={slices}
                  centerLabel="opens"
                  title="Mail-client open mix"
                />
              ) : (
                <PanelEmpty>No mail-client signals captured yet.</PanelEmpty>
              )}
            </ListGate>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top countries</CardTitle>
            <CardDescription>
              By opens · {scopeLine(n).toLowerCase()} · from the IP address on
              each open event.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ListGate list={data.list}>
              {noCampaigns ? (
                <PanelEmpty>No campaigns yet.</PanelEmpty>
              ) : data.geographyOutcome.error ? (
                <FailedRead
                  what="The country breakdown"
                  outcome={data.geographyOutcome}
                />
              ) : data.geographyOutcome.loading || !data.geography ? (
                <PanelSkeleton rows={3} />
              ) : topCountries.length > 0 ? (
                <>
                  <ul className="space-y-2" aria-label="Top countries by opens">
                    {topCountries.map((row) => (
                      <RankedBar
                        key={row.country}
                        label={row.country}
                        value={row.opens}
                        maximum={topCountries[0]?.opens ?? 0}
                        trailing={`${count(row.opens)} ${plural(row.opens, "open")} · ${count(row.clicks)} ${plural(row.clicks, "click")}`}
                      />
                    ))}
                  </ul>
                  {countries.length > topCountries.length ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Showing the top {topCountries.length} of{" "}
                      {countries.length} countries.
                    </p>
                  ) : null}
                </>
              ) : (
                <PanelEmpty>No country signals captured yet.</PanelEmpty>
              )}
            </ListGate>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top links</CardTitle>
          <CardDescription>
            The most-clicked destinations {scopeLine(n).toLowerCase()}. The
            second figure sums each campaign&apos;s own unique clickers, so one
            person who clicked the same link in two campaigns counts twice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListGate list={data.list}>
            {noCampaigns ? (
              <PanelEmpty>No campaigns yet.</PanelEmpty>
            ) : data.linksOutcome.error ? (
              <FailedRead what="The link report" outcome={data.linksOutcome} />
            ) : data.linksOutcome.loading || !data.links ? (
              <PanelSkeleton rows={3} />
            ) : links.length > 0 ? (
              <ul className="space-y-2" aria-label="Top links by clicks">
                {links.map((link) => {
                  const href = openableLinkUrl(link.url);
                  return (
                    <RankedBar
                      key={link.url}
                      value={link.clicks}
                      maximum={links[0]?.clicks ?? 0}
                      trailing={`${count(link.clicks)} ${plural(link.clicks, "click")} · ${count(link.unique_clickers)} campaign-unique`}
                      label={
                        href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={link.url}
                            data-testid="top-link"
                            className="inline-flex max-w-full items-center gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="truncate">{link.url}</span>
                            <ExternalLink
                              className="h-3 w-3 shrink-0"
                              aria-hidden
                            />
                            <span className="sr-only">
                              (opens in a new tab)
                            </span>
                          </a>
                        ) : (
                          <span title={link.url} data-testid="top-link-inert">
                            {link.url}
                          </span>
                        )
                      }
                    />
                  );
                })}
              </ul>
            ) : (
              <PanelEmpty>
                No tracked link destinations were returned.
              </PanelEmpty>
            )}
          </ListGate>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Bounce-type mix (analytics-51)
 * ---------------------------------------------------------------------- */

export function RecentBounceMixPanel(scope: RecentCampaignScope) {
  const data = useRecentCampaignAnalytics(scope, { bounces: true });
  const n = data.campaigns.length;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Bounce types</CardTitle>
        <CardDescription>
          {scopeLine(n)}, all time — not limited to the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ListGate list={data.list}>
          {n === 0 ? (
            <PanelEmpty>No campaigns yet.</PanelEmpty>
          ) : data.bouncesOutcome.error ? (
            <FailedRead
              what="The bounce breakdown"
              outcome={data.bouncesOutcome}
            />
          ) : data.bouncesOutcome.loading || !data.bounces ? (
            <PanelSkeleton rows={3} />
          ) : data.bounces.total > 0 ? (
            <div className="space-y-3">
              <Donut
                slices={buildBounceSlices(data.bounces)}
                centerLabel="bounces"
                title="Bounce-type mix"
              />
              {data.bounces.total >
              data.bounces.hard + data.bounces.soft + data.bounces.spam_trap ? (
                <p className="text-xs text-muted-foreground">
                  {count(
                    data.bounces.total -
                      data.bounces.hard -
                      data.bounces.soft -
                      data.bounces.spam_trap,
                  )}{" "}
                  of {count(data.bounces.total)} bounces carry no type.
                </p>
              ) : null}
            </div>
          ) : (
            <PanelEmpty>
              No bounce-type records were returned for these campaigns.
            </PanelEmpty>
          )}
        </ListGate>
      </CardContent>
    </Card>
  );
}
