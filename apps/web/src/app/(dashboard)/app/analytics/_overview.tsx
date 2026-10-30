// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Analytics "Overview" tab: the tenant KPI rollup rendered from
// /api/v1/dashboard/stats, now with period-over-period deltas, per-tile
// sparklines, anomaly flags, engagement rates vs industry benchmarks, revenue,
// inbox health, a recent-activity timeline, and the growth/leaderboard/AI/
// digest widgets. Every color is a theme token so the surface works in light
// and dark; motion (count-up) honors prefers-reduced-motion.

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Inbox,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartSkeleton,
  StatGridSkeleton,
} from "@/components/dashboard/skeletons";
import { Sparkline } from "@/components/dashboard/sparkline";
import { DeltaBadge } from "@/components/dashboard/delta-badge";
import { LayoutCustomizer } from "@/components/dashboard/layout-customizer";
import { CountUp } from "@/components/delight/count-up";
import { computeDelta, type MetricDelta } from "@/lib/dashboard-insights";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";
import {
  getBenchmarks,
  getLayout,
  putLayout,
  type DashboardStats,
} from "@/lib/analytics-api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import {
  computeEngagementRates,
  formatRate,
  reconcileKpiOrder,
} from "@/lib/analytics-format";
import { RevenueTiles } from "@/components/dashboard/revenue-tiles";
import { AnomalyHistoryCard } from "@/components/dashboard/anomaly-history-card";
import { AnalyticsPresentation } from "@/components/analytics/analytics-presentation";
import { CampaignCompareCard } from "@/components/analytics/campaign-compare-card";
import { EngagementTrendPanels } from "@/components/analytics/engagement-trend-panels";
import { GroupedBreakdownCard } from "@/components/analytics/grouped-breakdown-card";
import {
  CampaignPerformancePanel,
  RecentBounceMixPanel,
} from "@/components/analytics/recent-campaign-panels";
import { TopSequenceFunnelPanel } from "@/components/analytics/top-sequence-funnel-panel";
import { useAnalyticsView } from "@/components/analytics/use-analytics-view";
import {
  abortAnalyticsWrite,
  assertAnalyticsSignalActive,
  analyticsAuthorityKey,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
  beginAnalyticsWrite,
  endAnalyticsWrite,
  verifyAnalyticsAuthority,
  type AnalyticsAuthority,
} from "@/lib/analytics-authority";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useOnline } from "@/lib/use-online";

import {
  AiNarrativeCard,
  CampaignLeaderboard,
  DigestSettingsCard,
  SubscriberGrowthChart,
} from "./_analytics-widgets";

export function hasAnalyticsActivity(stats: DashboardStats): boolean {
  return [
    stats.subscribers_total,
    stats.subscribers_added_30d,
    stats.subscribers_unsubbed_30d,
    stats.campaigns_sent_30d,
    stats.opens_total_30d,
    stats.clicks_total_30d,
    stats.bounces_total_30d,
    stats.emails_sent_30d ?? 0,
    stats.active_sequences_count ?? 0,
  ].some((value) => value > 0);
}

interface KpiSpec {
  key: string;
  label: string;
  value: number;
  href: string;
  accent?: boolean;
  tone?: "warn" | "danger";
  delta?: MetricDelta;
  goodDirection?: "up" | "down";
  spark?: number[];
  anomaly?: boolean;
}

