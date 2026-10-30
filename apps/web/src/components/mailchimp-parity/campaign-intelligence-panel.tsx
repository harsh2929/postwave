// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { LineChart } from "@/components/charts/line-chart";
import {
  cancelDelivery,
  getCampaignInbox,
  getCampaignPlanner,
  getClickMap,
  getCustomReport,
  getDeliveryInsights,
  getMultivariateTest,
  getSendDayOptimization,
  getSendTimeOptimization,
  CUSTOM_REPORT_DEFAULT_METRICS,
  CUSTOM_REPORT_DEFAULT_GROUP_BY,
  type CampaignInboxResponse,
  type CampaignPlannerResponse,
  type ClickMapResponse,
  type CustomReportResponse,
  type DeliveryInsightsResponse,
  type MultivariateTestResponse,
  type OptimizationResponse,
} from "@/lib/mailchimp-compat-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, STALE } from "@/lib/query-keys";
import { downloadTextFile } from "@/lib/download";
import {
  formatMetricValue,
  humanizeMetricKey,
  toCsv,
} from "@/lib/analytics-format";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

import {
  DateStamp,
  entries,
  MetricBox,
  metric,
  PanelEmpty,
  PanelError,
  PanelGridSkeleton,
  pct,
  statusVariant,
} from "./product-panel-primitives";

export const CAMPAIGN_PANEL_LIMITS = {
  tasks: 5,
  touchpoints: 6,
  links: 4,
  reportRows: 12,
} as const;

export function previewItems<T>(
  items: readonly T[] | undefined,
  limit: number,
): T[] {
  return (Array.isArray(items) ? items : []).slice(0, limit);
}

/**
 * Detect and strip a "(sample)" suffix on seeded demo rows so they can be
 * visibly framed as sample data instead of masquerading as real (CAMP-054).
 */
export function frameSample(text: string): { text: string; sample: boolean } {
  const sample = /\(sample\)/i.test(text);
  return {
    text: sample ? text.replace(/\s*\(sample\)/i, "").trim() : text,
    sample,
  };
}

function SampleBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 text-[10px] uppercase tracking-wide"
    >
      Sample
    </Badge>
  );
}

