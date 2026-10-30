// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarClock,
  Filter,
  Inbox,
  Megaphone,
  RefreshCw,
  Sparkles,
  TrendingDown,
  Upload,
} from "lucide-react";

import {
  isOnboardingProgress,
  type OnboardingProgress,
} from "@postwave/onboarding-schema";

import { api } from "@/lib/api";
import { whoami, type MeResponse } from "@/lib/auth-api";
// `@/lib/audit-api`, `@/lib/analytics-api` and `@/lib/dashboard-activity` are
// only called inside query/mutation functions, so they are `await import`ed at
// the call site and stay out of the eager route graph (bundle budget). Only
// their types are needed at module scope.
import type { DashboardStats } from "@/lib/analytics-api";
import { reconcileKpiOrder } from "@/lib/analytics-format";
import { analyticsMetricHref } from "@/lib/analytics-view-params";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/lib/dashboard-activity";
import {
  computeDelta,
  deriveRecommendations,
  type MetricDelta,
} from "@/lib/dashboard-insights";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  abortAnalyticsWrite,
  assertAnalyticsSignalActive,
  analyticsAuthorityFrom,
  analyticsAuthorityReady,
  analyticsIdentitySuffix,
  beginAnalyticsWrite,
  endAnalyticsWrite,
  verifyAnalyticsAuthority,
} from "@/lib/analytics-authority";
import { newUUIDv7 } from "@/lib/http-fetch";
import { useOnline } from "@/lib/use-online";
import { campaignStatusVariant } from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import type { CampaignStatus } from "@/lib/campaigns-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatGridSkeleton } from "@/components/dashboard/skeletons";
import { Sparkline } from "@/components/dashboard/sparkline";
import { DeltaBadge } from "@/components/dashboard/delta-badge";
import { DashboardLiveBar } from "@/components/dashboard/dashboard-live";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { ForecastStrip } from "@/components/dashboard/forecast-strip";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Secondary home surfaces are split out of the eager route graph so the page
// stays under the dashboard bundle budget. Each fallback keeps the silhouette
// of the control it stands in for and announces itself as loading, so the
// header does not jump and the page reads as unsettled until the chunk lands.
const LayoutCustomizer = dynamic(
  () =>
    import("@/components/dashboard/layout-customizer").then(
      (module) => module.LayoutCustomizer,
    ),
  {
    loading: () => (
      <div
        className="w-full min-w-0"
        role="status"
        aria-label="Loading layout controls"
      >
        <div className="flex min-w-0 items-center justify-end">
          <Skeleton className="h-11 w-28 sm:h-8" />
        </div>
      </div>
    ),
  },
);

const ShareSnapshotButton = dynamic(
  () =>
    import("@/components/dashboard/share-snapshot-button").then(
      (module) => module.ShareSnapshotButton,
    ),
  {
    loading: () => (
      <Skeleton
        className="h-11 w-36 sm:h-9"
        role="status"
        aria-label="Loading share snapshot"
      />
    ),
  },
);

// Both pinned cards are mount-gated below and render nothing at all for
// tenants without their data, so an empty fallback is exactly the silhouette
// they already had while the page hydrated.
const RevenueTiles = dynamic(
  () =>
    import("@/components/dashboard/revenue-tiles").then(
      (module) => module.RevenueTiles,
    ),
  { loading: () => null },
);

const ResumeCard = dynamic(
  () => import("@/components/resume-card").then((module) => module.ResumeCard),
  { loading: () => null },
);

// OVR-032: the home dashboard's reorderable/hideable widgets, in default order.
// Keys mirror the backend defaultLayoutOrders["home"]; ordering + visibility
// persist per-user via dashboard_layouts (surface="home"). RevenueTiles and the
// resume card are pinned (contextual, always at the top) and not listed here.
const HOME_WIDGETS: { key: string; label: string }[] = [
  { key: "performance", label: "Performance snapshot" },
  { key: "stats", label: "Headline counts" },
  { key: "recommendations", label: "Recommendations" },
  { key: "checklist", label: "Onboarding checklist" },
  { key: "upcoming", label: "Upcoming sends" },
  { key: "campaigns", label: "Recent campaigns" },
  { key: "activity", label: "Activity" },
  { key: "status", label: "System status" },
];
const HOME_WIDGET_KEYS = HOME_WIDGETS.map((widget) => widget.key);

const OnboardingChecklist = lazy(() =>
  import("@/components/onboarding/OnboardingChecklist").then((module) => ({
    default: module.OnboardingChecklist,
  })),
);

/**
 * Content-shaped loading fallback for the onboarding checklist. Mirrors the
 * real silhouette (progress ring + three goal rows) and is built from the
 * shared <Skeleton>, so it honours prefers-reduced-motion instead of the raw
 * `animate-pulse` box it replaced (OVR-026).
 */
