// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Reporting catalogue — which metrics exist, and which of them can actually
 * produce a number.
 *
 * Two paths desktop reached and web did not.
 *
 * The page joins blocked products to metrics BY KEY, not by product area.
 * The area join is the tempting one and it is wrong: it marks 9 of this
 * workspace's 24 metrics unavailable when only 6 are, because three supported
 * campaign metrics happen to live in the "deliverability" area alongside the
 * one metric that is genuinely blocked.
 *
 * `partial` is kept distinct from `planned`. A partial metric returns some
 * data and is worth reading with care; a planned one returns nothing.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  blockFor,
  getBlockedProducts,
  getMetricRegistry,
  type RuntimeStatus,
} from "@/lib/reporting-registry-api";
import { base, qk, STALE } from "@/lib/query-keys";

const STATUS_LABEL: Record<RuntimeStatus, string> = {
  supported: "Reports now",
  partial: "Partial data",
  planned: "No data yet",
  unknown: "Status not reported",
};

const STATUS_VARIANT: Record<RuntimeStatus, "success" | "warning" | "outline"> =
  {
    supported: "success",
    partial: "warning",
    planned: "outline",
    unknown: "outline",
  };

export default function ReportingCataloguePage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identityReady = meQuery.isSuccess && Boolean(meQuery.data);
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const keyBase = useMemo(
    () =>
      base(
        "reporting-catalogue",
        meQuery.data?.tenant_id ?? "anon",
        effectiveRole,
      ),
    [effectiveRole, meQuery.data?.tenant_id],
  );

  const registry = useQuery({
    queryKey: [...keyBase, "metric-registry"],
    queryFn: getMetricRegistry,
    enabled: identityReady,
    staleTime: STALE.reference,
  });
  const blocks = useQuery({
    queryKey: [...keyBase, "blocked-products"],
    queryFn: getBlockedProducts,
    enabled: identityReady,
    staleTime: STALE.reference,
  });

  const metrics = useMemo(
    () => (Array.isArray(registry.data?.metrics) ? registry.data.metrics : []),
    [registry.data?.metrics],
  );
  const blocked = Array.isArray(blocks.data?.blocked)
    ? blocks.data.blocked
    : [];
  const refreshing = registry.isFetching || blocks.isFetching;
  const counts = useMemo(() => {
    const c = { supported: 0, partial: 0, planned: 0, unknown: 0 };
    for (const m of metrics) c[m.runtime_status] += 1;
    return c;
  }, [metrics]);

  if (!identityReady)
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Reporting catalogue
        </h1>
        {meQuery.isPending ? (
          <p role="status">Verifying workspace access…</p>
        ) : (
          <div role="alert" className="mt-4 space-y-3">
            <p>
              Workspace identity could not be verified. No reporting catalogue
              request was started.
            </p>
            <Button
              variant="outline"
              onClick={() => void meQuery.refetch()}
              disabled={meQuery.isFetching}
            >
              Retry workspace access
            </Button>
          </div>
        )}
      </PageShell>
    );

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Reporting catalogue
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every metric Moosewave knows how to report, and whether it can
            produce a number today.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void registry.refetch();
            void blocks.refetch();
          }}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh catalogue"}
        </Button>
      </header>

      <section
        aria-labelledby="rc-summary"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="rc-summary" className="text-base font-medium">
          Coverage
        </h2>
        {registry.isPending ? (
          <div role="status" aria-busy="true" className="mt-3 space-y-2">
            <span className="sr-only">Loading reporting coverage…</span>
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
        ) : registry.isError ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive">
              Could not load the metric registry. No coverage claim is shown.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void registry.refetch()}
              disabled={registry.isFetching}
            >
              {registry.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {metrics.length} registered{" "}
              {metrics.length === 1 ? "metric" : "metrics"}: {counts.supported}{" "}
              reporting now, {counts.partial} with partial data,{" "}
              {counts.planned} with none yet
              {counts.unknown > 0
                ? `, ${counts.unknown} with status not reported`
                : ""}
              .
            </p>
            {counts.partial > 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Partial metrics return real numbers over an incomplete source —
                they are not zero, and they are not the whole picture.
              </p>
            ) : null}
            {registry.data?.schema_version ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Registry schema{" "}
                <code className="font-mono text-xs">
                  {registry.data.schema_version}
                </code>
                .
              </p>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="rc-metrics">
        <h2 id="rc-metrics" className="text-base font-medium">
          Metrics
        </h2>
        {registry.isPending ? (
          <div role="status" aria-busy="true" className="mt-3 space-y-2">
            <span className="sr-only">Loading registered metrics…</span>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : registry.isError ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Metric details are unavailable until the registry request succeeds.
          </p>
        ) : metrics.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No metrics registered.
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border">
            {metrics.map((m) => {
              const block = blockFor(m.key, blocked);
              return (
                <li key={m.key} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{m.label}</span>
                    <Badge variant={STATUS_VARIANT[m.runtime_status]}>
                      {STATUS_LABEL[m.runtime_status]}
                    </Badge>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {m.key} · {m.aggregation} · {m.value_type}
                  </p>
                  {/* Attached by metric key, never by product area. */}
                  {block ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {block.blocked_note} Tracked under{" "}
                      <span className="font-mono text-xs">
                        {block.initiative}
                      </span>
                      .
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="rc-blocked"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="rc-blocked" className="text-base font-medium">
          Blocked areas
        </h2>
        {blocks.isPending ? (
          <div role="status" aria-busy="true" className="mt-3 space-y-2">
            <span className="sr-only">Loading blocked reporting areas…</span>
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : blocks.isError ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive">
              Could not load blocked products. No area is being shown as clear.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void blocks.refetch()}
              disabled={blocks.isFetching}
            >
              {blocks.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : blocked.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing is blocked.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Each block names the specific metrics it affects. Other metrics in
              the same product area are unaffected.
            </p>
            <ul className="mt-3 space-y-3">
              {blocked.map((b) => (
                <li
                  key={`${b.product_area}:${b.initiative}`}
                  className="text-sm"
                >
                  <span className="font-medium">{b.product_area}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {b.blocked_note}
                  </span>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {b.metrics.length > 0
                      ? b.metrics.join(", ")
                      : "no metrics named"}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </PageShell>
  );
}
