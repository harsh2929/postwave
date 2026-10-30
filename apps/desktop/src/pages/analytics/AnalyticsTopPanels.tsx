import { Fragment, type ReactElement } from "react";

import {
  AnalyticsHeader,
  KpiCard,
  campaignKey,
  deltaPct,
  fmtCompact,
  fmtNum,
  fmtPct,
  fmtRate,
} from "../../components/analytics/AnalyticsPresentation";
import { ExportMenu } from "../../components/analytics/ExportMenu";
import { GroupByMenu } from "../../components/analytics/GroupByMenu";
import {
  KpiConfigMenu,
  type KpiKey,
  visibleKeys,
} from "../../components/analytics/KpiConfigMenu";
import { ANALYTICS_GROUPBY_UNAVAILABLE } from "../../components/analytics/grouped-series";
import {
  SavedViewsMenu,
  type SavedView,
} from "../../components/analytics/SavedViewsMenu";
import { SkeletonStatCard } from "../../components/analytics/SkeletonCard";
import { InlineHelp } from "../../components/InlineHelp";
import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { useMe } from "../../lib/store";
import type {
  AnalyticsDashboardModel,
  AnalyticsDashboardProps,
} from "./analytics-dashboard-types";

function campaignNames(
  dashboard: AnalyticsDashboardModel,
): Record<string, string> {
  return Object.fromEntries(
    dashboard.controller.campaigns.map((campaign) => [
      campaignKey(campaign),
      campaign.name ?? campaign.subject ?? "Untitled",
    ]),
  );
}

