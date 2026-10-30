// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Analytics tab (FORM-008): charts per-day hosted-form visits over a 30/90d
// window from GET /api/v1/forms/{id}/analytics, alongside the 30d
// submissions / conversion the list payload computes.

import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LineChart } from "@/components/charts/line-chart";
import { FormChartCsvExport } from "@/components/forms/form-chart-csv-export";
import { ChartSkeleton } from "@/components/dashboard/skeletons";
import { whoami } from "@/lib/auth-api";
import { getFormAnalytics, listForms } from "@/lib/forms-api";
import { formatCount } from "@/lib/forms-list-helpers";
import { base, qk, STALE } from "@/lib/query-keys";

export function AnalyticsPanel({ formId }: { formId: string }) {
  const [days, setDays] = useState<30 | 90>(30);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;

  const analyticsQuery = useQuery({
    queryKey: [
      ...base("forms", tenantId, role),
      "analytics",
      formId,
      days,
    ] as const,
    queryFn: () => getFormAnalytics(formId, days),
    enabled: meQuery.isFetched,
    staleTime: STALE.dashboard,
  });

  const listQuery = useQuery({
    queryKey: qk.forms(tenantId, role),
    queryFn: listForms,
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });
  const summary = listQuery.data?.find((f) => f.id === formId);

  const series = useMemo(
    () => Array.isArray(analyticsQuery.data?.visits) ? analyticsQuery.data?.visits : [],
    [analyticsQuery.data],
  );
  const values = useMemo(() => series.map((p) => p.count), [series]);
  const labels = useMemo(() => series.map((p) => p.date), [series]);
  const visitsTotal = analyticsQuery.data?.visitsTotal ?? 0;

  if (analyticsQuery.isPending && !analyticsQuery.data) {
    return <ChartSkeleton className="max-w-3xl" />;
  }
  if (analyticsQuery.error instanceof Error) {
    return (
      <div className="max-w-3xl space-y-3">
        <p className="text-sm text-destructive">
          Could not load analytics: {analyticsQuery.error.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void analyticsQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Performance</h3>
        <div className="inline-flex overflow-hidden rounded-md border">
          {([30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={
                "px-3 py-1 text-xs " +
                (days === d
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground")
              }
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label={`Visits (${days}d)`} value={formatCount(visitsTotal)} />
        <Stat
          label="Submissions (30d)"
          value={summary ? formatCount(summary.submissions30d) : "—"}
        />
        <Stat
          label="Conversion (30d)"
          value={summary ? `${summary.conversionRate}%` : "—"}
        />
      </div>

      <div className="rounded-md border bg-card p-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Daily visits
        </h4>
        <LineChart
          values={values}
          labels={labels}
          ariaLabel={`Daily hosted-form visits over the last ${days} days`}
          formatY={(n) => formatCount(n)}
        />
      </div>
      <FormChartCsvExport
        formId={formId}
        days={days}
        visits={series}
        identity={meQuery.data}
      />
      {summary ? null : (
        <p className="text-xs text-muted-foreground">
          Submission and conversion figures load from the forms list.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