function OnboardingChecklistSkeleton() {
  return (
    <section
      aria-label="Getting started checklist loading"
      className="overflow-hidden rounded-lg border bg-card"
      data-tour="dashboard-onboarding"
    >
      <div className="flex items-center gap-4 border-b px-5 py-4">
        <Skeleton className="h-[52px] w-[52px] rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="divide-y">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-3.5">
            <Skeleton className="h-6 w-6 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A few shimmer rows for a card body while its list loads (OVR-013). */
function CardRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}

type HealthState =
  | { status: "loading" }
  | { status: "ok"; payload: unknown }
  | { status: "error"; message: string };

interface DashboardStat {
  label: string;
  value: string;
  href: string;
}

interface DashboardCampaign {
  id: string;
  name: string;
  status: string;
  scheduledAt: string | null;
}

type CampaignsResponse = RawCampaign[] | { items?: RawCampaign[] };

interface RawCampaign {
  id?: string;
  name?: string;
  status?: string;
  scheduled_at?: string | null;
}

interface DashboardOverviewData {
  stats: DashboardStat[];
  campaigns: DashboardCampaign[];
  upcoming: DashboardCampaign[];
  activity: ActivityItem[];
  dashboardError: string | null;
  activityError: string | null;
  activityRestricted: boolean;
  /** True only when the campaigns list request itself failed (OVR-001). */
  campaignsError: boolean;
  refreshedAt: string;
}

// The verbose health probe (ports, proxy detail, raw JSON payload) is ops/dev
// debug content, not a customer-facing surface. It now requires an EXPLICIT
// opt-in flag — it no longer turns on automatically for every non-production
// build, so infra detail never sits on the customer's first screen by default
// (OVR-029).
const SHOW_HEALTH_DEBUG = process.env.NEXT_PUBLIC_SHOW_HEALTH_DEBUG === "1";

function normalizeCampaigns(
  payload: CampaignsResponse | null,
): DashboardCampaign[] {
  const rows = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((c): c is RawCampaign => !!c && typeof c.id === "string")
    .map((c) => ({
      id: c.id as string,
      name: c.name || "Untitled campaign",
      status: c.status || "unknown",
      scheduledAt: c.scheduled_at ?? null,
    }));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

// How many activity rows the dashboard shows, and how many audit rows we ask
// for to fill them. The gap absorbs the `http.*` request-log rows the audit
// middleware writes for every request, which never reach the feed.
const ACTIVITY_FEED_ROWS = 8;
const ACTIVITY_FEED_FETCH_LIMIT = 100;

// Lightweight overview fetch: subscribers + campaigns counts via existing list
// APIs, recent + upcoming campaigns via a bounded list request, and real
// activity via the audit log. Failures are surfaced honestly and tracked
// per-source so the UI can distinguish an empty account from a failed request.
async function fetchDashboardOverview({
  signal,
  includeActivity = true,
}: {
  signal?: AbortSignal;
  includeActivity?: boolean;
} = {}): Promise<DashboardOverviewData> {
  throwIfAborted(signal);
  const [subsResult, campaignsResult, campaignsCountResult, activityResult] =
    await Promise.allSettled([
      api.get<{ total?: number; items?: unknown[] }>(
        "/api/v1/subscribers?page=1&per_page=1",
        { signal },
      ),
      api.get<CampaignsResponse>("/api/v1/campaigns?limit=10", { signal }),
      api.get<{ total: number; by_status: Record<string, number> }>(
        "/api/v1/campaigns/count",
        { signal },
      ),
      // Over-fetch on purpose. `buildActivityItems` drops the audit
      // middleware's own `http.*` request-log rows CLIENT-side, and the API
      // has no server-side exclusion for them, so asking for exactly the
      // number of rows we render made the feed collapse to its empty state
      // whenever the newest rows happened to be plumbing — which is the
      // common case, since every page view writes one. Fetch a window wide
      // enough to survive that and trim to ACTIVITY_FEED_ROWS below.
      includeActivity
        ? import("@/lib/audit-api").then(({ listAuditLog }) =>
            listAuditLog({ limit: ACTIVITY_FEED_FETCH_LIMIT }, { signal }),
          )
        : Promise.resolve(null),
    ]);
  throwIfAborted(signal);

  const subs = subsResult.status === "fulfilled" ? subsResult.value : null;
  const campaignRows =
    campaignsResult.status === "fulfilled"
      ? normalizeCampaigns(campaignsResult.value)
      : [];
  const campaignsError = campaignsResult.status === "rejected";
  const counts =
    campaignsCountResult.status === "fulfilled"
      ? campaignsCountResult.value
      : null;
  const totalSubs = subs?.total ?? subs?.items?.length ?? 0;
  const totalCamps = counts?.total;
  const sentCamps = counts?.by_status?.sent;

  const activityError =
    includeActivity && activityResult.status === "rejected"
      ? "Recent activity could not be loaded. Other data above is up to date."
      : null;
  const activityRows =
    includeActivity &&
    activityResult.status === "fulfilled" &&
    activityResult.value &&
    Array.isArray(activityResult.value.rows)
      ? activityResult.value.rows
      : [];
  const activity =
    includeActivity && activityResult.status === "fulfilled"
      ? (await import("@/lib/dashboard-activity"))
          .buildActivityItems(activityRows)
          .slice(0, ACTIVITY_FEED_ROWS)
      : [];

  const dashboardError =
    subsResult.status === "rejected" ||
    campaignsResult.status === "rejected" ||
    campaignsCountResult.status === "rejected"
      ? "Some dashboard data could not be loaded. Showing only confirmed values."
      : null;

  const upcoming = campaignRows
    .filter((c) => c.status === "scheduled" && c.scheduledAt)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt as string).getTime() -
        new Date(b.scheduledAt as string).getTime(),
    )
    .slice(0, 5);

  return {
    stats: [
      {
        label: "Subscribers",
        value: totalSubs.toLocaleString(),
        href: "/app/subscribers",
      },
      {
        label: "Campaigns",
        value: totalCamps == null ? "—" : totalCamps.toLocaleString(),
        href: "/app/campaigns",
      },
      {
        label: "Sent",
        value: sentCamps == null ? "—" : sentCamps.toLocaleString(),
        href: "/app/analytics",
      },
    ],
    campaigns: campaignRows.slice(0, 5),
    upcoming,
    activity,
    activityError,
    activityRestricted: !includeActivity,
    campaignsError,
    dashboardError,
    refreshedAt: new Date().toISOString(),
  };
}

