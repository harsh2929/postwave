/**
 * DashboardStatGrid — composes the four StatCards into the page's hero
 * row. Holds only ephemeral interaction state (drag-reorder + the
 * "Ask why" modal); data comes from the page.
 *
 * Full-surface wiring (2026-06): tiles whose metric is on the
 * anomaly-brief whitelist (opens / clicks / bounces — NOT subscribers)
 * carry a small "Ask why" affordance that opens the AI anomaly brief.
 */

import { type ReactElement, useId, useState } from "react";

import {
  type AnomalyBriefMetric,
  type DashboardStatsResponse,
  type DashboardPreviousWindow,
} from "../../lib/api-client";
import {
  formatDelta,
  isAnomalous,
  rateFromCounts,
  rateFromUniqueRecipients,
} from "../../lib/dashboard-helpers";

import { AnomalyBriefModal } from "./AnomalyBriefModal";
import { asBriefMetric } from "./anomaly-brief-helpers";
import { StatCard } from "./StatCard";

type DrilldownMetric = "subs" | "opens" | "clicks" | "bounces";

interface Props {
  stats: DashboardStatsResponse | null;
  loading: boolean;
  editing?: boolean;
  comparisonLabel?: string;
  onDrilldown: (metric: DrilldownMetric) => void;
  /** PR 4: ordered list of card keys. Unknown keys are skipped; missing
   *  keys are appended in default order so a partial saved layout still
   *  shows every card. */
  order?: readonly string[];
  /** PR 4: persist a newly-reordered list. No-op when undefined. */
  onReorder?: (next: string[]) => void;
}

const DEFAULT_ORDER: DrilldownMetric[] = ["subs", "opens", "clicks", "bounces"];

