/**
 * Dashboard — workspace-keyed overview shell.
 *
 * Data, live updates, polling, global status signals, layout persistence, and
 * snapshot formatting live behind focused modules under pages/dashboard.
 * Keying the workspace controller prevents one tenant's range, requests, or
 * optimistic layout from leaking into another tenant after a workspace switch.
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { AnomalyHistoryCard } from "../components/dashboard/AnomalyHistoryCard";
import { AuditFeedCard } from "../components/dashboard/AuditFeedCard";
import { BenchmarksCard } from "../components/dashboard/BenchmarksCard";
import {
  DashboardSectionList,
  type DashboardSection,
} from "../components/dashboard/DashboardSectionList";
import { DASHBOARD_SECTIONS } from "../components/dashboard/dashboard-sections";
import { DashboardStatGrid } from "../components/dashboard/DashboardStatGrid";
import { DashboardToolbar } from "../components/dashboard/DashboardToolbar";
import { ForecastStrip } from "../components/dashboard/ForecastStrip";
import { GoalsCard } from "../components/dashboard/GoalsCard";
import { InboxHealthCard } from "../components/dashboard/InboxHealthCard";
import { MailchimpParityCard } from "../components/dashboard/MailchimpParityCard";
import { RecentCampaignsCard } from "../components/dashboard/RecentCampaignsCard";
import { StaleIndicator } from "../components/dashboard/StaleIndicator";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import { ResumeCard } from "../components/dashboard/ResumeCard";
import { toast } from "../components/Toast";
import type {
  Campaign,
  DashboardRange,
  DashboardStatsResponse,
} from "../lib/api-client";
import { writeClipboardText } from "../lib/clipboard";
import {
  desktopRouteIdentityScope,
  navigateDesktopRoute,
} from "../lib/desktop-router";
import { setSection, useMe, useRole } from "../lib/store";
import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
} from "./dashboard/dashboard-snapshot";
import {
  type DashboardStatsFailure,
  useDashboardData,
} from "./dashboard/useDashboardData";
import { useDashboardLayout } from "./dashboard/useDashboardLayout";
import "../styles-dashboard.css";

const CLVDashboard = lazy(() =>
  import("../components/dashboard/CLVDashboard").then((module) => ({
    default: module.CLVDashboard,
  })),
);

const VALID_RANGES: readonly DashboardRange[] = ["7d", "30d", "90d"];

const RANGE_PREFERENCE_PREFIX = "pw.dashboard.v2.range";

function preferenceKey(identityScope: string | null): string | null {
  return identityScope ? `${RANGE_PREFERENCE_PREFIX}:${identityScope}` : null;
}

function purgeLegacyRangePreference(workspace: string | null): void {
  try {
    window.localStorage.removeItem(
      `pw.dashboard.${workspace ?? "default"}.range`,
    );
  } catch {
    // Legacy cleanup is best-effort in hardened webviews.
  }
}

function readRangePreference(
  identityScope: string | null,
  workspace: string | null,
): DashboardRange {
  purgeLegacyRangePreference(workspace);
  const key = preferenceKey(identityScope);
  if (!key) return "30d";
  try {
    const stored = window.localStorage.getItem(key);
    if (VALID_RANGES.some((range) => range === stored)) {
      return stored as DashboardRange;
    }
  } catch {
    // Storage can be unavailable in hardened webviews; use the product default.
  }
  return "30d";
}

export function Dashboard(): ReactElement {
  const me = useMe();
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  return (
    <DashboardWorkspace
      key={identityScope === null ? "anonymous" : `identity:${identityScope}`}
    />
  );
}

function DashboardWorkspace(): ReactElement {
  const activeRef = useRef(true);
  const me = useMe();
  const role = useRole();
  const workspaceKey = me?.tenant ?? null;
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const tenantId = me?.tenant ?? "anon";
  const [range, setRange] = useState<DashboardRange>(() =>
    readRangePreference(identityScope, workspaceKey),
  );
  const layout = useDashboardLayout(workspaceKey, me !== null);
  const data = useDashboardData({
    hasIdentity: me !== null,
    notificationScope: identityScope,
    range,
    role,
    tenantId,
  });

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    purgeLegacyRangePreference(workspaceKey);
    const key = preferenceKey(identityScope);
    if (!key) return;
    try {
      window.localStorage.setItem(key, range);
    } catch {
      // Keep the in-memory selection when storage is unavailable.
    }
  }, [identityScope, range, workspaceKey]);

  const onDrilldown = useCallback(
    (metric: "subs" | "opens" | "clicks" | "bounces"): void => {
      if (metric === "subs") {
        setSection("subscribers");
        return;
      }
      navigateDesktopRoute({
        section: "analytics",
        filters: [
          { key: "metric", value: metric },
          { key: "range", value: range },
        ],
      });
    },
    [range],
  );

  const onShareSnapshot = useCallback(async (): Promise<boolean> => {
    if (!canBuildDashboardSnapshot(data.stats)) return false;
    const result = await writeClipboardText(
      buildDashboardSnapshot(data.stats, range),
      { contentClass: "personal", label: "Dashboard snapshot" },
    );
    if (!activeRef.current) return false;
    if (result.ok) {
      toast.success("Snapshot copied — paste into Slack / Notion / email.");
      return true;
    }
    toast.error(result.message);
    return false;
  }, [data.stats, range]);

  const subscribers = Number(data.stats?.subscribers_total ?? 0);
  return (
    <div className="pw-dashboard">
      <header className="dash-hero">
        <div className="dash-hero-copy">
          <div className="dash-hero-eyebrow">
            <span className="dash-hero-eyebrow-mark" aria-hidden="true" />
            Workspace pulse
          </div>
          <h1 className="dash-hero-title">Dashboard</h1>
          <p className="dash-hero-subtitle">
            Audience momentum, engagement, and delivery health in one focused
            view.
          </p>
        </div>
        <DashboardToolbar
          range={range}
          loading={data.loading}
          liveSlot={
            <StaleIndicator
              range={range}
              liveStatus={data.liveStatus}
              offline={data.statsFailure?.kind === "offline"}
              lastSuccessAt={data.lastSuccessAt}
              now={data.now}
            />
          }
          onRangeChange={setRange}
          onRefresh={data.load}
          onShare={onShareSnapshot}
          shareAvailable={canBuildDashboardSnapshot(data.stats)}
          editingLayout={layout.editing}
          layoutSaving={layout.saveStatus === "saving"}
          onToggleEditLayout={layout.toggleEditing}
        />
      </header>

      {layout.editing || layout.saveStatus === "failed" ? (
        <div
          className={`dash-layout-mode is-${layout.saveStatus}`}
          role={layout.saveStatus === "failed" ? "alert" : "status"}
          aria-live={layout.saveStatus === "failed" ? "assertive" : "polite"}
        >
          <div>
            <strong>
              {layout.editing
                ? "Rearrange metrics and sections"
                : "Layout changes need attention"}
            </strong>
            <span>
              {layout.editing
                ? "Changes save automatically. Use the arrow controls as a keyboard alternative to dragging."
                : layout.saveMessage}
            </span>
          </div>
          {layout.editing ? (
            <span className="dash-layout-save-state tabular">
              {layout.saveMessage ?? "Ready to customize"}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="dash-overview-grid">
        <section className="dash-primary" aria-labelledby="dash-primary-title">
          <div className="dash-section-heading">
            <div>
              <div className="dash-section-eyebrow">Core metrics</div>
              <h2 id="dash-primary-title" className="dash-section-title">
                Workspace performance
              </h2>
            </div>
            <p className="dash-section-context">
              Compared with the preceding {range} window. Open any metric for
              the underlying audience or analytics view. Engagement rates use
              unique campaign-recipient evidence, never repeat event totals.
            </p>
          </div>
          {data.statsFailure && data.stats === null ? (
            <DashboardLoadError
              failure={data.statsFailure}
              loading={data.loading}
              onRetry={() => void data.load()}
            />
          ) : (
            <>
              {data.statsFailure ? (
                <DashboardRefreshWarning
                  failure={data.statsFailure}
                  loading={data.loading}
                  onRetry={() => void data.load()}
                />
              ) : null}
              <DashboardStatGrid
                stats={data.stats}
                loading={
                  data.loadState === "initial" || data.loadState === "range"
                }
                editing={layout.editing}
                comparisonLabel={`vs previous ${range}`}
                onDrilldown={onDrilldown}
                order={layout.layout ?? undefined}
                onReorder={
                  layout.editing
                    ? (next) => layout.persist({ stats: next })
                    : undefined
                }
              />
            </>
          )}
        </section>

        <aside className="dash-onboarding-region" aria-label="Workspace setup">
          {/* Cross-device continuity: renders only when another device left a
              cursor this surface can open (lib/activity-cursor). */}
          <ResumeCard />
          <OnboardingChecklist
            variant="compact"
            title="Finish setting up your workspace"
            subtitle="Take the shortest path to a confident first send."
          />
        </aside>
      </div>

      <DashboardSectionList
        sections={dashboardSections({
          stats: data.stats,
          campaigns: data.campaigns,
          campaignsLoading: data.campaignsLoading,
          campaignsError: data.campaignsError,
          campaignsStale: data.campaignsStale,
          onRetryCampaigns: data.refreshCampaigns,
          loading: data.loadState === "initial" || data.loadState === "range",
          subscribers,
          range,
        })}
        order={layout.layout}
        editing={layout.editing}
        onReorder={(next) => layout.persist({ sections: next })}
      />
    </div>
  );
}