/** First-name-ish greeting token derived from the signed-in email local part. */
function greetingName(me: MeResponse | undefined): string | null {
  const local = me?.email?.split("@")[0]?.trim();
  if (!local) return null;
  const first = local.split(/[._-]+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export default function OverviewPage() {
  // "Last updated" and every relative timestamp are client-only notions (the
  // server's clock/locale don't match the user's). Gate their display on mount
  // so SSR emits a stable placeholder and the real time only renders on the
  // client, avoiding a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const queryClient = useQueryClient();
  const online = useOnline();

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
  const identityReady = meQuery.isSuccess && analyticsAuthorityReady(authority);
  const canCreate = identityReady && role !== "viewer" && viewerMode === false;
  const canReadActivity =
    identityReady && (role === "owner" || role === "admin") && !viewerMode;

  const overviewKey = useMemo(
    () => qk.dashboard(tenantId, role, "overview").concat(identitySuffix),
    [identitySuffix, role, tenantId],
  );
  const statsKey = useMemo(
    () => qk.dashboard(tenantId, role, "stats").concat(identitySuffix),
    [identitySuffix, role, tenantId],
  );
  const progressKey = useMemo(
    () => qk.onboardingProgress(tenantId, role).concat(identitySuffix),
    [identitySuffix, role, tenantId],
  );
  const layoutKey = useMemo(
    () => base("dashboard-layout-home", tenantId, role).concat(identitySuffix),
    [identitySuffix, role, tenantId],
  );

  const previousScopedKeysRef = useRef([
    overviewKey,
    statsKey,
    progressKey,
    layoutKey,
  ]);
  useEffect(() => {
    const previousKeys = previousScopedKeysRef.current;
    const currentKeys = [overviewKey, statsKey, progressKey, layoutKey];
    for (let index = 0; index < previousKeys.length; index += 1) {
      const previousKey = previousKeys[index];
      const currentKey = currentKeys[index];
      if (
        previousKey &&
        currentKey &&
        previousKey.join("|") !== currentKey.join("|")
      ) {
        void queryClient.cancelQueries({ queryKey: previousKey, exact: true });
        queryClient.removeQueries({ queryKey: previousKey, exact: true });
      }
    }
    previousScopedKeysRef.current = currentKeys;
    abortAnalyticsWrite();
    return abortAnalyticsWrite;
    // `authorityKey` represents every identity field used by these keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey, queryClient]);

  const overviewQuery = useQuery({
    queryKey: overviewKey,
    queryFn: ({ signal }) =>
      fetchDashboardOverview({ signal, includeActivity: canReadActivity }),
    enabled: identityReady,
    staleTime: STALE.dashboard,
    // Auto-refresh so the landing dashboard doesn't silently go stale; matches
    // the analytics page's cadence. Paused while the tab is backgrounded
    // (OVR-024).
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  // Rich, period-aware performance payload — shared cache key with the
  // analytics page so the two surfaces dedupe to one request (OVR-007/021/023).
  const statsQuery = useQuery({
    queryKey: statsKey,
    queryFn: async ({ signal }) => {
      const { analyticsApi } = await import("@/lib/analytics-api");
      return analyticsApi.dashboardStats({ signal });
    },
    enabled: identityReady,
    staleTime: STALE.dashboard,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  // Onboarding progress powers the greeting; shares the checklist's cache key
  // so it is fetched once (OVR-018).
  const progressQuery = useQuery({
    queryKey: progressKey,
    queryFn: async ({ signal }): Promise<OnboardingProgress | null> => {
      const payload = await api.get<unknown>("/api/v1/onboarding-progress", {
        signal,
      });
      return isOnboardingProgress(payload) ? payload : null;
    },
    enabled: identityReady,
    staleTime: 60_000,
  });

  // Health probe as a real query so Refresh can re-run it and a one-off 5xx
  // auto-recovers instead of sticking until a full page reload (OVR-015).
  const healthQuery = useQuery({
    queryKey: ["dashboard", "health"],
    queryFn: ({ signal }) => api.get("/api/health", { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const health: HealthState = healthQuery.isPending
    ? { status: "loading" }
    : healthQuery.isError
      ? {
          status: "error",
          message:
            healthQuery.error instanceof Error
              ? healthQuery.error.message
              : "Unknown error",
        }
      : { status: "ok", payload: healthQuery.data };

  const overview = overviewQuery.data;
  const campaigns = overview?.campaigns ?? [];
  const upcoming = overview?.upcoming ?? [];
  const activity = overview?.activity ?? [];
  const dashboardError =
    overview?.dashboardError ??
    (overviewQuery.error instanceof Error
      ? overviewQuery.error.message
      : overviewQuery.isError
        ? "Could not load your dashboard — this is a failed request, not a workspace with nothing in it."
        : null);

  const activityError = overview?.activityError ?? null;
  const activityRestricted = overview?.activityRestricted ?? !canReadActivity;
  const lastUpdated = overview?.refreshedAt ?? null;

  const stats = statsQuery.data ?? null;
  const recommendations = useMemo(() => deriveRecommendations(stats), [stats]);

  const progress = progressQuery.data ?? null;
  const setupStarted =
    (progress?.completed ?? 0) > 0 || (progress?.all_done ?? false);
  const name = greetingName(meQuery.data);
  const heading = setupStarted
    ? name
      ? `Welcome back, ${name}`
      : "Welcome back"
    : "Welcome to Moosewave";
  const subtitle = setupStarted
    ? "Here's what's happening across your workspace."
    : "Three steps and you're sending newsletters that land in the inbox.";

  // Distinct from overviewQuery.isFetching: that flips true on every 60s
  // background poll (OVR-024), which would make the Refresh button spin,
  // disable, and say "Refreshing…" once a minute unprompted. This flag tracks
  // only an explicit user-triggered refresh so the affordance reflects intent.
  const [manualRefreshing, setManualRefreshing] = useState(false);
  function refreshAll(): void {
    if (!identityReady || manualRefreshing) return;
    setManualRefreshing(true);
    void Promise.allSettled([
      overviewQuery.refetch(),
      statsQuery.refetch(),
      healthQuery.refetch(),
      progressQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: qk.notificationFeed(tenantId, role),
        exact: true,
      }),
    ]).finally(() => setManualRefreshing(false));
  }

  // OVR-032: per-user home widget order + visibility, persisted via the shared
  // dashboard_layouts store (surface="home"). Widgets render in this order and
  // hidden ones are dropped; the layout falls back to the full default set when
  // nothing is saved (or the fetch fails) — reconcileKpiOrder handles both.
  const layoutQuery = useQuery({
    queryKey: layoutKey,
    queryFn: async ({ signal }) => {
      const { getLayout } = await import("@/lib/analytics-api");
      return getLayout({ signal, surface: "home" });
    },
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });
  const visibleWidgetKeys = reconcileKpiOrder(
    HOME_WIDGET_KEYS,
    layoutQuery.data?.order,
  );
  const layoutAuthorityRef = useRef(authorityKey);
  const layoutAttemptRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  useEffect(() => {
    layoutAuthorityRef.current = authorityKey;
    layoutAttemptRef.current = null;
  }, [authorityKey]);
  const saveLayout = useMutation({
    mutationFn: async (order: string[]) => {
      if (
        order.length === 0 ||
        new Set(order).size !== order.length ||
        order.some((key) => !HOME_WIDGET_KEYS.includes(key))
      ) {
        throw new Error("The home layout contains an unknown item.");
      }
      const { getLayout, putLayout } = await import("@/lib/analytics-api");
      const controller = beginAnalyticsWrite();
      if (!controller) {
        throw new Error("Another analytics change is already in progress.");
      }
      const expected = Object.freeze({ ...authority });
      const frozen = [...order];
      Object.freeze(frozen);
      const fingerprint = JSON.stringify([expected.authorityKey, frozen]);
      if (layoutAttemptRef.current?.fingerprint !== fingerprint) {
        layoutAttemptRef.current = {
          fingerprint,
          idempotencyKey: `home-layout:${newUUIDv7()}`,
        };
      }
      const attempt = layoutAttemptRef.current;
      if (!attempt) throw new Error("Could not prepare the layout update.");
      try {
        await verifyAnalyticsAuthority(expected, controller.signal);
        await putLayout(frozen, {
          surface: "home",
          signal: controller.signal,
          idempotencyKey: attempt.idempotencyKey,
        });
        assertAnalyticsSignalActive(controller.signal);
        const confirmed = await getLayout({
          surface: "home",
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
            "The saved home layout could not be confirmed. Reload it before making another change.",
          );
        }
        return { authorityKey: expected.authorityKey, layout: confirmed };
      } finally {
        endAnalyticsWrite(controller);
      }
    },
    onSuccess: (result) => {
      if (layoutAuthorityRef.current !== result.authorityKey) return;
      layoutAttemptRef.current = null;
      queryClient.setQueryData(layoutKey, result.layout);
    },
  });
  const layoutDisabled = !identityReady || viewerMode || online !== "online";
  const layoutDisabledReason = !identityReady
    ? "Your identity is still being verified."
    : viewerMode
      ? "Viewer mode is read-only. Exit viewer mode to customize this layout."
      : online !== "online"
        ? "Connect to the internet to customize this layout."
        : undefined;
  // Props for a reorderable widget wrapper: assign its flex order and hide it
  // when the layout excludes it. empty:hidden drops phantom gaps for widgets
  // that render nothing (empty recommendations/upcoming, email-only revenue).
  function homeWidget(key: string): {
    "data-widget": string;
    className: string;
    style: { order: number };
  } {
    const idx = visibleWidgetKeys.indexOf(key);
    return {
      "data-widget": key,
      className: cn("empty:hidden", idx === -1 && "hidden"),
      style: { order: idx === -1 ? HOME_WIDGETS.length : idx },
    };
  }
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:space-y-8 sm:px-6 sm:py-7 lg:p-8">
      <DashboardPageHeader
        eyebrow="Good to have you here"
        title={heading}
        description={
          <>
            <p>{subtitle}</p>
            {progressQuery.isError ? (
              <p className="mt-1 text-destructive">
                Couldn&apos;t load your setup progress — this greeting is based
                on a failed request, not on a workspace that has done nothing
                yet.
              </p>
            ) : null}
          </>
        }
        tone="yellow"
        actions={
          /* Quick actions persist regardless of onboarding state so a
             returning operator can start work straight from home (OVR-008).
             Read-only identities get an honest state, not links to writes
             the server will refuse. */
          canCreate ? (
            <>
              <Button asChild className="h-11 sm:h-9">
                <Link href={asRoute("/app/campaigns?create=1")}>
                  <Megaphone className="h-4 w-4" aria-hidden />
                  New campaign
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link href={asRoute("/app/subscribers/import")}>
                  <Upload className="h-4 w-4" aria-hidden />
                  Import contacts
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link href={asRoute("/app/subscribers/segments/new")}>
                  <Filter className="h-4 w-4" aria-hidden />
                  Create segment
                </Link>
              </Button>
            </>
          ) : identityReady ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              This workspace is read-only for your current access.
            </p>
          ) : null
        }
        status={
          <div className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              {/* Live stream (GET /api/v1/dashboard/live) + freshness, live
                  subscriber chip and active-send strip. Frames replace the
                  cached stats under statsKey; while the stream is not open the
                  60s polling above stays the source of truth. */}
              <DashboardLiveBar
                enabled={identityReady}
                statsKey={statsKey}
                stats={stats}
                statsUpdatedAt={statsQuery.dataUpdatedAt}
                campaigns={overview?.campaigns ?? null}
                fallbackPollSeconds={60}
                showReceipt={false}
              />
              <span
                aria-hidden="true"
                className="hidden h-4 w-px bg-emerald-900/15 dark:bg-white/15 sm:block"
              />
              <span
                data-testid="dashboard-last-updated"
                // The raw ISO lives in a data-* attribute (not visible text) so a
                // Playwright poll can detect a changing value across refreshes
                // without a machine timestamp leaking into the customer-facing
                // header (OVR-004).
                data-updated-at={
                  mounted && lastUpdated ? lastUpdated : undefined
                }
                className="min-w-0 truncate text-xs text-muted-foreground tabular-nums"
                title={
                  mounted && lastUpdated ? absoluteTime(lastUpdated) : undefined
                }
              >
                {mounted && lastUpdated
                  ? `Workspace refreshed ${timeAgo(lastUpdated)}`
                  : "Workspace refresh pending"}
              </span>
            </div>
            <div
              data-slot="dashboard-overview-tools"
              className="flex min-w-0 flex-wrap items-center gap-1.5 sm:flex-nowrap sm:justify-end 2xl:shrink-0"
            >
              <Button
                type="button"
                variant="ghost"
                className="h-11 rounded-xl text-foreground hover:bg-white/80 hover:text-emerald-900 dark:hover:bg-white/10 dark:hover:text-emerald-200 sm:h-9"
                onClick={refreshAll}
                disabled={!identityReady || manualRefreshing}
              >
                <RefreshCw
                  className={cn("h-4 w-4", manualRefreshing && "animate-spin")}
                  aria-hidden
                />
                {manualRefreshing ? "Refreshing…" : "Refresh"}
              </Button>
              <ShareSnapshotButton
                stats={stats}
                className="h-11 rounded-xl border-emerald-900/15 bg-white/80 text-foreground shadow-sm hover:border-emerald-900/25 hover:bg-white hover:text-emerald-900 dark:border-white/15 dark:bg-white/5 dark:hover:border-emerald-300/30 dark:hover:bg-white/10 dark:hover:text-emerald-200 sm:h-9"
              />
              <LayoutCustomizer
                items={HOME_WIDGETS}
                visibleKeys={visibleWidgetKeys}
                description="Show, hide, and reorder the cards on your home dashboard."
                panelLabel="Customize home dashboard"
                loadError={layoutQuery.isError}
                onReload={() => layoutQuery.refetch()}
                onSave={(order) => saveLayout.mutateAsync(order)}
                disabled={layoutDisabled}
                disabledReason={layoutDisabledReason}
                compact
                triggerClassName="rounded-xl text-foreground hover:bg-white/80 hover:text-emerald-900 dark:hover:bg-white/10 dark:hover:text-emerald-200"
              />
            </div>
          </div>
        }
      />

      {dashboardError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning-emphasis"
        >
          <span className="min-w-0">{dashboardError}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={!identityReady || manualRefreshing}
          >
            {manualRefreshing ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-8">
        {/* Commerce revenue for accounts with a commerce integration (OVR-033).
            Renders nothing for purely-email tenants. Pinned above the
            reorderable widgets. */}
        <div style={{ order: -2 }} className="empty:hidden">
          {mounted ? (
            <RevenueTiles
              tenantId={tenantId}
              role={role}
              userId={userId}
              viewerMode={viewerMode}
            />
          ) : null}
        </div>

        {/* Cross-device "Continue where you left off" (Continuity). Pinned. */}
        <div style={{ order: -1 }} className="empty:hidden">
          {mounted ? <ResumeCard /> : null}
        </div>

        {/* Lead with a real, period-aware performance snapshot sourced from the
            existing dashboard/stats payload (OVR-007/021/023). */}
        <div {...homeWidget("performance")}>
          <PerformanceSnapshot
            stats={stats}
            loading={statsQuery.isPending}
            error={statsQuery.isError}
            onRetry={() => void statsQuery.refetch()}
            mounted={mounted}
          />
          {/* Growth projection from the same stats payload — no new request.
              Renders nothing when the trend does not support a forecast. */}
          {mounted ? (
            <div className="mt-3 empty:hidden">
              <ForecastStrip
                sparkline={stats?.sparklines?.subscribers}
                currentTotal={stats?.subscribers_total}
              />
            </div>
          ) : null}
        </div>

        {/* Headline counts. Gated on loaded data so the tiles never flash a
          fabricated 0 / 0 / 0 before the fetch resolves (OVR-002). Each tile
          links to its section (OVR-021). */}
        <div {...homeWidget("stats")}>
          <div data-tour="dashboard-stats">
            {overview ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {overview.stats.map((s) => (
                  <Link
                    key={s.label}
                    href={asRoute(s.href)}
                    data-testid="stat-card"
                    className="group rounded-[11px_15px_11px_15px] border border-mw-ink/20 bg-card px-4 py-3 shadow-[2px_3px_0_rgb(32_32_30_/_0.06)] transition-[color,background-color,border-color,transform] hover:-translate-y-0.5 hover:border-mw-blue hover:bg-mw-yellow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium uppercase text-muted-foreground">
                        {s.label}
                      </div>
                      <ArrowRight
                        className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden
                      />
                    </div>
                    <div
                      data-testid="stat-card-value"
                      className="mt-1 text-2xl font-semibold tabular-nums"
                    >
                      {s.value}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <StatGridSkeleton />
            )}
          </div>
        </div>

        {recommendations.length > 0 ? (
          <div {...homeWidget("recommendations")}>
            <RecommendationsCard
              recommendations={recommendations}
              canCreate={canCreate}
            />
          </div>
        ) : null}

        {/* Onboarding checklist — real progress + live checkmarks. */}
        <div {...homeWidget("checklist")}>
          {mounted && identityReady ? (
            <Suspense fallback={<OnboardingChecklistSkeleton />}>
              <OnboardingChecklist
                tenantId={tenantId}
                role={role}
                userId={userId}
                viewerMode={viewerMode}
              />
            </Suspense>
          ) : (
            <OnboardingChecklistSkeleton />
          )}
        </div>

        {/* Forward-looking view of imminent sends (OVR-022). Shown only when
          there is something scheduled. */}
        {upcoming.length > 0 ? (
          <div {...homeWidget("upcoming")}>
            <Card>
              <CardHeader>
                <CardTitle>Upcoming sends</CardTitle>
                <CardDescription>
                  Scheduled campaigns, soonest first.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2" data-testid="upcoming-sends">
                  {upcoming.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={asRoute(`/app/campaigns/${c.id}`)}
                        className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <CalendarClock
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate font-medium" title={c.name}>
                            {c.name}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span
                            className="text-xs text-muted-foreground tabular-nums"
                            title={
                              c.scheduledAt
                                ? absoluteTime(c.scheduledAt)
                                : undefined
                            }
                          >
                            {mounted && c.scheduledAt
                              ? timeAgo(c.scheduledAt)
                              : ""}
                          </span>
                          <Badge variant="secondary">scheduled</Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        ) : null}

        <div {...homeWidget("campaigns")}>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Recent campaigns</CardTitle>
                  <CardDescription>
                    Your latest drafts and sends.
                  </CardDescription>
                </div>
                <Link
                  href={asRoute("/app/campaigns")}
                  className="inline-flex min-h-8 shrink-0 items-center rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View all
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {overview?.campaignsError ? (
                // A failed campaigns request is NOT an empty account — show an
                // error + retry, never "No campaigns yet." (OVR-001).
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
                >
                  <span className="min-w-0">
                    Your campaigns couldn&apos;t be loaded.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={refreshAll}
                    disabled={!identityReady || manualRefreshing}
                  >
                    {manualRefreshing ? "Retrying…" : "Retry"}
                  </Button>
                </div>
              ) : !overview ? (
                <CardRowsSkeleton />
              ) : campaigns.length > 0 ? (
                <ul data-testid="recent-campaigns" className="space-y-2">
                  {campaigns.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={asRoute(`/app/campaigns/${c.id}`)}
                        className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate font-medium" title={c.name}>
                          {c.name}
                        </span>
                        <Badge
                          variant={campaignStatusVariant(
                            c.status as CampaignStatus,
                          )}
                        >
                          {c.status}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div data-testid="recent-campaigns">
                  <EmptyState
                    icon={Megaphone}
                    title="No campaigns yet"
                    description="Design your first newsletter and send it to your audience. It only takes a few minutes."
                    action={
                      canCreate ? (
                        <Button asChild>
                          <Link href={asRoute("/app/campaigns")}>
                            Create your first campaign
                          </Link>
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div {...homeWidget("activity")}>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Activity</CardTitle>
                  <CardDescription>
                    Recent events in your workspace.
                  </CardDescription>
                </div>
                {canReadActivity ? (
                  <Link
                    href={asRoute("/app/settings/audit")}
                    className="inline-flex min-h-8 shrink-0 items-center rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    View all
                  </Link>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {/* Activity is a secondary feed: its own error renders inline here
              with a retry, and never replaces the page-level data above. */}
              {activityRestricted ? (
                <p className="text-sm text-muted-foreground">
                  Workspace activity includes protected audit evidence and is
                  available to workspace admins.
                </p>
              ) : activityError ? (
                <div
                  role="alert"
                  aria-live="polite"
                  className="mb-3 flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
                >
                  <span className="min-w-0 truncate">{activityError}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={refreshAll}
                    disabled={!identityReady || manualRefreshing}
                  >
                    {manualRefreshing ? "Retrying…" : "Retry"}
                  </Button>
                </div>
              ) : null}
              {!activityRestricted && !overview && !activityError ? (
                <CardRowsSkeleton />
              ) : !activityRestricted && activity.length > 0 ? (
                <ul data-testid="activity-feed" className="space-y-2">
                  {activity.map((a) => {
                    const inner = (
                      <>
                        <span
                          className="flex min-w-0 items-center gap-1.5"
                          title={a.message}
                        >
                          <span className="truncate">{a.message}</span>
                          {a.count > 1 ? (
                            <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                              ×{a.count}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className="shrink-0 text-muted-foreground tabular-nums"
                          title={mounted ? absoluteTime(a.at) : undefined}
                        >
                          {mounted ? timeAgo(a.at) : ""}
                        </span>
                      </>
                    );
                    const rowClass =
                      "flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs";
                    return (
                      <li key={a.id}>
                        {a.href ? (
                          <Link
                            href={asRoute(a.href)}
                            className={cn(
                              rowClass,
                              "transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div className={rowClass}>{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                !activityRestricted &&
                !activityError && (
                  <div data-testid="activity-feed">
                    <EmptyState
                      icon={Sparkles}
                      title="No recent activity yet"
                      description="Actions across your workspace — sends, imports, edits — will show up here as they happen."
                    />
                  </div>
                )
              )}
            </CardContent>
          </Card>
        </div>

        {/* System status. Customers see a friendly badge + plain-language line;
          the verbose probe (proxy/port detail + raw JSON) is gated behind an
          explicit opt-in flag so internal infra never leaks onto the first
          screen after login (OVR-029). */}
        <div {...homeWidget("status")}>
          <Card data-tour="dashboard-api-status">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>System status</CardTitle>
                  <CardDescription>
                    {SHOW_HEALTH_DEBUG ? (
                      <>
                        Probing{" "}
                        <code className="font-mono text-xs">/api/health</code>{" "}
                        (proxied to Go API on :8080).
                      </>
                    ) : (
                      "Live health of the Moosewave service."
                    )}
                  </CardDescription>
                </div>
                <StatusBadge state={health} />
              </div>
            </CardHeader>
            <CardContent>
              {SHOW_HEALTH_DEBUG ? (
                <>
                  {health.status === "error" && (
                    <p className="text-sm text-destructive font-mono break-all">
                      {health.message}
                    </p>
                  )}
                  {health.status === "ok" && (
                    <pre
                      tabIndex={0}
                      role="group"
                      aria-label="System status payload"
                      className="text-xs bg-muted rounded p-3 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {JSON.stringify(health.payload, null, 2)}
                    </pre>
                  )}
                  {health.status === "loading" && (
                    <p className="text-sm text-muted-foreground">Checking…</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {health.status === "loading" && "Checking service status…"}
                  {health.status === "ok" && "All systems operational."}
                  {health.status === "error" &&
                    "We're having trouble reaching the service. Please try again shortly."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: HealthState }) {
  if (state.status === "loading")
    return <Badge variant="secondary">checking…</Badge>;
  if (state.status === "ok") return <Badge variant="success">online</Badge>;
  return <Badge variant="destructive">offline</Badge>;
}

interface PerfTileData {
  key: string;
  label: string;
  /**
   * null when the backend did not send this counter.
   *
   * `DashboardStats` declares these as required `number`s, but that is a
   * compile-time claim about a payload TypeScript does not control: an older
   * API build, a partial projection, or a degraded read answers 200 without
   * them, and `undefined.toLocaleString()` took the app's home page down.
   * Unknown renders as an em dash, matching how this page already reports an
   * absent campaign count.
   */
  value: number | null;
  /** null when there is no value to compare, so no badge is drawn. */
  delta: MetricDelta | null;
  spark?: number[];
  href: string;
}

/** A finite number, or null for anything the wire may have omitted or mangled. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Delta only means something when there is a current value. Computing it from
 * `undefined` yielded `NaN - 0 = NaN` and rendered a "NaN" badge, so this is
 * the same defect wearing a second face.
 */
function deltaOrNull(
  current: number | null,
  previous: number | null | undefined,
): MetricDelta | null {
  return current == null ? null : computeDelta(current, previous);
}

function PerformanceSnapshot({
  stats,
  loading,
  error,
  onRetry,
  mounted,
}: {
  stats: DashboardStats | null;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
  mounted: boolean;
}) {
  // Avoid rendering a period-relative snapshot before mount to keep SSR output
  // stable; the count tiles below already cover the first paint.
  if (!mounted) return null;
  if (loading && !stats) {
    return <StatGridSkeleton count={4} className="lg:grid-cols-4" />;
  }
  // Surface a stats fetch failure honestly rather than silently vanishing the
  // whole snapshot (which conflicts with the error-honesty the rest of the page
  // now applies to campaigns/activity).
  if (!stats && error) {
    return (
      <section
        aria-label="Performance snapshot"
        role="alert"
        aria-live="polite"
        className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning-emphasis"
      >
        <span className="min-w-0">
          Performance metrics could not be loaded.
        </span>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </section>
    );
  }
  if (!stats) return null;

  const prev = stats.previous ?? null;
  const tiles: PerfTileData[] = [
    {
      key: "opens",
      label: "Opens",
      value: finiteOrNull(stats.opens_total_30d),
      delta: deltaOrNull(
        finiteOrNull(stats.opens_total_30d),
        prev?.opens_total,
      ),
      spark: stats.sparklines?.opens,
      href: analyticsMetricHref("opens"),
    },
    {
      key: "clicks",
      label: "Clicks",
      value: finiteOrNull(stats.clicks_total_30d),
      delta: deltaOrNull(
        finiteOrNull(stats.clicks_total_30d),
        prev?.clicks_total,
      ),
      spark: stats.sparklines?.clicks,
      href: analyticsMetricHref("clicks"),
    },
    {
      key: "contacts",
      label: "Contacts added",
      value: finiteOrNull(stats.subscribers_added_30d),
      delta: deltaOrNull(
        finiteOrNull(stats.subscribers_added_30d),
        prev?.subscribers_added,
      ),
      spark: stats.sparklines?.subscribers,
      href: "/app/subscribers",
    },
  ];

  // Revenue lights up only if the backend starts emitting it — never fabricated
  // (OVR-033).
  if (typeof stats.revenue_attributed_30d === "number") {
    tiles.push({
      key: "revenue",
      label: "Revenue (30d)",
      value: stats.revenue_attributed_30d,
      delta: computeDelta(stats.revenue_attributed_30d, null),
      href: "/app/analytics",
    });
  }

  const health = stats.inbox_health;
  const healthScore = typeof health?.score === "number" ? health.score : null;

  return (
    <section aria-label="Performance snapshot" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-hand text-sm font-semibold text-mw-blue">
          Performance · last 30 days
        </h2>
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={asRoute(t.href)}
            data-testid="perf-stat"
            className="group flex flex-col rounded-[11px_15px_11px_15px] border border-mw-ink/20 bg-card px-4 py-3 shadow-[2px_3px_0_rgb(32_32_30_/_0.06)] transition-[color,background-color,border-color,transform] hover:-translate-y-0.5 hover:border-mw-blue hover:bg-mw-pink-soft/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                {t.label}
              </span>
              {t.delta ? <DeltaBadge delta={t.delta} /> : null}
            </div>
            <div className="mt-1 flex items-end justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {t.value == null ? "—" : t.value.toLocaleString()}
              </span>
              {t.spark ? (
                <Sparkline data={t.spark} className="mb-1 h-7 w-20 shrink-0" />
              ) : null}
            </div>
          </Link>
        ))}

        {/* Deliverability / inbox-health tile (OVR-023). */}
        <Link
          href={asRoute("/app/inbox-reality")}
          data-testid="perf-stat"
          className="group flex flex-col rounded-[11px_15px_11px_15px] border border-mw-ink/20 bg-card px-4 py-3 shadow-[2px_3px_0_rgb(32_32_30_/_0.06)] transition-[color,background-color,border-color,transform] hover:-translate-y-0.5 hover:border-mw-blue hover:bg-mw-pink-soft/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              Inbox health
            </span>
            <Inbox className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </div>
          <div className="mt-1 flex items-end justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {healthScore != null ? healthScore : "—"}
            </span>
            {health?.state ? (
              <Badge
                variant={
                  healthScore != null && healthScore < 70
                    ? "warning"
                    : "success"
                }
                className="mb-1"
              >
                {health.state}
              </Badge>
            ) : null}
          </div>
        </Link>
      </div>
    </section>
  );
}

function RecommendationsCard({
  recommendations,
  canCreate,
}: {
  recommendations: ReturnType<typeof deriveRecommendations>;
  canCreate: boolean;
}) {
  return (
    <Card className="border-mw-blue/25">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 rotate-[-2deg] items-center justify-center rounded-[7px_10px_7px_10px] bg-mw-pink-soft text-mw-blue">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <CardTitle>Recommendations</CardTitle>
        </div>
        <CardDescription>
          Next-best-actions derived from your last 30 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2" data-testid="recommendations">
          {recommendations.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-3 rounded-[9px_12px_9px_12px] border border-mw-ink/15 bg-card px-3 py-2.5 transition-colors hover:bg-mw-pink-soft/30"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                    r.tone === "warn"
                      ? "bg-warning-subtle text-warning-emphasis"
                      : "bg-accent text-primary",
                  )}
                >
                  {r.tone === "warn" ? (
                    <TrendingDown className="h-3.5 w-3.5" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {r.detail}
                  </p>
                </div>
              </div>
              {r.id !== "healthy" || canCreate ? (
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                >
                  <Link href={asRoute(r.href)}>{r.cta}</Link>
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Read-only
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
