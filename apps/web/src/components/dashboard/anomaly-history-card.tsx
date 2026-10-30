// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Recent anomalies with their two follow-ups (desktop AnomalyHistoryCard):
//   * the metric name opens Analytics focused on that metric over the window
//     the anomaly was detected in (/app/analytics?metric=…&range=…);
//   * "Explain" asks the AI anomaly brief about it (POST
//     /api/v1/analytics/anomaly-brief) in AnomalyBriefDialog. Metrics outside
//     the brief's whitelist get no button rather than one that 422s.
// Reads GET /api/v1/dashboard/anomalies. A healthy, empty result keeps the
// card off the page; a failed read says so with a Retry.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AnomalyBriefDialog,
  asBriefMetric,
  briefWindowDays,
  type AnomalyBriefRequest,
} from "@/components/analytics/anomaly-brief-dialog";
import { listAnomalies, type AnomalyRow } from "@/lib/analytics-api";
import { humanizeMetricKey } from "@/lib/analytics-format";
import {
  analyticsMetricHref,
  asFocusMetric,
} from "@/lib/analytics-view-params";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { asRoute } from "@/lib/typed-routes";

const HISTORY_LIMIT = 8;

function isAnomalyRow(value: unknown): value is AnomalyRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AnomalyRow>;
  return (
    typeof row.id === "string" &&
    typeof row.metric === "string" &&
    typeof row.dayBucket === "string" &&
    typeof row.value === "number" &&
    Number.isFinite(row.value) &&
    typeof row.mean === "number" &&
    Number.isFinite(row.mean)
  );
}

export function AnomalyHistoryCard({
  tenantId,
  role,
  userId = "unverified",
}: {
  tenantId: string;
  role: RoleKey;
  userId?: string;
}) {
  const [explain, setExplain] = useState<AnomalyBriefRequest | null>(null);
  const query = useQuery({
    queryKey: [...base("anomaly-history", tenantId, role), userId],
    queryFn: ({ signal }) => listAnomalies(HISTORY_LIMIT, { signal }),
    enabled: tenantId !== "anon" && role !== null,
    staleTime: STALE.dashboard,
  });

  const rawItems = Array.isArray(query.data?.items) ? query.data.items : [];
  const items = rawItems.filter(isAnomalyRow).slice(0, HISTORY_LIMIT);

  // Keep a healthy empty result quiet, but never let a failed read pass for it.
  if (query.isPending || (!query.isError && items.length === 0)) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TriangleAlert
            className="h-4 w-4 text-warning-emphasis"
            aria-hidden
          />
          <CardTitle>Recent anomalies</CardTitle>
        </div>
        <CardDescription>
          Metrics that deviated sharply from their recent baseline. Open one in
          Analytics, or ask AI to explain it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-3 text-sm text-warning-emphasis sm:flex-row sm:items-center sm:justify-between"
          >
            <span>Recent anomalies couldn&apos;t be loaded.</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 sm:min-h-9"
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((a) => {
              const above = a.value >= a.mean;
              const label = humanizeMetricKey(a.metric);
              const focus = asFocusMetric(a.metric);
              const briefMetric = asBriefMetric(a.metric);
              return (
                <li
                  key={a.id}
                  data-testid="anomaly-history-row"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant={above ? "warning" : "secondary"}>
                      {above ? "spike" : "drop"}
                    </Badge>
                    {focus ? (
                      <Link
                        href={asRoute(analyticsMetricHref(focus, a.rangeUsed))}
                        aria-label={`Open Analytics focused on ${label}`}
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className="font-medium">{label}</span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-2 text-muted-foreground tabular-nums">
                    <span>
                      {a.value.toLocaleString()} vs{" "}
                      {Math.round(a.mean).toLocaleString()} avg
                    </span>
                    <span title={absoluteTime(a.dayBucket)}>
                      {timeAgo(a.dayBucket)}
                    </span>
                    {briefMetric ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Ask AI to explain the ${label} anomaly`}
                        onClick={() =>
                          setExplain({
                            metric: briefMetric,
                            windowDays: briefWindowDays(a.rangeUsed),
                          })
                        }
                      >
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                        Explain
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <AnomalyBriefDialog request={explain} onClose={() => setExplain(null)} />
    </Card>
  );
}
