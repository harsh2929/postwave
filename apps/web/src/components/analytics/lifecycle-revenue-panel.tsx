// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { LineChart } from "@/components/charts/line-chart";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
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
  getCampaignRevenueAttribution,
  getCampaignRevenueTimeseries,
  getSubscriberLifecycleFunnel,
  type CampaignRevenueAttribution,
} from "@/lib/analytics-api";
import { listTags } from "@/lib/audience-admin-api";
import { formatCents } from "@/lib/format-currency";
import { base, STALE, type RoleKey } from "@/lib/query-keys";

const FUNNEL_COHORTS = 12;

function percentage(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(value >= 10 ? 0 : 1) + "%";
}

function ErrorState({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
    >
      <p>{message}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRetry}
        loading={retrying}
      >
        Retry
      </Button>
    </div>
  );
}

function FunnelPanel({ tenantId, role }: { tenantId: string; role: RoleKey }) {
  const [audience, setAudience] = useState("");
  const key = useMemo(
    () => base("subscriber-lifecycle-funnel", tenantId, role),
    [role, tenantId],
  );
  const tags = useQuery({
    queryKey: [...key, "tag-catalog"],
    queryFn: ({ signal }) => listTags({ signal }),
    enabled: tenantId !== "anon",
    staleTime: STALE.list,
  });
  const funnel = useQuery({
    queryKey: [...key, "cohorts", FUNNEL_COHORTS, audience],
    queryFn: ({ signal }) =>
      getSubscriberLifecycleFunnel({
        weeks: FUNNEL_COHORTS,
        audienceId: audience || undefined,
        signal,
      }),
    enabled: tenantId !== "anon",
    staleTime: STALE.dashboard,
  });
  const first = funnel.data?.steps[0]?.count ?? 0;

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2">Signup-to-purchase cohort funnel</CardTitle>
          <CardDescription className="max-w-2xl">
            Lifetime-to-date signup → first paid purchase → repeat paid purchase
            across the last {FUNNEL_COHORTS} monthly cohorts. Newer cohorts have
            had less time to mature.
          </CardDescription>
        </div>
        <div className="w-full space-y-1 sm:w-64">
          {tags.isLoading ? (
            <Skeleton className="h-11 w-full sm:h-9" />
          ) : (
            <Select
              aria-label="Scope lifecycle funnel to a tagged audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
            >
              <option value="">All subscribers</option>
              {tags.data?.map((tag) => (
                <option key={tag.id} value={tag.name}>
                  {tag.name}
                </option>
              ))}
            </Select>
          )}
          {tags.isError ? (
            <div className="text-xs text-destructive" role="alert">
              <p>
                Audience filters are unavailable. All subscribers are shown.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => void tags.refetch()}
                loading={tags.isFetching}
              >
                Retry filters
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {funnel.isLoading ? (
          <Skeleton className="h-60 w-full" />
        ) : funnel.isError ? (
          <ErrorState
            message="The subscriber lifecycle funnel could not be verified. A failed response is not shown as an empty cohort."
            retrying={funnel.isFetching}
            onRetry={() => void funnel.refetch()}
          />
        ) : !funnel.data || first === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No signups were recorded in these cohorts
            {audience ? " for the selected audience" : ""}. Purchase stages
            appear after matching currently paid orders accumulate.
          </p>
        ) : (
          <div className="space-y-5">
            <ol
              aria-label="Subscriber lifecycle funnel stages"
              className="space-y-3"
            >
              {funnel.data.steps.map((step, index) => {
                const width = first > 0 ? (step.count / first) * 100 : 0;
                return (
                  <li key={step.stage}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{step.label}</span>
                      <span className="tabular-nums">
                        {step.count.toLocaleString()}
                        {index > 0
                          ? " · " +
                            percentage(step.conversion_rate) +
                            " from prior stage"
                          : ""}
                      </span>
                    </div>
                    <div className="h-8 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full min-w-1 rounded bg-primary"
                        style={{ width: String(Math.max(0.5, width)) + "%" }}
                        aria-hidden
                      />
                    </div>
                  </li>
                );
              })}
            </ol>

            <TableContainer aria-label="Lifecycle funnel by signup month">
              <Table>
                <caption className="sr-only">
                  Exact lifecycle funnel counts and conversion rates by signup
                  month
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signup cohort</TableHead>
                    <TableHead className="text-right">Signups</TableHead>
                    <TableHead className="text-right">First purchase</TableHead>
                    <TableHead className="text-right">
                      Repeat purchase
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {funnel.data.cohorts.map((cohort) => (
                    <TableRow key={cohort.cohort_label}>
                      <TableCell className="font-medium tabular-nums">
                        {cohort.cohort_label}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cohort.signup_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cohort.first_purchase_count.toLocaleString()}
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({percentage(cohort.first_purchase_rate)})
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cohort.repeat_purchase_count.toLocaleString()}
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({percentage(cohort.repeat_purchase_rate)})
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <p className="text-xs text-muted-foreground">
              Paid orders count only from each subscriber&apos;s signup through
              the server snapshot. Pending, cancelled, refunded, pre-signup, and
              future-dated orders are excluded.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function hasRevenueActivity(data: CampaignRevenueAttribution): boolean {
  return (
    data.total_revenue_cents !== 0 ||
    data.unattributed_cents !== 0 ||
    data.unattributed_conversions > 0 ||
    data.items.some(
      (item) => item.conversions > 0 || item.revenue_cents !== 0,
    ) ||
    data.currencies.some(
      (item) => item.conversions > 0 || item.revenue_cents !== 0,
    )
  );
}

function RevenuePanel({
  tenantId,
  role,
  days,
}: {
  tenantId: string;
  role: RoleKey;
  days: number;
}) {
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const key = useMemo(
    () => base("campaign-revenue-attribution", tenantId, role),
    [role, tenantId],
  );
  const attribution = useQuery({
    queryKey: [...key, "campaigns", days],
    queryFn: ({ signal }) => getCampaignRevenueAttribution(days, signal),
    enabled: tenantId !== "anon",
    staleTime: STALE.dashboard,
  });
  const attributionItems = Array.isArray(attribution.data?.items)
    ? attribution.data.items
    : [];
  const campaignOptions = attributionItems.filter((item) => item.campaign_id);
  const campaignFilter = campaignOptions.some(
    (item) => item.campaign_id === selectedCampaign,
  )
    ? selectedCampaign
    : "";
  const timeseries = useQuery({
    queryKey: [...key, "timeseries", days, campaignFilter],
    queryFn: ({ signal }) =>
      getCampaignRevenueTimeseries({
        days,
        campaignId: campaignFilter || undefined,
        signal,
      }),
    enabled: tenantId !== "anon" && attribution.isSuccess,
    staleTime: STALE.dashboard,
  });
  const currency =
    attribution.data?.currency ?? timeseries.data?.currency ?? "USD";
  const provenance = attribution.data?.provenance;
  const provenanceTotal = provenance
    ? provenance.explicit +
      provenance.last_touch +
      provenance.none +
      provenance.code_redemption +
      provenance.campaign_vanity_path +
      provenance.unclassified
    : 0;
  const chartHasActivity =
    timeseries.data?.points?.some(
      (point) => point.revenue_cents !== 0 || point.conversions > 0,
    ) ?? false;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2">Campaign revenue attribution</CardTitle>
          <CardDescription>
            Net conversion revenue for the last {days} days. Campaign rows use
            explicit attribution or a recent-click last-touch heuristic;
            unattributed and unclassified conversions remain visible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attribution.isLoading ? (
            <Skeleton className="h-60 w-full" />
          ) : attribution.isError ? (
            <ErrorState
              message="Campaign revenue attribution could not be verified. No failed response is presented as zero revenue."
              retrying={attribution.isFetching}
              onRetry={() => void attribution.refetch()}
            />
          ) : !attribution.data || !hasRevenueActivity(attribution.data) ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No monetary conversion or refund activity was recorded in this
              window.
            </p>
          ) : (
            <div className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border bg-muted/20 p-3">
                  <dt className="text-xs text-muted-foreground">
                    Workspace net revenue
                  </dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCents(
                      attribution.data.total_revenue_cents,
                      currency,
                    )}
                  </dd>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <dt className="text-xs text-muted-foreground">
                    Unattributed revenue
                  </dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCents(attribution.data.unattributed_cents, currency)}
                  </dd>
                  <p className="text-xs text-muted-foreground">
                    {attribution.data.unattributed_conversions.toLocaleString()}{" "}
                    conversions
                  </p>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <dt className="text-xs text-muted-foreground">
                    Campaigns with attribution
                  </dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums">
                    {attribution.data.total_campaigns.toLocaleString()}
                  </dd>
                </div>
              </dl>

              {provenance && provenanceTotal > 0 ? (
                <div
                  role="note"
                  className="rounded-md border p-3 text-xs text-muted-foreground"
                >
                  Attribution evidence:{" "}
                  <span className="font-medium text-foreground">
                    {percentage((provenance.explicit / provenanceTotal) * 100)}
                  </span>{" "}
                  explicit ·{" "}
                  <span className="font-medium text-foreground">
                    {percentage(
                      (provenance.last_touch / provenanceTotal) * 100,
                    )}
                  </span>{" "}
                  last-touch heuristic · {provenance.none.toLocaleString()} no
                  campaign · {provenance.code_redemption.toLocaleString()} code
                  assignment linkage ·{" "}
                  {provenance.campaign_vanity_path.toLocaleString()} shared
                  campaign path · {provenance.unclassified.toLocaleString()} legacy unclassified.
                </div>
              ) : null}

              {attribution.data.currencies.length > 1 ? (
                <p className="text-xs text-muted-foreground">
                  Monetary totals span{" "}
                  {attribution.data.currencies
                    .map(
                      (entry) =>
                        entry.currency +
                        " " +
                        formatCents(entry.revenue_cents, entry.currency),
                    )
                    .join(" · ")}
                  . The table uses dominant currency {currency}.
                </p>
              ) : null}

              {attribution.data.items.length > 0 ? (
                <TableContainer aria-label="Revenue attributed by campaign">
                  <Table className="min-w-[760px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Campaign</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">
                          Conversions
                        </TableHead>
                        <TableHead className="text-right">
                          Emails sent
                        </TableHead>
                        <TableHead className="text-right">
                          Revenue / send
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {attribution.data.items.map((item) => (
                        <TableRow key={item.campaign_id || "__other-campaigns"}>
                          <TableCell
                            className={
                              item.campaign_id
                                ? "max-w-72 truncate font-medium"
                                : "max-w-72 truncate italic text-muted-foreground"
                            }
                            title={item.campaign_name}
                          >
                            {item.campaign_name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCents(item.revenue_cents, currency)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.conversions.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.emails_sent.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.revenue_per_send_cents === undefined
                              ? "—"
                              : formatCents(
                                  item.revenue_per_send_cents,
                                  currency,
                                )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Conversions exist, but none were attributed to a campaign.
                </p>
              )}
              {attribution.data.total_campaigns > campaignOptions.length ? (
                <p className="text-xs text-muted-foreground">
                  Showing the top {campaignOptions.length.toLocaleString()} of{" "}
                  {attribution.data.total_campaigns.toLocaleString()} campaigns;
                  the labelled rollup preserves the remainder.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle as="h2">Net conversion revenue over time</CardTitle>
            <CardDescription>
              Server-zero-filled daily net revenue; refunds can plot below zero.
              Select one attributed campaign or inspect the workspace.
            </CardDescription>
          </div>
          <Select
            aria-label="Filter revenue timeseries by campaign"
            className="w-full sm:w-64"
            value={campaignFilter}
            onChange={(event) => setSelectedCampaign(event.target.value)}
            disabled={campaignOptions.length === 0}
          >
            <option value="">All campaigns</option>
            {campaignOptions.map((item) => (
              <option key={item.campaign_id} value={item.campaign_id}>
                {item.campaign_name}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent>
          {timeseries.isLoading ? (
            <Skeleton className="h-52 w-full" />
          ) : timeseries.isError ? (
            <ErrorState
              message="The daily revenue series could not be verified. This failure is distinct from a zero-activity window."
              retrying={timeseries.isFetching}
              onRetry={() => void timeseries.refetch()}
            />
          ) : !timeseries.data || !chartHasActivity ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No attributed revenue activity was recorded for this scope in the
              selected window.
            </p>
          ) : (
            <div className="space-y-3">
              <LineChart
                values={timeseries.data.points.map(
                  (point) => point.revenue_cents / 100,
                )}
                labels={timeseries.data.points.map((point) => point.date)}
                ariaLabel="Daily net conversion revenue"
                formatY={(value) =>
                  formatCents(Math.round(value * 100), currency)
                }
              />
              <p className="text-xs text-muted-foreground">
                Exact daily values are available from each chart point&apos;s
                underlying ordered series. Amounts are shown in {currency}.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function AnalyticsLifecycleRevenuePanel({
  tenantId,
  role,
  days,
}: {
  tenantId: string;
  role: RoleKey;
  days: number;
}) {
  return (
    <div className="space-y-6">
      <FunnelPanel tenantId={tenantId} role={role} />
      <RevenuePanel tenantId={tenantId} role={role} days={days} />
    </div>
  );
}