export function AnalyticsPageHeader({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const controller = dashboard.controller;
  const me = useMe();
  const savedViewsScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  return (
    <AnalyticsHeader
      range={controller.range}
      onRange={controller.setRange}
      customRange={controller.customRange}
      onCustomRange={controller.setCustomRange}
      vsPrevious={controller.vsPrevious}
      onVsPrevious={controller.setVsPrevious}
      liveStatus={controller.liveStatus}
      liveUnavailable={controller.liveUnavailable}
      lastUpdated={controller.lastUpdated}
      onRefresh={() => void controller.load(controller.range)}
      refreshing={controller.refreshing}
      scopeLabel="Current workspace"
      rightExtras={
        <>
          <KpiConfigMenu
            layout={controller.kpiLayout}
            onChange={controller.setKpiLayout}
          />
          <GroupByMenu
            value={controller.groupBy}
            onChange={controller.setGroupBy}
            unavailable={ANALYTICS_GROUPBY_UNAVAILABLE}
          />
          <SavedViewsMenu
            current={{
              range: controller.range,
              vsPrevious: controller.vsPrevious,
            }}
            storageScope={savedViewsScope}
            onApply={(savedView: SavedView) => {
              controller.setRange(savedView.range);
              controller.setVsPrevious(savedView.vsPrevious);
            }}
          />
          <ExportMenu
            stats={controller.stats}
            campaignReports={controller.campaignReports}
            campaignNames={campaignNames(dashboard)}
            range={controller.range}
          />
        </>
      }
    />
  );
}

function buildKpiCards(
  dashboard: AnalyticsDashboardModel,
): Record<KpiKey, ReactElement | null> {
  const { campaigns, highlightedMetric, range, repliesSummary, vsPrevious } =
    dashboard.controller;
  const view = dashboard.view;
  return {
    subscribers: (
      <KpiCard
        label="Subscribers"
        value={fmtNum(view.flat.subscribers_total)}
        hint={`${view.flat.subscribers_added >= 0 ? "+" : ""}${fmtNum(view.flat.subscribers_added)} · ${range}`}
        sparkline={view.subsSpark}
        deltaPct={
          view.prev
            ? deltaPct(
                view.flat.subscribers_added,
                view.prev.subscribers_added ?? 0,
              )
            : null
        }
        vsPrevious={vsPrevious}
        metricKey="subscribers"
        highlighted={highlightedMetric === "subscribers"}
      />
    ),
    opens: (
      <KpiCard
        label={
          <>
            Open rate
            <InlineHelp text="Total opens ÷ emails sent (counts repeat opens, not unique openers). Apple Mail Privacy Protection can inflate this on iOS." />
          </>
        }
        value={fmtRate(view.flat.opens_total, view.emailsSent ?? 0)}
        hint={`${fmtCompact(view.flat.opens_total)} opens · ${range}`}
        sparkline={view.opensSpark}
        deltaPct={
          view.openRate !== null && view.prevOpenRate !== null
            ? deltaPct(view.openRate, view.prevOpenRate)
            : null
        }
        vsPrevious={vsPrevious}
        metricKey="opens"
        highlighted={highlightedMetric === "opens"}
      />
    ),
    clicks: (
      <KpiCard
        label={
          <>
            Click rate
            <InlineHelp text="Total clicks ÷ emails sent (counts repeat clicks, not unique clickers). For CTOR (clicks ÷ opens), drill into a specific campaign." />
          </>
        }
        value={fmtRate(view.flat.clicks_total, view.emailsSent ?? 0)}
        hint={`${fmtCompact(view.flat.clicks_total)} clicks · ${range}`}
        sparkline={view.clicksSpark}
        deltaPct={
          view.clickRate !== null && view.prevClickRate !== null
            ? deltaPct(view.clickRate, view.prevClickRate)
            : null
        }
        vsPrevious={vsPrevious}
        metricKey="clicks"
        highlighted={highlightedMetric === "clicks"}
      />
    ),
    replies: (
      <KpiCard
        label={
          <>
            Reply rate
            <InlineHelp text="Inbound replies matched to campaign sends ÷ emails sent. Matching uses the In-Reply-To header." />
          </>
        }
        value={
          view.replyRate !== null
            ? fmtPct(view.replyRate, view.replyRate >= 1 ? 1 : 2)
            : "—"
        }
        hint={`${fmtCompact(repliesSummary?.total ?? 0)} replies · ${range}`}
        sparkline={view.repliesSpark}
        vsPrevious={vsPrevious}
        metricKey="replies"
        highlighted={highlightedMetric === "replies"}
      />
    ),
    bounces: (
      <KpiCard
        label="Bounce rate"
        value={fmtRate(view.flat.bounces_total, view.emailsSent ?? 0)}
        hint={`${fmtCompact(view.flat.bounces_total)} bounces · ${range}`}
        sparkline={view.bouncesSpark}
        deltaPct={
          view.bounceRate !== null && view.prevBounceRate !== null
            ? deltaPct(view.bounceRate, view.prevBounceRate)
            : null
        }
        inverted
        vsPrevious={vsPrevious}
        anomaly={!!view.anomalies.bounces}
        metricKey="bounces"
        highlighted={highlightedMetric === "bounces"}
      />
    ),
    unsubs: (
      <KpiCard
        label="Unsubscribes"
        value={fmtNum(view.flat.subscribers_unsubbed)}
        hint={`${fmtRate(view.flat.subscribers_unsubbed, view.emailsSent ?? 0)} of sent`}
        deltaPct={
          view.unsubRate !== null && view.prevUnsubRate !== null
            ? deltaPct(view.unsubRate, view.prevUnsubRate)
            : null
        }
        inverted
        metricKey="unsubs"
        highlighted={highlightedMetric === "unsubs"}
        vsPrevious={vsPrevious}
      />
    ),
    deliverability: (
      <KpiCard
        label={
          <>
            Deliverability
            <InlineHelp text="Composite 0–100 score: 100 − bounce rate − 30× complaint rate − 2× unsub rate. ≥90 healthy, ≥75 watch, &lt;75 at risk." />
          </>
        }
        value={view.deliverability ? `${view.deliverability.score}` : "—"}
        hint={
          !view.deliverability
            ? "needs send data"
            : view.deliverability.band === "good"
              ? "healthy"
              : view.deliverability.band === "warn"
                ? "needs attention"
                : "at risk"
        }
        vsPrevious={false}
        valueAccent={
          !view.deliverability
            ? undefined
            : view.deliverability.band === "good"
              ? "var(--pw-accent)"
              : view.deliverability.band === "warn"
                ? "var(--pw-warning)"
                : "var(--pw-danger)"
        }
      />
    ),
    revenue: view.revenueDisplay ? (
      <KpiCard
        label="Revenue (recent)"
        value={view.revenueDisplay}
        hint={`across ${campaigns.length} recent campaigns`}
        vsPrevious={false}
      />
    ) : null,
  };
}

function AnalyticsKpiGrid({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  if (dashboard.controller.loading && dashboard.controller.stats == null) {
    return (
      <div className="stat-grid">
        {Array.from({ length: 8 }, (_, index) => (
          <SkeletonStatCard key={index} />
        ))}
      </div>
    );
  }
  const cards = buildKpiCards(dashboard);
  return (
    <div className="stat-grid">
      {visibleKeys(dashboard.controller.kpiLayout).map((key) => {
        const card = cards[key];
        return card ? <Fragment key={key}>{card}</Fragment> : null;
      })}
    </div>
  );
}

export function AnalyticsTopPanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      {dashboard.view.showAnalyticsHero ? (
        <section
          className="analytics-overview-onboarding"
          aria-labelledby="analytics-empty-title"
        >
          <div>
            <span className="analytics-eyebrow">First signal</span>
            <h2 id="analytics-empty-title">
              Your decision workspace is ready for its first send.
            </h2>
            <p>
              Analytics becomes useful as soon as recipient-level send events
              arrive. The route will keep empty, unavailable, and delayed data
              visibly distinct while your workspace builds history.
            </p>
            <ol className="analytics-onboarding-steps">
              <li>
                <span>01</span>Send or import a campaign with recipient events
              </li>
              <li>
                <span>02</span>Return here after opens, clicks, and delivery
                outcomes arrive
              </li>
              <li>
                <span>03</span>Use Campaigns for evidence and Reports for
                scheduled distribution
              </li>
            </ol>
          </div>
          <div className="analytics-onboarding-orbit" aria-hidden="true" />
        </section>
      ) : null}
      {dashboard.controller.loading && dashboard.controller.stats == null ? (
        <div className="analytics-load-status" role="status">
          Building the first coherent analytics snapshot…
        </div>
      ) : null}
      <AnalyticsKpiGrid dashboard={dashboard} />
    </>
  );
}