function DashboardLoadError({
  failure,
  loading,
  onRetry,
}: {
  failure: DashboardStatsFailure;
  loading: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="dash-load-error" role="alert">
      <div>
        <strong>{dashboardFailureTitle(failure.kind)}</strong>
        <span>{failure.message}</span>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onRetry}
        disabled={loading}
      >
        {loading ? "Retrying…" : dashboardFailureAction(failure.kind)}
      </button>
    </div>
  );
}

function DashboardRefreshWarning({
  failure,
  loading,
  onRetry,
}: {
  failure: DashboardStatsFailure;
  loading: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="dash-refresh-warning" role="alert">
      <span>
        <strong>{dashboardRefreshFailureTitle(failure.kind)}</strong>{" "}
        {failure.message} Showing the last confirmed metrics.
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onRetry}
        disabled={loading}
      >
        {loading ? "Retrying…" : "Try again"}
      </button>
    </div>
  );
}

function dashboardFailureTitle(kind: DashboardStatsFailure["kind"]): string {
  switch (kind) {
    case "offline":
      return "Dashboard is offline.";
    case "access":
      return "Workspace metrics are restricted.";
    case "unavailable":
      return "Dashboard reporting isn’t available here.";
    case "service":
      return "Workspace metrics are temporarily unavailable.";
    case "invalid":
      return "Workspace metrics couldn’t be verified.";
    default:
      return "Workspace metrics are unavailable.";
  }
}