function fmtNum(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function fmtPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function DashboardStatGrid({
  stats,
  loading,
  editing = false,
  comparisonLabel = "vs previous period",
  onDrilldown,
  order,
  onReorder,
}: Props): ReactElement {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [askWhy, setAskWhy] = useState<AnomalyBriefMetric | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const reorderHelpId = useId();
  const reorderEnabled = editing && typeof onReorder === "function";

  /* Mounted in BOTH branches below so a background refresh (loading
   * flips true) doesn't unmount an open brief mid-LLM-call. */
  const briefModal = (
    <AnomalyBriefModal
      open={askWhy !== null}
      metric={askWhy}
      onClose={() => setAskWhy(null)}
    />
  );

  /* "Ask why" only for metrics the anomaly-brief endpoint accepts —
   * subscribers is not on the whitelist, so its tile gets no button. */
  const askWhyFor = (metric: string): (() => void) | undefined => {
    const m = asBriefMetric(metric);
    return m ? () => setAskWhy(m) : undefined;
  };

  if (loading) {
    return (
      <>
        <div
          id="dashboard-metrics"
          className="stat-grid"
          role="list"
          aria-label="Loading dashboard metrics"
          aria-busy="true"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stat-card dash-stat-card" role="listitem">
              <div className="skel dash-stat-skeleton-label" />
              <div className="skel dash-stat-skeleton-value" />
              <div className="skel dash-stat-skeleton-delta" />
              <div className="skel dash-stat-skeleton-chart" />
            </div>
          ))}
        </div>
        {briefModal}
      </>
    );
  }

  const s = stats ?? {};
  const prev: DashboardPreviousWindow = s.previous ?? {};
  const spark = s.sparklines ?? {};
  const anom = s.anomalies ?? {};
  const effectiveOrder = resolveOrder(order);

  const moveCard = (key: DrilldownMetric, delta: -1 | 1): void => {
    if (!reorderEnabled || !onReorder) return;
    const from = effectiveOrder.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= effectiveOrder.length) return;
    const next = [...effectiveOrder];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
    setReorderAnnouncement(
      `Moved ${metricLabel(key)} to position ${to + 1} of ${next.length}.`,
    );
  };

  const reorderProps = (key: DrilldownMetric) => {
    const index = effectiveOrder.indexOf(key);
    return {
      reorderPosition: index + 1,
      reorderTotal: effectiveOrder.length,
      onMoveEarlier:
        reorderEnabled && index > 0 ? () => moveCard(key, -1) : undefined,
      onMoveLater:
        reorderEnabled && index < effectiveOrder.length - 1
          ? () => moveCard(key, 1)
          : undefined,
    };
  };

  const finishCardDrag = (): void => {
    const next = finishReorder(
      draggingKey,
      overKey,
      effectiveOrder,
      reorderEnabled ? onReorder : undefined,
    );
    if (next && draggingKey) {
      setReorderAnnouncement(
        `Moved ${metricLabel(draggingKey)} to position ${next.indexOf(draggingKey) + 1} of ${next.length}.`,
      );
    }
    setDraggingKey(null);
    setOverKey(null);
  };

  const subsTotal = finiteNumber(s.subscribers_total);
  const subsAdded = finiteNumber(s.subscribers_added_30d);

  // Open/click rates use distinct campaign-recipient pairs. Delivered is the
  // preferred denominator, but delayed/missing delivery events can make it
  // smaller than the numerator; only then may the matching unique-sent count
  // be used. Bounce rate is uniquely bounced / uniquely sent because bounced
  // recipients are, by definition, not delivered. Gross event totals and
  // campaign counts are never substituted. Previous-window deltas use the
  // exact same contract.
  const openRate = rateFromUniqueRecipients(
    s.unique_opens_30d,
    s.unique_delivered_30d,
    s.unique_sent_30d,
  );
  const clickRate = rateFromUniqueRecipients(
    s.unique_clicks_30d,
    s.unique_delivered_30d,
    s.unique_sent_30d,
  );
  const bounceRate = rateFromCounts(s.unique_bounces_30d, s.unique_sent_30d);
  const prevOpenRate = rateFromUniqueRecipients(
    prev.unique_opens,
    prev.unique_delivered,
    prev.unique_sent,
  );
  const prevClickRate = rateFromUniqueRecipients(
    prev.unique_clicks,
    prev.unique_delivered,
    prev.unique_sent,
  );
  const prevBounceRate = rateFromCounts(prev.unique_bounces, prev.unique_sent);

  const cardByKey: Record<DrilldownMetric, ReactElement> = {
    subs: (
      <StatCard
        key="subs"
        cardKey="subs"
        draggable={reorderEnabled}
        isDragging={draggingKey === "subs"}
        isDropTarget={
          overKey === "subs" && draggingKey !== null && draggingKey !== "subs"
        }
        onDragStart={setDraggingKey}
        onDragEnter={setOverKey}
        onDragEnd={finishCardDrag}
        {...reorderProps("subs")}
        label="Subscribers"
        value={fmtNum(subsTotal)}
        delta={
          subsAdded === null
            ? null
            : formatDelta(subsAdded, prev.subscribers_added ?? null, "count")
        }
        sparkline={spark.subscribers}
        tone="good"
        comparisonLabel={comparisonLabel}
        onClick={editing ? undefined : () => onDrilldown("subs")}
      />
    ),
    opens: (
      <StatCard
        key="opens"
        cardKey="opens"
        draggable={reorderEnabled}
        isDragging={draggingKey === "opens"}
        isDropTarget={
          overKey === "opens" && draggingKey !== null && draggingKey !== "opens"
        }
        onDragStart={setDraggingKey}
        onDragEnter={setOverKey}
        onDragEnd={finishCardDrag}
        {...reorderProps("opens")}
        label="Open rate"
        onAskWhy={editing ? undefined : askWhyFor("opens")}
        askWhyLabel="Explain volume"
        askWhyAriaLabel="Explain open-event volume with AI"
        value={fmtPct(openRate)}
        unavailableContext={
          openRate === null ? "No verified delivery evidence" : undefined
        }
        delta={
          openRate !== null
            ? formatDelta(openRate, prevOpenRate, "percent-points")
            : null
        }
        tone="good"
        comparisonLabel={comparisonLabel}
        onClick={editing ? undefined : () => onDrilldown("opens")}
      />
    ),
    clicks: (
      <StatCard
        key="clicks"
        cardKey="clicks"
        draggable={reorderEnabled}
        isDragging={draggingKey === "clicks"}
        isDropTarget={
          overKey === "clicks" &&
          draggingKey !== null &&
          draggingKey !== "clicks"
        }
        onDragStart={setDraggingKey}
        onDragEnter={setOverKey}
        onDragEnd={finishCardDrag}
        {...reorderProps("clicks")}
        label="Click rate"
        onAskWhy={editing ? undefined : askWhyFor("clicks")}
        askWhyLabel="Explain volume"
        askWhyAriaLabel="Explain click-event volume with AI"
        value={fmtPct(clickRate)}
        unavailableContext={
          clickRate === null ? "No verified delivery evidence" : undefined
        }
        delta={
          clickRate !== null
            ? formatDelta(clickRate, prevClickRate, "percent-points")
            : null
        }
        tone="neutral"
        comparisonLabel={comparisonLabel}
        onClick={editing ? undefined : () => onDrilldown("clicks")}
      />
    ),
    bounces: (
      <StatCard
        key="bounces"
        cardKey="bounces"
        draggable={reorderEnabled}
        isDragging={draggingKey === "bounces"}
        isDropTarget={
          overKey === "bounces" &&
          draggingKey !== null &&
          draggingKey !== "bounces"
        }
        onDragStart={setDraggingKey}
        onDragEnter={setOverKey}
        onDragEnd={finishCardDrag}
        {...reorderProps("bounces")}
        label="Bounce rate"
        onAskWhy={editing ? undefined : askWhyFor("bounces")}
        askWhyLabel="Explain volume"
        askWhyAriaLabel="Explain bounce-event volume with AI"
        value={fmtPct(bounceRate)}
        unavailableContext={
          bounceRate === null ? "No verified send evidence" : undefined
        }
        delta={
          bounceRate !== null
            ? formatDelta(bounceRate, prevBounceRate, "percent-points")
            : null
        }
        tone="bad"
        preferredDirection="decrease"
        anomaly={isAnomalous(anom.bounces)}
        anomalyReason="Bounce volume is unusually high vs the trailing window"
        comparisonLabel={comparisonLabel}
        onClick={editing ? undefined : () => onDrilldown("bounces")}
      />
    ),
  };

  return (
    <>
      {reorderEnabled ? (
        <p id={reorderHelpId} className="visually-hidden">
          Reorder metrics with each card&apos;s Move earlier and Move later
          buttons, or by dragging. Focus stays on the moved card control.
        </p>
      ) : null}
      <div
        id="dashboard-metrics"
        className="stat-grid"
        data-tour="dashboard-stats"
        role="list"
        aria-label="Dashboard metrics"
        aria-describedby={reorderEnabled ? reorderHelpId : undefined}
      >
        {effectiveOrder.map((k) => cardByKey[k])}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </div>
      {briefModal}
    </>
  );
}

