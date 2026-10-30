import {
  Suspense,
  lazy,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { CohortFunnelCard } from "../../components/analytics/CohortFunnelCard";
import { FatigueCard } from "../../components/analytics/FatigueCard";
import { InboxProviderHealthCard } from "../../components/analytics/InboxProviderHealthCard";
import { PredictiveAnalyticsSection } from "../../components/analytics/PredictiveAnalyticsSection";
import { RevenueAttributionSection } from "../../components/analytics/RevenueAttributionSection";
import { rangeDays } from "../../components/analytics/AnalyticsPresentation";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  desktopRouteIdentityScope,
  useDesktopRouteTab,
} from "../../lib/desktop-router";
import { useMe } from "../../lib/store";
import type { AnalyticsDashboardProps } from "./analytics-dashboard-types";
import {
  AnalyticsCampaignPanels,
  CampaignPerformancePanel,
} from "./AnalyticsCampaignPanels";
import {
  CohortRetentionPanel,
  ConversationsPanel,
  DeliverabilityPanel,
  SequenceFunnelPanel,
} from "./AnalyticsHealthPanels";
import { AnalyticsReportsPanels } from "./AnalyticsReportsPanels";
import { AnalyticsPageHeader, AnalyticsTopPanels } from "./AnalyticsTopPanels";
import {
  AnalyticsTrendPanels,
  SubscriberGrowthPanel,
} from "./AnalyticsTrendPanels";

const AnalyticsAudiencePanels = lazy(() =>
  import("./AnalyticsAudiencePanels").then((module) => ({
    default: module.AnalyticsAudiencePanels,
  })),
);

const CampaignAnalyticsSlideover = lazy(() =>
  import("../../components/analytics/CampaignAnalyticsSlideover").then(
    (module) => ({ default: module.CampaignAnalyticsSlideover }),
  ),
);

const ANALYTICS_TABS = [
  {
    id: "overview",
    label: "Overview",
    kicker: "Decision brief",
    title: "What changed, what matters, and where to look next",
    description:
      "A coherent working view of the selected period: primary KPIs, movement over time, recent campaign evidence, and immediate delivery risk.",
  },
  {
    id: "campaigns",
    label: "Campaigns",
    kicker: "Campaign evidence",
    title: "Compare outcomes without losing the denominator",
    description:
      "Inspect recent campaigns, compare like-for-like rates, and open a campaign record for recipient, delivery, and conversion evidence.",
  },
  {
    id: "audience",
    label: "Audience",
    kicker: "Audience intelligence",
    title: "See who is growing, engaging, and drifting away",
    description:
      "Subscriber growth, cohort behavior, client and geography signals, and the links that earned attention—each labeled with its real scope.",
  },
  {
    id: "revenue",
    label: "Revenue",
    kicker: "Conversion telemetry",
    title: "Separate total conversion value from attributed value",
    description:
      "Read conversion telemetry by currency and attribution method. Treat public browser events as directional until a trusted commerce ledger is connected.",
  },
  {
    id: "predictive",
    label: "Predictive",
    kicker: "Model-assisted analysis",
    title: "Use projections with their coverage and confidence visible",
    description:
      "Review CLV, churn, RFM, and fatigue signals as estimates—not facts—and keep model provenance beside every recommendation.",
  },
  {
    id: "reports",
    label: "Reports",
    kicker: "Reporting operations",
    title: "Build, run, and schedule reports from one controlled surface",
    description:
      "Keep report definitions, generated results, scheduled delivery, and optional natural-language exploration separate from the dashboard itself.",
  },
] as const;

type AnalyticsTab = (typeof ANALYTICS_TABS)[number]["id"];

interface AnalyticsResourceIssue {
  code?: string;
  label: string;
  message: string;
  primary: boolean;
  resource: string;
  retained: boolean;
  severity: "error" | "warning";
}

function controllerIssues(
  dashboard: AnalyticsDashboardProps["dashboard"],
): AnalyticsResourceIssue[] {
  const controller = dashboard.controller as typeof dashboard.controller & {
    issues?: AnalyticsResourceIssue[];
  };
  if (Array.isArray(controller.issues)) return controller.issues;
  if (!controller.err) return [];
  return [
    {
      label: "Analytics snapshot",
      message: controller.err,
      primary: true,
      resource: "dashboard",
      retained: controller.stats != null,
      severity: "error",
    },
  ];
}