function buildKpiSpecs(stats: DashboardStats): KpiSpec[] {
  const prev = stats.previous ?? {};
  const spark = stats.sparklines ?? {};
  const anom = stats.anomalies ?? {};
  return [
    {
      key: "subscribers_total",
      label: "Subscribers (total)",
      value: stats.subscribers_total,
      href: "/app/subscribers",
      accent: true,
      spark: spark.subscribers,
      anomaly: anom.subscribers,
    },
    {
      key: "subscribers_added",
      label: "Added",
      value: stats.subscribers_added_30d,
      href: "/app/subscribers",
      delta: computeDelta(stats.subscribers_added_30d, prev.subscribers_added),
      spark: spark.subscribers,
    },
    {
      key: "subscribers_unsubbed",
      label: "Unsubscribed",
      value: stats.subscribers_unsubbed_30d,
      href: "/app/suppressions",
      tone: "warn",
      goodDirection: "down",
      delta: computeDelta(
        stats.subscribers_unsubbed_30d,
        prev.subscribers_unsubbed,
      ),
    },
    {
      key: "campaigns_sent",
      label: "Campaigns sent",
      value: stats.campaigns_sent_30d,
      href: "/app/campaigns",
      delta: computeDelta(stats.campaigns_sent_30d, prev.campaigns_sent),
    },
    {
      key: "opens",
      label: "Opens",
      value: stats.opens_total_30d,
      href: "/app/campaigns",
      delta: computeDelta(stats.opens_total_30d, prev.opens_total),
      spark: spark.opens,
      anomaly: anom.opens,
    },
    {
      key: "clicks",
      label: "Clicks",
      value: stats.clicks_total_30d,
      href: "/app/campaigns",
      delta: computeDelta(stats.clicks_total_30d, prev.clicks_total),
      spark: spark.clicks,
      anomaly: anom.clicks,
    },
    {
      key: "bounces",
      label: "Bounces",
      value: stats.bounces_total_30d,
      href: "/app/suppressions",
      tone: "danger",
      goodDirection: "down",
      delta: computeDelta(stats.bounces_total_30d, prev.bounces_total),
      spark: spark.bounces,
      anomaly: anom.bounces,
    },
    {
      key: "active_sequences",
      label: "Active sequences",
      value: stats.active_sequences_count ?? 0,
      href: "/app/sequences",
    },
  ];
}