function metricLabel(key: string): string {
  switch (key) {
    case "subs":
      return "Subscribers";
    case "opens":
      return "Open rate";
    case "clicks":
      return "Click rate";
    case "bounces":
      return "Bounce rate";
    default:
      return "Metric";
  }
}

function resolveOrder(order: readonly string[] | undefined): DrilldownMetric[] {
  const known = new Set<DrilldownMetric>(DEFAULT_ORDER);
  const out: DrilldownMetric[] = [];
  if (order) {
    for (const k of order) {
      if (known.has(k as DrilldownMetric)) {
        out.push(k as DrilldownMetric);
      }
    }
  }
  // Append any defaults not already in the saved order — protects against
  // partial saves that would otherwise drop a card.
  for (const k of DEFAULT_ORDER) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function finishReorder(
  draggingKey: string | null,
  overKey: string | null,
  order: readonly DrilldownMetric[],
  onReorder: ((next: string[]) => void) | undefined,
): string[] | null {
  if (!onReorder || !draggingKey || !overKey || draggingKey === overKey)
    return null;
  const arr = [...order];
  const from = arr.indexOf(draggingKey as DrilldownMetric);
  const to = arr.indexOf(overKey as DrilldownMetric);
  if (from < 0 || to < 0) return null;
  arr.splice(to, 0, ...arr.splice(from, 1));
  onReorder(arr);
  return arr;
}
