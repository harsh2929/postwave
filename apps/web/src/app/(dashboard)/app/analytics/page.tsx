// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant-level analytics dashboard. Overview renders the rollup from
// /api/v1/dashboard/stats (deltas, sparklines, anomalies, rates, revenue,
// inbox health, charts, leaderboard, AI narrative, digest); Campaign and
// Audience tabs hold the management panels. Range, refresh, export, and the
// active tab are reflected in the URL for deep-linking (ANL-007/035/039).
"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { AnalyticsExportMenu } from "@/components/analytics/export-menu";
import { PageShell } from "@/components/dashboard/page-shell";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  analyticsApi,
  DASHBOARD_LIVE_PATH,
  type DashboardStats,
} from "@/lib/analytics-api";
import { whenStreamsMayOpen } from "@/lib/realtime/stream-gate";
import { whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import {
  abortAnalyticsWrite,
  analyticsAuthorityFrom,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
} from "@/lib/analytics-authority";
import { cn } from "@/lib/utils";
import { downloadTextFile } from "@/lib/download";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  buildStatsCsv,
  normalizeRange,
  RANGE_OPTIONS,
  rangeDays,
  rangeSubtitle,
  type RangeValue,
} from "@/lib/analytics-format";

const AnalyticsOverview = dynamic(
  () => import("./_overview").then((module) => module.AnalyticsOverview),
  { loading: () => <AnalyticsPanelFallback title="Overview" /> },
);

// The saved-views menu (its dialogs, the saved-views store, and its own
// identity read) is a header utility rather than report content; it loads
// after first paint so the route's eager chunk stays inside the bundle budget.
// The fallback holds the trigger's footprint so the toolbar does not reflow.
const SavedViewsMenu = dynamic(
  () =>
    import("@/components/analytics/saved-views-menu").then(
      (mod) => mod.SavedViewsMenu,
    ),
  {
    loading: () => (
      <Skeleton
        className="h-11 w-24 sm:h-8"
        role="status"
        aria-label="Loading saved views"
      />
    ),
  },
);

const CampaignIntelligencePanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/campaign-intelligence-panel").then(
      (mod) => mod.CampaignIntelligencePanel,
    ),
  { loading: () => <AnalyticsPanelFallback title="Campaign intelligence" /> },
);

const HumanEngagedReachPanel = dynamic(
  () =>
    import("@/components/analytics/human-engaged-reach-panel").then(
      (mod) => mod.HumanEngagedReachPanel,
    ),
  { loading: () => <AnalyticsPanelFallback title="Human-engaged reach" /> },
);

const CampaignPerformancePanel = dynamic(
  () =>
    import("@/components/analytics/recent-campaign-panels").then(
      (mod) => mod.CampaignPerformancePanel,
    ),
  { loading: () => <AnalyticsPanelFallback title="Campaign performance" /> },
);

const RecentCampaignAudiencePanels = dynamic(
  () =>
    import("@/components/analytics/recent-campaign-panels").then(
      (mod) => mod.RecentCampaignAudiencePanels,
    ),
  {
    loading: () => <AnalyticsPanelFallback title="Recent campaign audience" />,
  },
);

const AudienceIntelligencePanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/audience-intelligence-panel").then(
      (mod) => mod.AudienceIntelligencePanel,
    ),
  { loading: () => <AnalyticsPanelFallback title="Audience intelligence" /> },
);

const AnalyticsLifecycleRevenuePanel = dynamic(
  () =>
    import("@/components/analytics/lifecycle-revenue-panel").then(
      (mod) => mod.AnalyticsLifecycleRevenuePanel,
    ),
  { loading: () => <AnalyticsPanelFallback title="Lifecycle and revenue" /> },
);

const TAB_VALUES = [
  "overview",
  "campaign",
  "audience",
  "reach",
  "lifecycle",
] as const;
type TabValue = (typeof TAB_VALUES)[number];

function parseTabValue(value: string | null): TabValue {
  return TAB_VALUES.find((tabValue) => tabValue === value) ?? "overview";
}