function AnalyticsIssueStack({
  dashboard,
}: AnalyticsDashboardProps): ReactElement | null {
  const issues = controllerIssues(dashboard);
  if (issues.length === 0) return null;
  return (
    <div className="analytics-issue-stack" aria-label="Analytics data issues">
      {issues.map((issue) => (
        <div
          key={`${issue.resource}:${issue.code ?? issue.message}`}
          className="analytics-issue"
          data-severity={issue.severity}
          role={issue.primary ? "alert" : "status"}
        >
          <span className="analytics-issue-mark" aria-hidden="true">
            {issue.severity === "error" ? "!" : "i"}
          </span>
          <span className="analytics-issue-copy">
            <strong>{issue.label}</strong>
            {issue.message}
            {issue.retained
              ? " The last accepted data remains visible with its original scope."
              : ""}
          </span>
          {issue.primary ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={dashboard.controller.refreshing}
              onClick={() =>
                void dashboard.controller.load(dashboard.controller.range)
              }
            >
              Retry snapshot
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AnalyticsSectionLead({
  activeTab,
  lastUpdated,
}: {
  activeTab: AnalyticsTab;
  lastUpdated: number | null;
}): ReactElement {
  const item =
    ANALYTICS_TABS.find((candidate) => candidate.id === activeTab) ??
    ANALYTICS_TABS[0];
  return (
    <div className="analytics-section-lead">
      <div className="analytics-section-copy">
        <span className="analytics-section-kicker">{item.kicker}</span>
        <h2 className="analytics-section-title">{item.title}</h2>
        <p className="analytics-section-description">{item.description}</p>
      </div>
      <span className="analytics-snapshot-badge">
        {lastUpdated == null
          ? "Awaiting snapshot"
          : `Accepted ${new Date(lastUpdated).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
      </span>
    </div>
  );
}

function ViewportAudiencePanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
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
      { rootMargin: "600px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ minHeight: nearViewport ? undefined : 420 }}
    >
      {nearViewport ? (
        <Suspense
          fallback={
            <div
              className="card"
              role="status"
              aria-label="Loading audience analytics"
            >
              <div className="skel" style={{ height: 180 }} />
            </div>
          }
        >
          <AnalyticsAudiencePanels dashboard={dashboard} />
        </Suspense>
      ) : (
        <div className="card pw-chart-empty" role="status">
          Preparing audience intelligence…
        </div>
      )}
    </div>
  );
}

function AnalyticsOverview({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <AnalyticsTopPanels dashboard={dashboard} />
      <AnalyticsTrendPanels dashboard={dashboard} />
      <CampaignPerformancePanel dashboard={dashboard} />
      <div className="dash-grid" style={{ marginTop: 12 }}>
        <DeliverabilityPanel dashboard={dashboard} />
        <ConversationsPanel dashboard={dashboard} />
      </div>
      <div style={{ marginTop: 12 }}>
        <InboxProviderHealthCard windowLabel={dashboard.controller.range} />
      </div>
      <SequenceFunnelPanel dashboard={dashboard} />
    </>
  );
}

function AnalyticsAudience({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <SubscriberGrowthPanel dashboard={dashboard} />
      <ViewportAudiencePanels dashboard={dashboard} />
      <CohortRetentionPanel dashboard={dashboard} />
      <CohortFunnelCard />
    </>
  );
}

function AnalyticsPredictive({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <div className="analytics-command-card">
        <div className="analytics-command-copy">
          <strong>Predictions are estimates, not account truth.</strong>
          <span>
            Coverage, confidence, sample bounds, and the scoring window must
            remain visible when a projection informs a decision.
          </span>
        </div>
        <span className="analytics-snapshot-badge">Model-assisted</span>
      </div>
      <PredictiveAnalyticsSection />
      <FatigueCard days={rangeDays(dashboard.controller.range)} />
    </>
  );
}

function AnalyticsTabContents({
  activeTab,
  dashboard,
}: AnalyticsDashboardProps & { activeTab: AnalyticsTab }): ReactElement {
  if (activeTab === "campaigns") {
    return <AnalyticsCampaignPanels dashboard={dashboard} />;
  }
  if (activeTab === "audience") {
    return <AnalyticsAudience dashboard={dashboard} />;
  }
  if (activeTab === "revenue") {
    return (
      <RevenueAttributionSection days={rangeDays(dashboard.controller.range)} />
    );
  }
  if (activeTab === "predictive") {
    return <AnalyticsPredictive dashboard={dashboard} />;
  }
  if (activeTab === "reports") {
    return <AnalyticsReportsPanels />;
  }
  return <AnalyticsOverview dashboard={dashboard} />;
}

function CampaignSlideoverFallback(): ReactElement {
  return (
    <div className="slideover-layer" role="status" aria-live="polite">
      <div
        className="slideover-overlay slideover-overlay-v2"
        role="presentation"
      />
      <aside
        className="slideover slideover-v2 slideover-lg analytics-slideover-skeleton"
        aria-label="Opening campaign analytics"
      >
        <span />
        <span />
        <span />
        <span />
        <span />
        <span className="visually-hidden">Opening campaign analytics…</span>
      </aside>
    </div>
  );
}

export function AnalyticsDashboardPresentation({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const me = useMe();
  const identityScope =
    desktopRouteIdentityScope(me?.user, me?.tenant) ?? "unresolved";
  const { drillTarget, setDrillTarget } = dashboard.controller;
  const [activeTab, setActiveTab] = useDesktopRouteTab<AnalyticsTab>(
    "analytics",
    ANALYTICS_TABS.map((item) => item.id),
    "overview",
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: activeTab,
    items: ANALYTICS_TABS.map((item) => ({ value: item.id })),
    onChange: setActiveTab,
  });

  return (
    <div className="analytics-workspace">
      <AnalyticsPageHeader dashboard={dashboard} />

      <div
        ref={tabs.listRef}
        className="analytics-tabs-shell"
        {...tabs.listProps}
        aria-label="Analytics sections"
      >
        {ANALYTICS_TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="analytics-tab"
            {...tabs.getTabProps(item.id)}
          >
            <span className="analytics-tab-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            {item.label}
          </button>
        ))}
      </div>

      <AnalyticsIssueStack dashboard={dashboard} />
      <AnalyticsSectionLead
        activeTab={activeTab}
        lastUpdated={dashboard.controller.lastUpdated}
      />

      {ANALYTICS_TABS.map((item) => (
        <section
          key={item.id}
          className="analytics-tab-panel"
          {...tabs.getPanelProps(item.id)}
          aria-busy={
            dashboard.controller.loading && dashboard.controller.stats == null
          }
        >
          {activeTab === item.id ? (
            <AnalyticsTabContents
              key={`${identityScope}:${item.id}`}
              activeTab={item.id}
              dashboard={dashboard}
            />
          ) : null}
        </section>
      ))}

      {drillTarget ? (
        <Suspense fallback={<CampaignSlideoverFallback />}>
          <CampaignAnalyticsSlideover
            campaignId={drillTarget.id}
            campaignName={drillTarget.name}
            onClose={() => setDrillTarget(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