function KpiTile({
  spec,
  compare,
}: {
  spec: KpiSpec;
  /** The "Compare with prior period" toggle (?compare=off hides deltas). */
  compare: boolean;
}) {
  // Danger/warn tone only when the value is non-zero, so a healthy 0 renders in
  // the neutral foreground rather than an alarming red/amber (ANL-016).
  const toned = spec.value > 0;
  const valueClass = spec.accent
    ? "text-primary"
    : spec.tone === "danger" && toned
      ? "text-destructive"
      : spec.tone === "warn" && toned
        ? "text-warning-emphasis"
        : "text-foreground";
  // The value is tied to its label via aria-label (the accessible-name path the
  // finding accepts) since the tile is a link — this reads "Opens, 900" as one
  // node instead of two unassociated visual siblings (ANL-025).
  return (
    <Link
      href={asRoute(spec.href)}
      data-testid="analytics-kpi"
      aria-label={`${spec.label}: ${spec.value.toLocaleString()}${
        spec.anomaly ? " (unusual change flagged)" : ""
      }`}
      className={cn(
        "group flex h-full min-w-0 flex-col rounded-md border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        spec.anomaly && "border-warning/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {spec.label}
          {spec.anomaly ? (
            <TriangleAlert
              className="h-3 w-3 text-warning-emphasis"
              aria-hidden
            />
          ) : null}
        </span>
        {compare && spec.delta ? (
          <DeltaBadge delta={spec.delta} goodDirection={spec.goodDirection} />
        ) : (
          <ArrowRight
            className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span
          aria-hidden
          className={cn(
            "text-2xl font-semibold tabular-nums sm:text-3xl",
            valueClass,
          )}
        >
          <CountUp value={spec.value} />
        </span>
        {spec.spark && spec.spark.length > 1 ? (
          <Sparkline data={spec.spark} className="mb-1 h-7 w-20 shrink-0" />
        ) : null}
      </div>
    </Link>
  );
}

function kpiSummaryText(specs: KpiSpec[]): string {
  return specs.map((s) => `${s.label} ${s.value.toLocaleString()}`).join(", ");
}

// KPI rollup with a persisted custom order + visibility (ANL-034). The backend
// endpoint (GET/PUT /api/v1/dashboard/layout) and the analyticsApi wrappers
// already exist; this wires the UI. Own component so its hooks stay above any
// early return in AnalyticsOverview.
function KpiSection({
  stats,
  tenantId,
  role,
  userId = "unverified",
  viewerMode = false,
}: {
  stats: DashboardStats;
  tenantId: string;
  role: RoleKey;
  userId?: string;
  viewerMode?: boolean;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const { view } = useAnalyticsView();
  const authority: AnalyticsAuthority = {
    tenantId,
    role,
    userId,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
  const authorityKey = authority.authorityKey;
  const layoutKey = [
    ...base("dashboard-layout", tenantId, role),
    ...analyticsIdentitySuffix(authority),
  ];
  const previousLayoutKey = useRef(layoutKey);
  const authorityRef = useRef(authorityKey);
  const attemptRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  useEffect(() => {
    const staleKey = previousLayoutKey.current;
    if (staleKey.join("|") !== layoutKey.join("|")) {
      void queryClient.cancelQueries({ queryKey: staleKey, exact: true });
      queryClient.removeQueries({ queryKey: staleKey, exact: true });
    }
    previousLayoutKey.current = layoutKey;
    authorityRef.current = authorityKey;
    attemptRef.current = null;
    abortAnalyticsWrite();
    return abortAnalyticsWrite;
  }, [authorityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const allSpecs = buildKpiSpecs(stats);
  const allKeys = allSpecs.map((s) => s.key);
  const specByKey = new Map(allSpecs.map((s) => [s.key, s]));

  const layoutQuery = useQuery({
    queryKey: layoutKey,
    queryFn: ({ signal }) => getLayout({ signal }),
    staleTime: STALE.dashboard,
    enabled: analyticsAuthorityReady(authority),
  });
  const visibleKeys = reconcileKpiOrder(allKeys, layoutQuery.data?.order);
  const visibleSpecs = visibleKeys
    .map((k) => specByKey.get(k))
    .filter((s): s is KpiSpec => Boolean(s));

  const save = useMutation({
    mutationFn: async (order: string[]) => {
      if (
        order.length === 0 ||
        new Set(order).size !== order.length ||
        order.some((key) => !allKeys.includes(key))
      ) {
        throw new Error("The analytics layout contains an unknown item.");
      }
      const controller = beginAnalyticsWrite();
      if (!controller) {
        throw new Error("Another analytics change is already in progress.");
      }
      const frozen = [...order];
      Object.freeze(frozen);
      const expected = Object.freeze({ ...authority });
      const fingerprint = JSON.stringify([expected.authorityKey, frozen]);
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = {
          fingerprint,
          idempotencyKey: `analytics-layout:${newUUIDv7()}`,
        };
      }
      const attempt = attemptRef.current;
      if (!attempt) throw new Error("Could not prepare the layout update.");
      try {
        await verifyAnalyticsAuthority(expected, controller.signal);
        await putLayout(frozen, {
          signal: controller.signal,
          idempotencyKey: attempt.idempotencyKey,
        });
        assertAnalyticsSignalActive(controller.signal);
        const confirmed = await getLayout({
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
        assertAnalyticsSignalActive(controller.signal);
        if (
          confirmed.order.length !== frozen.length ||
          confirmed.order.some((key, index) => key !== frozen[index])
        ) {
          throw new Error(
            "The saved analytics layout could not be confirmed. Reload it before making another change.",
          );
        }
        return { authorityKey: expected.authorityKey, layout: confirmed };
      } finally {
        endAnalyticsWrite(controller);
      }
    },
    onSuccess: (result) => {
      if (authorityRef.current !== result.authorityKey) return;
      attemptRef.current = null;
      queryClient.setQueryData(layoutKey, result.layout);
    },
  });

  const customizerDisabled =
    !analyticsAuthorityReady(authority) || viewerMode || online !== "online";
  const customizerDisabledReason = !analyticsAuthorityReady(authority)
    ? "Your identity is still being verified."
    : viewerMode
      ? "Viewer mode is read-only. Exit viewer mode to customize this layout."
      : online !== "online"
        ? "Connect to the internet to customize this layout."
        : undefined;

  return (
    <section aria-labelledby="analytics-kpi-heading" className="space-y-3">
      {/* SR announcement of settled values on refresh (not per count-up frame). */}
      <p className="sr-only" role="status" aria-live="polite">
        Key metrics: {kpiSummaryText(visibleSpecs)}.
      </p>
      <LayoutCustomizer
        items={allSpecs.map(({ key, label }) => ({ key, label }))}
        visibleKeys={visibleKeys}
        description="Show, hide, and reorder your key-metric tiles."
        panelLabel="Customize analytics key metrics"
        leading={
          <h2
            id="analytics-kpi-heading"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Key metrics
          </h2>
        }
        loadError={layoutQuery.isError}
        onReload={() => layoutQuery.refetch()}
        onSave={(order) => save.mutateAsync(order)}
        disabled={customizerDisabled}
        disabledReason={customizerDisabledReason}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {visibleSpecs.map((spec) => (
          <KpiTile key={spec.key} spec={spec} compare={view.compare} />
        ))}
      </div>
    </section>
  );
}

export function AnalyticsOverview({
  stats,
  loading,
  tenantId,
  role,
  range,
  mounted,
  userId = "unverified",
  viewerMode = false,
}: {
  stats: DashboardStats | null;
  loading: boolean;
  tenantId: string;
  role: RoleKey;
  range: string;
  mounted: boolean;
  userId?: string;
  viewerMode?: boolean;
}) {
  const authority = {
    tenantId,
    userId,
    role,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
  if (loading && !stats) {
    return (
      <div className="space-y-6">
        <StatGridSkeleton count={8} className="sm:grid-cols-2 lg:grid-cols-4" />
        <ChartSkeleton />
      </div>
    );
  }
  if (!stats) return null;

  if (!hasAnalyticsActivity(stats)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No analytics yet"
        description="Analytics populate once you have subscribers and start sending. Import your audience and send your first campaign to see opens, clicks, and growth here."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link href="/app/campaigns">Create a campaign</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/app/subscribers/import">Import subscribers</Link>
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <KpiSection
        stats={stats}
        tenantId={tenantId}
        role={role}
        userId={userId}
        viewerMode={viewerMode}
      />

      <AnalyticsPresentation stats={stats} range={range} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <EngagementRatesCard
            stats={stats}
            tenantId={tenantId}
            role={role}
            userId={userId}
            viewerMode={viewerMode}
          />
        </div>
        <InboxHealthCard stats={stats} />
      </div>

      {/* Desktop Overview order: trends, then recent-campaign evidence and
          delivery health, then the top sequence funnel. */}
      <EngagementTrendPanels
        stats={stats}
        range={range}
        tenantId={tenantId}
        role={role}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <CampaignPerformancePanel tenantId={tenantId} role={role} />
        <RecentBounceMixPanel tenantId={tenantId} role={role} />
      </div>

      <TopSequenceFunnelPanel
        tenantId={tenantId}
        role={role}
        userId={userId}
        viewerMode={viewerMode}
      />

      <RevenueTiles
        tenantId={tenantId}
        role={role}
        userId={userId}
        viewerMode={viewerMode}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SubscriberGrowthChart
          tenantId={tenantId}
          role={role}
          userId={userId}
          viewerMode={viewerMode}
          range={range}
        />
        <CampaignLeaderboard
          tenantId={tenantId}
          role={role}
          userId={userId}
          viewerMode={viewerMode}
        />
      </div>

      <GroupedBreakdownCard
        tenantId={tenantId}
        role={role}
        userId={userId}
        range={range}
      />

      <CampaignCompareCard
        tenantId={tenantId}
        role={role}
        userId={userId}
        viewerMode={viewerMode}
      />

      <AnomalyHistoryCard tenantId={tenantId} role={role} userId={userId} />

      <div className="grid gap-4 lg:grid-cols-2">
        <AiNarrativeCard stats={stats} range={range} authority={authority} />
        <DigestSettingsCard
          tenantId={tenantId}
          role={role}
          userId={userId}
          viewerMode={viewerMode}
        />
      </div>

      <ActivityTimeline stats={stats} mounted={mounted} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagement rates vs benchmarks (ANL-010 + ANL-029)
// ---------------------------------------------------------------------------

const BENCHMARK_METRIC: Record<string, string> = {
  open: "opens",
  click: "clicks",
  bounce: "bounces",
  unsub: "unsubs",
};

function EngagementRatesCard({
  stats,
  tenantId,
  role,
  userId,
  viewerMode,
}: {
  stats: DashboardStats;
  tenantId: string;
  role: RoleKey;
  userId: string;
  viewerMode: boolean;
}) {
  const rates = computeEngagementRates(stats);
  const authority: AnalyticsAuthority = {
    tenantId,
    role,
    userId,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
  const benchmarksQuery = useQuery({
    queryKey: [
      ...base("benchmarks", tenantId, role),
      ...analyticsIdentitySuffix(authority),
    ],
    queryFn: ({ signal }) => getBenchmarks({ signal }),
    enabled: analyticsAuthorityReady(authority),
    staleTime: STALE.reference,
  });
  const benchmarkByMetric = new Map(
    (Array.isArray(benchmarksQuery.data?.rows)
      ? benchmarksQuery.data?.rows
      : []
    ).map((r) => [r.metric, r.average]),
  );

  const tiles: Array<{
    id: string;
    label: string;
    rate: number | null;
    goodDirection: "up" | "down";
  }> = [
    {
      id: "open",
      label: "Open rate",
      rate: rates.openRate,
      goodDirection: "up",
    },
    {
      id: "click",
      label: "Click rate",
      rate: rates.clickRate,
      goodDirection: "up",
    },
    {
      id: "ctor",
      label: "Click-to-open",
      rate: rates.clickToOpen,
      goodDirection: "up",
    },
    {
      id: "bounce",
      label: "Bounce rate",
      rate: rates.bounceRate,
      goodDirection: "down",
    },
    {
      id: "unsub",
      label: "Unsub rate",
      rate: rates.unsubRate,
      goodDirection: "down",
    },
  ];

  const hasAnyRate = tiles.some((t) => t.rate !== null);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Engagement rates</CardTitle>
        <CardDescription>
          Computed from distinct-recipient counts
          {benchmarksQuery.data?.note ? ` · ${benchmarksQuery.data.note}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasAnyRate ? (
          <p className="text-sm text-muted-foreground">
            Rates appear once you have delivered sends in this window.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tiles.map((t) => {
              const benchKey = BENCHMARK_METRIC[t.id];
              const bench = benchKey
                ? benchmarkByMetric.get(benchKey)
                : undefined;
              let vs: { good: boolean; label: string } | null = null;
              if (t.rate !== null && typeof bench === "number") {
                const better =
                  t.goodDirection === "up" ? t.rate >= bench : t.rate <= bench;
                vs = { good: better, label: `${formatRate(bench)} avg` };
              }
              return (
                <div key={t.id} className="rounded-md border bg-card px-3 py-2">
                  <dt className="text-[11px] font-medium uppercase text-muted-foreground">
                    {t.label}
                  </dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">
                    {formatRate(t.rate)}
                  </dd>
                  {vs ? (
                    <div
                      className={cn(
                        "mt-0.5 text-[10px] tabular-nums",
                        vs.good ? "text-success" : "text-warning-emphasis",
                      )}
                    >
                      {vs.good ? "▲" : "▼"} {vs.label}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Revenue tiles (ANL-015)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inbox health (ANL-027)
// ---------------------------------------------------------------------------

function InboxHealthCard({ stats }: { stats: DashboardStats }) {
  const health = stats.inbox_health;
  const score = typeof health?.score === "number" ? health.score : null;
  if (!health || (score === null && !health.state)) return null;
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle>Inbox health</CardTitle>
        </div>
        <CardDescription>
          Deliverability signal for your sending.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {score !== null ? score : "—"}
          </span>
          {health.state ? (
            <Badge
              variant={score !== null && score < 70 ? "warning" : "success"}
            >
              {health.state}
            </Badge>
          ) : null}
        </div>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link href="/app/inbox-reality">Open Inbox Reality</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent activity timeline (ANL-028)
// ---------------------------------------------------------------------------

function ActivityTimeline({
  stats,
  mounted,
}: {
  stats: DashboardStats;
  mounted: boolean;
}) {
  const rows = stats.recent_audit ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle>Recent activity</CardTitle>
        </div>
        <CardDescription>
          The latest events across your workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No recent activity yet"
            description="Sends, imports, and edits will appear here as they happen."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((row, i) => (
              <li
                key={row.id ?? `${row.action}-${i}`}
                className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {row.description || row.action || "Activity"}
                  </span>
                  {row.actor ? (
                    <span className="truncate text-muted-foreground">
                      {row.actor}
                    </span>
                  ) : null}
                </span>
                {row.at ? (
                  <span
                    className="shrink-0 text-muted-foreground tabular-nums"
                    title={mounted ? absoluteTime(row.at) : undefined}
                  >
                    {mounted ? timeAgo(row.at) : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