export default function AnalyticsPage() {
  // Range + tab are client-only URL state. Read from the URL on mount (so a
  // deep link restores them) and keep a stable placeholder for the relative
  // "updated" stamp until mounted, avoiding an SSR/client mismatch.
  const [mounted, setMounted] = useState(false);
  const [range, setRange] = useState<RangeValue>("30d");
  const [tab, setTab] = useState<TabValue>("overview");

  const queryClient = useQueryClient();

  useEffect(() => {
    setMounted(true);

    const syncFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setRange(normalizeRange(params.get("range")));
      setTab(parseTabValue(params.get("tab")));
    };

    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  function syncUrl(
    next: { range?: RangeValue; tab?: TabValue },
    mode: "push" | "replace" = "replace",
  ) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const { searchParams: params } = url;
    if (next.range) {
      if (next.range === "30d") params.delete("range");
      else params.set("range", next.range);
    }
    if (next.tab) {
      if (next.tab === "overview") params.delete("tab");
      else params.set("tab", next.tab);
    }
    const href = `${url.pathname}${url.search}${url.hash}`;
    const currentHref =
      `${window.location.pathname}${window.location.search}` +
      window.location.hash;
    if (href === currentHref) return;

    if (mode === "push") {
      window.history.pushState(window.history.state, "", href);
    } else {
      window.history.replaceState(window.history.state, "", href);
    }
  }

  const changeRange = (value: string) => {
    const r = normalizeRange(value);
    setRange(r);
    syncUrl({ range: r });
  };
  const changeTab = (value: string) => {
    const t = parseTabValue(value);
    setTab(t);
    syncUrl({ tab: t }, "push");
  };

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const authority = analyticsAuthorityFrom(meQuery.data);
  const { tenantId, role, userId, viewerMode, authorityKey } = authority;
  const identitySuffix = useMemo(
    () => analyticsIdentitySuffix(authority),
    // The helper only consumes these two primitive identity fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, viewerMode],
  );

  // Share the "stats" key with the home dashboard on the default 30d window so
  // the two surfaces dedupe to one request; non-default ranges get their own
  // cache entry so per-range caching stays correct (ANL-007).
  const statsKey = useMemo(
    () =>
      qk
        .dashboard(tenantId, role, range === "30d" ? "stats" : `stats:${range}`)
        .concat(identitySuffix),
    [identitySuffix, range, role, tenantId],
  );
  const previousAuthorityRef = useRef(authority);
  useEffect(() => {
    const previous = previousAuthorityRef.current;
    if (previous.authorityKey !== authorityKey) {
      abortAnalyticsWrite();
      const previousSuffix = analyticsIdentitySuffix(previous);
      const predicate = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[1] === previous.tenantId &&
        query.queryKey.includes(previousSuffix[0]) &&
        query.queryKey.includes(previousSuffix[1]);
      void queryClient.cancelQueries({ predicate });
      queryClient.removeQueries({ predicate });
    }
    previousAuthorityRef.current = authority;
    return () => {
      abortAnalyticsWrite();
    };
    // `authorityKey` changes for every field represented by `authority`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey, queryClient]);
  const statsQuery = useQuery({
    queryKey: statsKey,
    queryFn: ({ signal }) => analyticsApi.dashboardStats({ signal, range }),
    enabled: meQuery.isSuccess && analyticsAuthorityReady(authority),
    staleTime: STALE.dashboard,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const stats = statsQuery.data ?? null;
  const error = statsQuery.isError
    ? statsQuery.error instanceof Error
      ? statsQuery.error.message
      : "Could not load analytics — this is a failed request, not an empty result."
    : null;

  const loading = meQuery.isLoading || (statsQuery.isPending && !stats);

  // Near-real-time updates via the dashboard SSE stream, writing snapshots into
  // the shared 30d cache; if the stream errors/closes we fall back to the 60s
  // poll (still active). Only wired for the default window (the stream + shared
  // cache key are 30d) — ANL-030.
  useEffect(() => {
    if (!mounted || !analyticsAuthorityReady(authority) || range !== "30d")
      return;
    if (typeof window === "undefined" || typeof EventSource === "undefined")
      return;
    let es: EventSource | null = null;
    let active = true;
    const expectedAuthorityKey = authorityKey;
    const onStats = (ev: MessageEvent) => {
      if (!active || expectedAuthorityKey !== authorityKey) return;
      try {
        const data = JSON.parse(ev.data) as DashboardStats;
        queryClient.setQueryData(statsKey, data);
      } catch {
        /* ignore malformed frames */
      }
    };
    // Opens through lib/realtime/stream-gate.ts: an EventSource is a
    // high-priority request, and on a link Chrome rates as slow it queues ahead
    // of the lazy chunks and queries this page needs to become interactive. The
    // 60s poll above is the source of truth until then.
    const cancelPendingOpen = whenStreamsMayOpen(() => {
      if (!active) return;
      try {
        es = new EventSource(DASHBOARD_LIVE_PATH, { withCredentials: true });
      } catch {
        return;
      }
      es.addEventListener("stats", onStats as EventListener);
      es.onerror = () => {
        es?.close();
      };
    });
    return () => {
      active = false;
      cancelPendingOpen();
      es?.close();
    };
    // `authorityKey` covers the primitive identity fields read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey, mounted, queryClient, range, statsKey]);

  const [manualRefreshing, setManualRefreshing] = useState(false);
  function refreshAll() {
    setManualRefreshing(true);
    void queryClient
      .invalidateQueries({
        refetchType: "active",
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey[1] === tenantId,
      })
      .finally(() => setManualRefreshing(false));
  }

  function exportCsv() {
    if (!stats) return;
    downloadTextFile(
      `analytics-${range}.csv`,
      buildStatsCsv(stats, range),
      "text/csv;charset=utf-8",
    );
  }

  const lastUpdated =
    statsQuery.dataUpdatedAt > 0
      ? new Date(statsQuery.dataUpdatedAt).toISOString()
      : null;

  return (
    <PageShell
      tourTarget="dashboard-analytics-overview"
      className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold mb-2 tracking-tight">
            Analytics
          </h1>
          <p className="text-muted-foreground text-sm">
            {rangeSubtitle(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SavedViewsMenu />
          <Select
            aria-label="Date range"
            className="w-28"
            value={range}
            disabled={!mounted}
            onChange={(e) => changeRange(e.target.value)}
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <span
            data-testid="analytics-last-updated"
            data-updated-at={mounted && lastUpdated ? lastUpdated : undefined}
            title={
              mounted && lastUpdated ? absoluteTime(lastUpdated) : undefined
            }
            className="min-w-0 truncate text-xs text-muted-foreground tabular-nums"
          >
            {mounted && lastUpdated
              ? `Updated ${timeAgo(lastUpdated)}`
              : "Updated …"}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={refreshAll}
            disabled={manualRefreshing}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4 motion-reduce:animate-none",
                manualRefreshing && "animate-spin",
              )}
              aria-hidden
            />
            {manualRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <AnalyticsExportMenu onExportCsv={exportCsv} csvDisabled={!stats} />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 flex flex-col items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 sm:flex-row sm:items-center"
        >
          <span className="text-destructive text-sm">{error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void statsQuery.refetch()}
            disabled={statsQuery.isFetching}
          >
            {statsQuery.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList aria-label="Analytics report view">
          <TabsTrigger value="overview" disabled={!mounted}>
            Overview
          </TabsTrigger>
          <TabsTrigger value="campaign" disabled={!mounted}>
            Campaign
          </TabsTrigger>
          <TabsTrigger value="audience" disabled={!mounted}>
            Audience
          </TabsTrigger>
          <TabsTrigger value="reach" disabled={!mounted}>
            Reach
          </TabsTrigger>
          <TabsTrigger value="lifecycle" disabled={!mounted}>
            Lifecycle &amp; revenue
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-6">
          <AnalyticsOverview
            stats={stats}
            loading={loading}
            tenantId={tenantId}
            role={role}
            range={range}
            mounted={mounted}
            userId={userId}
            viewerMode={viewerMode}
          />
        </TabsContent>
        <TabsContent value="campaign" className="mt-6 space-y-6">
          <CampaignPerformancePanel tenantId={tenantId} role={role} />
          <CampaignIntelligencePanel />
        </TabsContent>
        <TabsContent value="audience" className="mt-6 space-y-6">
          <RecentCampaignAudiencePanels tenantId={tenantId} role={role} />
          <AudienceIntelligencePanel />
        </TabsContent>
        <TabsContent value="reach" className="mt-6">
          <HumanEngagedReachPanel days={rangeDays(range) as 7 | 30 | 90} />
        </TabsContent>
        <TabsContent value="lifecycle" className="mt-6">
          <AnalyticsLifecycleRevenuePanel
            tenantId={tenantId}
            role={role}
            days={rangeDays(range)}
          />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function AnalyticsPanelFallback({ title }: { title: string }) {
  return (
    <section
      className="rounded-lg border border-border bg-card p-6"
      aria-busy="true"
    >
      <div className="mb-4 space-y-2">
        <div className="text-lg font-semibold">{title}</div>
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </section>
  );
}