function dashboardRefreshFailureTitle(
  kind: DashboardStatsFailure["kind"],
): string {
  switch (kind) {
    case "offline":
      return "Refresh paused while offline.";
    case "access":
      return "Latest metrics are restricted.";
    case "unavailable":
      return "Latest reporting is unavailable.";
    case "invalid":
      return "Latest metrics couldn’t be verified.";
    default:
      return "Couldn’t refresh.";
  }
}

function dashboardFailureAction(kind: DashboardStatsFailure["kind"]): string {
  switch (kind) {
    case "offline":
      return "Retry connection";
    case "access":
      return "Check access again";
    case "unavailable":
      return "Check availability";
    default:
      return "Retry metrics";
  }
}

function dashboardSections(props: {
  stats: DashboardStatsResponse | null;
  campaigns: Campaign[] | null;
  campaignsLoading: boolean;
  campaignsError: boolean;
  campaignsStale: boolean;
  onRetryCampaigns: () => void | Promise<void>;
  loading: boolean;
  subscribers: number;
  range: DashboardRange;
}): DashboardSection[] {
  const {
    stats,
    campaigns,
    campaignsLoading,
    campaignsError,
    campaignsStale,
    onRetryCampaigns,
    loading,
    subscribers,
    range,
  } = props;
  const nodes: Record<string, ReactElement> = {
    forecast: (
      <ForecastStrip
        sparkline={stats?.sparklines?.subscribers}
        currentTotal={subscribers}
      />
    ),
    anomalies: <AnomalyHistoryCard />,
    goals: <GoalsCard />,
    benchmarks: <BenchmarksCard stats={stats} range={range} />,
    engagement: (
      <div className="dash-grid">
        <RecentCampaignsCard
          campaigns={campaigns}
          loading={campaignsLoading}
          error={campaignsError}
          stale={campaignsStale}
          onRetry={onRetryCampaigns}
        />
        <AuditFeedCard events={stats?.recent_audit} loading={loading} />
      </div>
    ),
    parity: <MailchimpParityCard />,
    "inbox-health": <InboxHealthCard stats={stats} loading={loading} />,
    clv: <ViewportCLVDashboard />,
  };
  return DASHBOARD_SECTIONS.filter((section) => section.key in nodes).map(
    (section) => ({
      key: section.key,
      label: section.label,
      node: nodes[section.key]!,
    }),
  );
}

function ViewportCLVDashboard(): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`dash-lazy-section${nearViewport ? " is-ready" : ""}`}
    >
      {nearViewport ? (
        <Suspense fallback={<CustomerValueModuleFallback />}>
          <CLVDashboard />
        </Suspense>
      ) : null}
    </div>
  );
}

function CustomerValueModuleFallback(): ReactElement {
  return (
    <div
      className="card dash-deferred-card"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="dash-deferred-copy">
        <span className="dash-deferred-eyebrow">Customer intelligence</span>
        <strong>Preparing customer-value insights</strong>
        <span>Loading projections, value ranges, and churn-risk signals.</span>
      </div>
      <div className="dash-deferred-preview" aria-hidden="true">
        <span className="skel" />
        <span className="skel" />
        <span className="skel" />
        <span className="skel dash-deferred-preview-wide" />
      </div>
    </div>
  );
}