export function CampaignIntelligencePanel({
  campaignId,
  className = "",
}: {
  campaignId?: string;
  className?: string;
}) {
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.viewer_mode
    ? "viewer"
    : me.data
      ? effectiveAuthRole(me.data)
      : null;
  const canWrite = canWriteCampaigns(me.data);

  // Custom-report builder state (ANL-033). The report re-fetches whenever the
  // chosen metrics/group_by change because they're part of the query key.
  const [reportMetrics, setReportMetrics] = useState<string[]>(
    CUSTOM_REPORT_DEFAULT_METRICS,
  );
  const [reportGroupBy, setReportGroupBy] = useState<string>(
    CUSTOM_REPORT_DEFAULT_GROUP_BY,
  );

  const plannerQuery = useQuery({
    queryKey: [...base("campaign-planner", tenantId, role)],
    queryFn: getCampaignPlanner,
    enabled: me.isFetched,
    staleTime: STALE.dashboard,
  });

  const reportQuery = useQuery({
    queryKey: [
      ...base("custom-report", tenantId, role),
      reportGroupBy,
      reportMetrics.join(","),
    ],
    queryFn: () =>
      getCustomReport({ metrics: reportMetrics, group_by: reportGroupBy }),
    enabled: me.isFetched,
    staleTime: STALE.dashboard,
    // Keep the previous report on screen while a new metric selection loads so
    // the card doesn't flash empty on every toggle.
    placeholderData: (prev) => prev,
  });

  const campaignQuery = useQuery({
    queryKey: [...base("campaign-intel", tenantId, role), campaignId ?? ""],
    enabled: me.isFetched && !!campaignId,
    staleTime: STALE.dashboard,
    queryFn: async (): Promise<{
      multivariate: MultivariateTestResponse;
      sendTime: OptimizationResponse;
      sendDay: OptimizationResponse;
      clickMap: ClickMapResponse;
      delivery: DeliveryInsightsResponse;
      inbox: CampaignInboxResponse;
    }> => {
      const [multivariate, sendTime, sendDay, clickMap, delivery, inbox] =
        await Promise.all([
          getMultivariateTest(campaignId!),
          getSendTimeOptimization(campaignId!),
          getSendDayOptimization(campaignId!),
          getClickMap(campaignId!),
          getDeliveryInsights(campaignId!),
          getCampaignInbox(campaignId!),
        ]);
      return { multivariate, sendTime, sendDay, clickMap, delivery, inbox };
    },
  });

  const planner: CampaignPlannerResponse | null = plannerQuery.data ?? null;
  const report: CustomReportResponse | null = reportQuery.data ?? null;
  const multivariate = campaignQuery.data?.multivariate ?? null;
  const sendTime = campaignQuery.data?.sendTime ?? null;
  const sendDay = campaignQuery.data?.sendDay ?? null;
  const clickMap = campaignQuery.data?.clickMap ?? null;
  const delivery = campaignQuery.data?.delivery ?? null;
  const inbox = campaignQuery.data?.inbox ?? null;

  const primaryLoading = plannerQuery.isPending || reportQuery.isPending;
  // A settled-but-failed query leaves its data undefined, which the cards below
  // would otherwise render as a confident "nothing scheduled yet". Track the
  // failures per card so a failed read never reads as an empty workspace.
  // Stale data from an earlier success still wins — those rows are real.
  const plannerFailed = plannerQuery.isError && !planner;
  const errorQuery = [plannerQuery, reportQuery, campaignQuery].find(
    (q) => q.isError,
  );
  const error =
    errorQuery?.error instanceof Error
      ? errorQuery.error.message
      : errorQuery
        ? "Could not load campaign intelligence."
        : null;

  function refetchAll() {
    void plannerQuery.refetch();
    void reportQuery.refetch();
    if (campaignId) void campaignQuery.refetch();
  }

  const visibleTasks = previewItems(
    planner?.tasks,
    CAMPAIGN_PANEL_LIMITS.tasks,
  );
  const visibleTouchpoints = previewItems(
    planner?.touchpoints,
    CAMPAIGN_PANEL_LIMITS.touchpoints,
  );
  const topLinks = previewItems(clickMap?.links, CAMPAIGN_PANEL_LIMITS.links);
  const rows = previewItems(report?.rows, CAMPAIGN_PANEL_LIMITS.reportRows);

  async function handleCancel() {
    if (!campaignId || !canWrite) return;
    try {
      await confirmFreshCampaignWriteAuthority(me.data);
      await cancelDelivery(campaignId);
      await campaignQuery.refetch();
      toast.success("Delivery cancellation requested.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not cancel delivery.",
      );
    }
  }

  function handleExportReport() {
    if (!report) return;
    // `!report` guards the envelope, not its contents. A custom report that
    // came back without `metrics`/`rows` made this throw
    // "Cannot read properties of undefined (reading 'map')" on the click —
    // found by pressing the CSV button, not by reading the file, because a
    // crash in a handler is invisible to any render-path check.
    const metricKeys = Array.isArray(report.metrics) ? report.metrics : [];
    const reportRows = Array.isArray(report.rows) ? report.rows : [];
    if (metricKeys.length === 0 && reportRows.length === 0) {
      toast.error("This report has no rows to export yet.");
      return;
    }
    const header = ["Group", ...metricKeys.map(humanizeMetricKey)];
    const csvRows: Array<Array<string | number>> = [header];
    for (const r of reportRows) {
      // Same hazard one level down: a row without `dimensions`/`metrics` would
      // throw inside the loop and abort a download the user already started.
      const dim = Object.values(r.dimensions ?? {})[0] ?? "—";
      csvRows.push([
        dim,
        ...metricKeys.map((k) => formatMetricValue(k, r.metrics?.[k] ?? 0)),
      ]);
    }
    downloadTextFile(
      `custom-report-${reportGroupBy}.csv`,
      toCsv(csvRows),
      "text/csv;charset=utf-8",
    );
  }

  // Build a single-metric time series from the report graph for a quick trend
  // (ANL-012): plot the first selected non-revenue metric, else the first.
  const graphMetric = useMemo(() => {
    if (!report?.graph?.length) return null;
    const preferred = reportMetrics.find((m) => m !== "revenue_cents");
    return preferred ?? reportMetrics[0] ?? null;
  }, [report?.graph, reportMetrics]);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>Campaign Manager</CardTitle>
            <CardDescription>
              Calendar, testing, timing, click-map, delivery, and inbox controls
              from the Mailchimp parity layer.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Path out to the richer per-campaign reports (ANL-032). */}
            {campaignId ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/app/campaigns/${campaignId}/analytics`}>
                  View campaign report
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/compatibility">Parity dashboard</Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <PanelError
            message={error}
            onRetry={refetchAll}
            retrying={
              plannerQuery.isFetching ||
              reportQuery.isFetching ||
              campaignQuery.isFetching
            }
          />
        ) : null}

        {primaryLoading ? (
          <PanelGridSkeleton cells={3} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Planner touchpoints</div>
                <Badge variant="secondary">
                  {plannerFailed ? "—" : (planner?.touchpoints?.length ?? 0)}
                </Badge>
              </div>
              <div className="space-y-2">
                {visibleTouchpoints.map((item) => {
                  const inner = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 font-medium">
                          {frameSample(item.name).text}
                          {frameSample(item.name).sample ? (
                            <SampleBadge />
                          ) : null}
                        </span>
                        <Badge variant={statusVariant(item.status)}>
                          {item.status}
                        </Badge>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {item.channel} / {item.kind} /{" "}
                        <DateStamp value={item.scheduled_at ?? item.sent_at} />
                      </div>
                    </>
                  );
                  const rowClass =
                    "block rounded-md bg-muted/40 px-3 py-2 text-xs";
                  // Link a touchpoint to its campaign when it carries an id (ANL-020);
                  // otherwise render read-only (no dead click target).
                  return item.campaign_id ? (
                    <Link
                      key={item.id}
                      href={`/app/campaigns/${item.campaign_id}`}
                      className={`${rowClass} transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={item.id} className={rowClass}>
                      {inner}
                    </div>
                  );
                })}
                {visibleTouchpoints.length === 0 ? (
                  plannerFailed ? (
                    <PanelError message="Could not load planner touchpoints. Retry above." />
                  ) : (
                    <PanelEmpty
                      title="No planner touchpoints yet"
                      hint="Scheduled and sent campaigns appear here as a calendar of touchpoints."
                    />
                  )
                ) : null}
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Tasks</div>
                <Badge variant="secondary">
                  {plannerFailed ? "—" : (planner?.tasks?.length ?? 0)}
                </Badge>
              </div>
              <div className="space-y-2">
                {visibleTasks.map((task) => {
                  const inner = (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 font-medium">
                          {frameSample(task.title).text}
                          {frameSample(task.title).sample ? (
                            <SampleBadge />
                          ) : null}
                        </span>
                        <Badge variant={statusVariant(task.status)}>
                          {task.status}
                        </Badge>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {task.priority} priority / due{" "}
                        <DateStamp value={task.due_at} />
                      </div>
                    </>
                  );
                  const rowClass =
                    "block rounded-md bg-muted/40 px-3 py-2 text-xs";
                  return task.campaign_id ? (
                    <Link
                      key={task.id}
                      href={`/app/campaigns/${task.campaign_id}`}
                      className={`${rowClass} transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={task.id} className={rowClass}>
                      {inner}
                    </div>
                  );
                })}
                {visibleTasks.length === 0 ? (
                  plannerFailed ? (
                    <PanelError message="Could not load campaign tasks. Retry above." />
                  ) : (
                    <PanelEmpty
                      title="No campaign tasks yet"
                      hint="Tasks generated by the campaign planner show up here."
                    />
                  )
                ) : null}
              </div>
            </div>

            <CustomReportCard
              report={report}
              rows={rows}
              metrics={reportMetrics}
              groupBy={reportGroupBy}
              graphMetric={graphMetric}
              loading={reportQuery.isFetching}
              failed={reportQuery.isError && !report}
              onToggleMetric={(m) =>
                setReportMetrics((prev) =>
                  prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m],
                )
              }
              onGroupByChange={setReportGroupBy}
              onExport={handleExportReport}
            />
          </div>
        )}

        {campaignId ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  Testing and send timing
                </div>
                <Badge
                  variant={multivariate?.enabled ? "success" : "secondary"}
                >
                  {multivariate?.variations?.length ?? 0} variants
                </Badge>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                <MetricBox
                  label="Winner metric"
                  value={multivariate?.winner_metric ?? "Not configured"}
                />
                <MetricBox
                  label="Best send time"
                  value={sendTime?.recommendation?.label ?? "Learning"}
                  detail={sendTime?.recommendation.confidence}
                />
                <MetricBox
                  label="Best send day"
                  value={sendDay?.recommendation?.label ?? "Learning"}
                  detail={sendDay?.recommendation.grade}
                />
              </div>
              {multivariate?.report?.length ? (
                <div className="mt-3 grid gap-2">
                  {multivariate.report.slice(0, 4).map((variant) => (
                    <div
                      key={variant.variant_id}
                      className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs"
                    >
                      <span className="font-medium">{variant.label}</span>
                      <span className="text-muted-foreground">
                        opens {pct(variant.open_rate)} / clicks{" "}
                        {pct(variant.click_rate)}
                      </span>
                      {variant.winner ? (
                        <Badge variant="success">winner</Badge>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Delivery insights</div>
                <Badge
                  variant={statusVariant(
                    delivery?.delivery_status ?? delivery?.status,
                  )}
                >
                  {delivery?.delivery_status ?? delivery?.status ?? "unknown"}
                </Badge>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {entries(delivery?.progress)
                  .slice(0, 6)
                  .map(([key, value]) => (
                    <MetricBox
                      key={key}
                      label={humanizeMetricKey(key)}
                      value={metric(value)}
                    />
                  ))}
              </div>
              {delivery?.warnings?.length ? (
                // Use semantic warning tokens (dark-mode-safe) instead of raw amber-* swatches.
                <div className="mt-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
                  {delivery.warnings[0]}
                </div>
              ) : null}
              {delivery?.can_cancel && canWrite ? (
                // Gate the irreversible cancel behind a confirm dialog (ANL-036).
                <ConfirmDialog
                  title="Cancel in-flight delivery?"
                  description="This stops the campaign mid-send. Recipients already delivered to will still receive it; remaining recipients will not. This can't be undone."
                  confirmLabel="Cancel delivery"
                  cancelLabel="Keep sending"
                  onConfirm={handleCancel}
                  trigger={
                    <Button className="mt-3" variant="outline" size="sm">
                      Cancel in-flight delivery
                    </Button>
                  }
                />
              ) : null}
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Click map</div>
                <Badge variant="secondary">
                  {metric(clickMap?.total_clicks)} clicks
                </Badge>
              </div>
              <div className="space-y-2">
                {topLinks.map((link) => (
                  <div
                    key={link.link_id}
                    className="rounded-md bg-muted/40 px-3 py-2 text-xs"
                  >
                    <div className="truncate font-medium">{link.url}</div>
                    <div className="mt-1 text-muted-foreground">
                      {link.clicks.toLocaleString()} clicks /{" "}
                      {link.unique_clicks.toLocaleString()} unique /{" "}
                      {pct(link.share)}
                    </div>
                  </div>
                ))}
                {!campaignQuery.isPending && topLinks.length === 0 ? (
                  <PanelEmpty title="No click-map data yet" />
                ) : null}
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Inbox and replies</div>
                <Badge
                  variant={inbox?.follow_up_open ? "warning" : "secondary"}
                >
                  {inbox?.total_items ?? 0} replies
                </Badge>
              </div>
              <div className="space-y-2">
                {inbox?.replies?.slice(0, 4).map((reply) => (
                  <div
                    key={reply.id}
                    className="rounded-md bg-muted/40 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{reply.email_address}</span>
                      {reply.needs_follow_up ? (
                        <Badge variant="warning">follow up</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {reply.snippet ?? reply.subject ?? "Reply captured"}
                    </div>
                  </div>
                ))}
                {!campaignQuery.isPending && !inbox?.replies?.length ? (
                  <PanelEmpty title="No campaign replies yet" />
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CustomReportCard({
  report,
  rows,
  metrics,
  groupBy,
  graphMetric,
  loading,
  failed,
  onToggleMetric,
  onGroupByChange,
  onExport,
}: {
  report: CustomReportResponse | null;
  rows: CustomReportResponse["rows"];
  metrics: string[];
  groupBy: string;
  graphMetric: string | null;
  loading: boolean;
  failed: boolean;
  onToggleMetric: (metric: string) => void;
  onGroupByChange: (groupBy: string) => void;
  onExport: () => void;
}) {
  const availableMetrics = report?.available_metrics ?? metrics;
  const availableGroupBy = report?.available_group_by ?? [groupBy];
  const graphValues =
    graphMetric && report?.graph
      ? report.graph.map((p) => p.metrics[graphMetric] ?? 0)
      : [];
  const graphLabels = report?.graph?.map((p) => p.date) ?? [];

  return (
    <div className="rounded-md border p-3 lg:col-span-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Custom report</div>
        {report ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={loading}
            title={
              loading
                ? "Wait for the current report to finish loading before exporting."
                : undefined
            }
            onClick={onExport}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </Button>
        ) : null}
      </div>

      {/* Builder controls: pick grouping + metrics from the API-provided
          options (ANL-033). */}
      <div className="mt-2 space-y-2">
        <label className="block text-[11px] font-medium uppercase text-muted-foreground">
          Group by
          <Select
            aria-label="Group report by"
            className="mt-1 h-8 text-xs"
            value={groupBy}
            onChange={(e) => onGroupByChange(e.target.value)}
          >
            {availableGroupBy.map((g) => (
              <option key={g} value={g}>
                {humanizeMetricKey(g)}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {availableMetrics.map((m) => (
            <label
              key={m}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <Checkbox
                checked={metrics.includes(m)}
                onChange={() => onToggleMetric(m)}
              />
              {humanizeMetricKey(m)}
            </label>
          ))}
        </div>
      </div>

      {graphMetric && graphValues.length >= 2 ? (
        <div className="mt-3">
          <LineChart
            values={graphValues}
            labels={graphLabels}
            height={90}
            colorVar="--chart-3"
            ariaLabel={`${humanizeMetricKey(graphMetric)} over time`}
            formatY={(n) => n.toLocaleString()}
          />
        </div>
      ) : null}

      <div className="mt-3 space-y-2" aria-busy={loading}>
        {rows.map((row, index) => {
          const dim = Object.values(row.dimensions)[0] ?? `Row ${index + 1}`;
          return (
            <div
              key={`${dim}-${index}`}
              className="rounded-md bg-muted/40 px-3 py-2 text-xs"
            >
              <div className="font-medium">{dim}</div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-muted-foreground">
                {metrics.map((key) => (
                  <span key={key}>
                    {humanizeMetricKey(key)}:{" "}
                    {formatMetricValue(key, row.metrics[key] ?? 0)}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        {rows.length === 0 ? (
          failed ? (
            <PanelError message="Could not load custom report rows. Retry above." />
          ) : (
            <PanelEmpty
              title="No custom report rows yet"
              hint="A custom report aggregates campaign metrics (opens, clicks, revenue) by a dimension you choose above. Rows appear once you have reportable sends."
            />
          )
        ) : null}
      </div>
    </div>
  );
}
