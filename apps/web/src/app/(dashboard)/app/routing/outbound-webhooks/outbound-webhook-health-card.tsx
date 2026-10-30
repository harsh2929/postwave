// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Destination health, trailing 24 hours (platform-120) — the web rendering of
 * desktop's WebhookHealthCard over GET /api/v1/outbound-webhooks/{id}/health.
 *
 * A destination with no deliveries in the window says so instead of showing a
 * 0% success rate that reads as broken, and a failed read says it failed
 * (with a retry) instead of rendering zeros.
 */

import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getOutboundWebhookHealth,
  outboundWebhookKeys,
  type OutboundWebhookHealth,
} from "@/lib/outbound-webhooks-api";
import type { RoleKey } from "@/lib/query-keys";

function fmtMs(ms: number): string {
  if (ms < 1) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Succeeded over completed (succeeded + failed); pending/skipped excluded. */
export function outboundHealthSuccessRate(health: OutboundWebhookHealth): number {
  const completed = health.deliveries_succeeded + health.deliveries_failed;
  if (completed <= 0) return 0;
  return (health.deliveries_succeeded / completed) * 100;
}

function toneOf(rate: number): {
  label: string;
  variant: "success" | "warning" | "destructive";
} {
  if (rate >= 95) return { label: "Healthy", variant: "success" };
  if (rate >= 80) return { label: "Watch", variant: "warning" };
  return { label: "Degraded", variant: "destructive" };
}

export function OutboundWebhookHealthCard({
  webhookId,
  tenantId,
  role,
  principalKey,
}: {
  webhookId: string;
  tenantId: string;
  role: RoleKey;
  principalKey: string;
}) {
  const healthQuery = useQuery({
    queryKey: outboundWebhookKeys.health(
      tenantId,
      role,
      webhookId,
      principalKey,
    ),
    queryFn: ({ signal }) => getOutboundWebhookHealth(webhookId, { signal }),
    staleTime: 0,
  });

  if (healthQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="Loading webhook health for the trailing 24 hours"
        className="rounded-lg border p-4"
      >
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }

  if (healthQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Couldn&apos;t load webhook health:{" "}
          {apiErrorMessage(
            healthQuery.error,
            "the health request failed; these are not zero-delivery results.",
          )}{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            loading={healthQuery.isFetching}
            onClick={() => void healthQuery.refetch()}
          >
            Retry health
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const health = healthQuery.data;
  if (health.deliveries_total === 0) {
    return (
      <section
        aria-label="Destination health, trailing 24 hours"
        className="rounded-lg border p-4 text-sm text-muted-foreground"
      >
        No webhook deliveries were recorded in the trailing 24 hours.
      </section>
    );
  }

  const rate = outboundHealthSuccessRate(health);
  const tone = toneOf(rate);
  const completed = health.deliveries_succeeded + health.deliveries_failed;
  const topErrors = health.top_errors.slice(0, 3);
  const latest = [health.last_succeeded_at, health.last_failed_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <section
      aria-label="Destination health, trailing 24 hours"
      className="space-y-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Health · trailing 24 hours</h3>
        <Badge variant={tone.variant}>{tone.label}</Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">Success rate</dt>
          <dd className="font-semibold tabular-nums">{rate.toFixed(1)}%</dd>
          <dd>
            <Progress
              value={rate}
              aria-label={`24-hour success rate ${rate.toFixed(1)}%`}
            />
          </dd>
          <dd className="text-xs text-muted-foreground">
            {health.deliveries_succeeded.toLocaleString()} of{" "}
            {completed.toLocaleString()} completed ·{" "}
            {health.deliveries_total.toLocaleString()} total
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">Latency</dt>
          <dd className="font-semibold tabular-nums">
            p50 {fmtMs(health.latency_p50_ms)}
          </dd>
          <dd className="text-xs tabular-nums text-muted-foreground">
            p99 {fmtMs(health.latency_p99_ms)}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">
            {topErrors.length === 0 ? "No errors" : "Top errors"}
          </dt>
          {topErrors.length === 0 ? (
            <dd className="text-xs text-muted-foreground">
              No failed delivery reasons in this window.
            </dd>
          ) : (
            topErrors.map((error, index) => (
              <dd
                key={`${error.status_code}-${index}`}
                className="flex gap-2 text-xs"
              >
                <span className="font-mono">{error.status_code || "—"}</span>
                <span className="min-w-0 flex-1 break-words">
                  {error.message || "Network error"}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  ×{error.count.toLocaleString()}
                </span>
              </dd>
            ))
          )}
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">Cancelled</dt>
          <dd className="font-semibold tabular-nums">
            {health.deliveries_skipped.toLocaleString()}
          </dd>
          <dd className="text-xs text-muted-foreground">
            Endpoint deletion · excluded from failures
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        {health.consecutive_failures.toLocaleString()} consecutive{" "}
        {health.consecutive_failures === 1 ? "failure" : "failures"} ·{" "}
        {health.auto_disabled
          ? `auto-disabled${health.disabled_reason ? ` (${health.disabled_reason})` : ""}`
          : "not auto-disabled"}
        {latest
          ? ` · latest outcome ${formatWireTimestamp(latest, latest)}`
          : ""}
      </p>
    </section>
  );
}
