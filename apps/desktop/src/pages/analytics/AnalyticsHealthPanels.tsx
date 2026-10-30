import type { ReactElement } from "react";

import {
  fmtNum,
  fmtPct,
} from "../../components/analytics/AnalyticsPresentation";
import { HumanEngagedReachSection } from "../../components/analytics/HumanEngagedReachSection";
import { InboxProviderHealthCard } from "../../components/analytics/InboxProviderHealthCard";
import { Donut } from "../../components/charts/Donut";
import { Funnel } from "../../components/charts/Funnel";
import { Heatmap } from "../../components/charts/Heatmap";
import { InlineHelp } from "../../components/InlineHelp";
import type { AnalyticsDashboardProps } from "./analytics-dashboard-types";

export function DeliverabilityPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { bounces } = dashboard.controller;
  const { bounceRate, bounceSlices, complaintRate, deliverability } =
    dashboard.view;
  const scoreColor = !deliverability
    ? "var(--pw-fg)"
    : deliverability.band === "good"
      ? "var(--pw-accent)"
      : deliverability.band === "warn"
        ? "var(--pw-warning)"
        : "var(--pw-danger)";
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Deliverability health
          <InlineHelp text="A composite score (0–100) penalising bounces, complaints, and unsubs. Bounce and unsub rates follow the selected range; the complaint rate is measured across your 5 most recent campaigns (all-time), so it isn't range-scoped. Complaints above 0.1% will warn — that's the Postmaster Tools threshold." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Bounce types · complaints · score
        </div>
      </div>
      {bounces && bounces.total > 0 ? (
        <>
          <Donut
            slices={bounceSlices}
            centerLabel="bounces"
            title="Bounce-type mix"
            valueLabel="Bounces"
            provenance={{
              source: "Moosewave bounce analytics API",
              asOf:
                dashboard.controller.lastUpdated != null
                  ? new Date(dashboard.controller.lastUpdated).toISOString()
                  : null,
              scope: `Current workspace · ${dashboard.controller.range}`,
            }}
            exportFileName="bounce-type-mix.csv"
            exportPrivacy="confidential"
          />
          <div
            className="analytics-health-metrics"
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
              fontSize: 11,
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Bounce rate
              </div>
              <div
                className="tabular"
                style={{ color: "var(--pw-fg)", fontSize: 14 }}
              >
                {bounceRate !== null ? fmtPct(bounceRate) : "—"}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Complaint rate
              </div>
              <div
                className="tabular"
                style={{
                  color:
                    complaintRate !== null && complaintRate >= 0.1
                      ? "var(--pw-danger)"
                      : "var(--pw-fg)",
                  fontSize: 14,
                }}
              >
                {complaintRate !== null ? fmtPct(complaintRate, 2) : "—"}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Score
              </div>
              <div
                className="tabular"
                style={{ color: scoreColor, fontSize: 14 }}
              >
                {deliverability ? `${deliverability.score}/100` : "—"}
              </div>
            </div>
          </div>
          {complaintRate !== null && complaintRate >= 0.1 ? (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: 4,
                background:
                  "color-mix(in srgb, var(--pw-danger) 8%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--pw-danger) 28%, transparent)",
                fontSize: 11,
                color: "var(--pw-fg)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--pw-danger)",
                  flexShrink: 0,
                }}
              />
              <span>
                Complaint rate is above the 0.1% Postmaster Tools threshold —
                pause low-engagement segments before sending again.
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="pw-chart-empty">No bounces recorded yet</div>
      )}
    </div>
  );
}

export function ConversationsPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  const { range, repliesSummary, topResponders } = dashboard.controller;
  const hasResponders =
    topResponders &&
    Array.isArray(topResponders.senders) &&
    topResponders.senders.length > 0;
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Conversations
          <InlineHelp text="Inbound replies matched to campaign sends. 'Matched' counts replies we could attribute to a specific campaign send via In-Reply-To headers." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Top responders · {range}
        </div>
      </div>
      {hasResponders ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 16,
              fontSize: 12,
              paddingBottom: 8,
              borderBottom: "1px solid var(--pw-border)",
              marginBottom: 4,
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Total replies
              </div>
              <div
                className="tabular"
                style={{ color: "var(--pw-fg)", fontSize: 16 }}
              >
                {fmtNum(repliesSummary?.total ?? 0)}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Matched to campaign
              </div>
              <div
                className="tabular"
                style={{ color: "var(--pw-fg)", fontSize: 16 }}
              >
                {fmtNum(repliesSummary?.matched ?? 0)}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 10 }}>
                Unique responders
              </div>
              <div
                className="tabular"
                style={{ color: "var(--pw-fg)", fontSize: 16 }}
              >
                {fmtNum(topResponders.senders.length)}+
              </div>
            </div>
          </div>
          {topResponders.senders.slice(0, 6).map((sender, index) => (
            <div
              key={index}
              className="analytics-responder-row"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 60px 90px",
                gap: 8,
                alignItems: "center",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: "var(--pw-fg)",
                }}
                title={sender.recipient_email}
              >
                {sender.recipient_email}
              </span>
              <span className="tabular" style={{ color: "var(--pw-fg-muted)" }}>
                {fmtNum(Number(sender.replies))} ✉
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 11, textAlign: "right" }}
              >
                {sender.last_at
                  ? new Date(sender.last_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pw-chart-empty">No replies recorded yet</div>
      )}
    </div>
  );
}

export function CohortRetentionPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement | null {
  const {
    cohortColumns,
    cohortHeatmapImmatureCells,
    cohortHeatmapObservedCells,
    cohortHeatmapRows,
  } = dashboard.view;
  if (cohortHeatmapRows.length === 0) return null;
  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Cohort engagement
          <InlineHelp text="Each row groups subscribers by signup month. W1 is each subscriber's first seven days after their own signup—not the first week of the calendar month. A weekly open rate appears only after every subscriber in that cohort has completed the full week. Trailing blank cells are still maturing, never observed zeroes." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Observed open rate · subscriber-relative weeks
        </div>
      </div>
      {cohortColumns.length === 0 ? (
        <div className="pw-chart-empty" role="status">
          Still maturing — no signup cohort has completed a full seven-day
          window yet. The first observed rate will appear after W1 closes for
          every subscriber in a cohort.
        </div>
      ) : (
        <>
          <Heatmap
            rows={cohortHeatmapRows}
            columns={cohortColumns}
            metricLabel="Observed cohort open rate"
            valueLabel="Distinct openers divided by full cohort size"
            summary={`${cohortHeatmapObservedCells} observed weekly open-rate values. ${cohortHeatmapImmatureCells} trailing cells are blank because those cohort weeks have not fully matured; blank does not mean zero percent.`}
            provenance={{
              source: "Moosewave analytics cohorts API",
              asOf:
                dashboard.controller.lastUpdated != null
                  ? new Date(dashboard.controller.lastUpdated).toISOString()
                  : null,
              scope:
                "Current workspace · latest 12 signup-month cohorts · up to 8 fully matured weeks",
              note: "Weeks start at each subscriber's signup timestamp. Values use distinct openers divided by the full monthly cohort; immature trailing weeks are omitted, not zero-filled.",
            }}
            exportFileName="cohort-open-engagement.csv"
            exportPrivacy="confidential"
          />
          {cohortHeatmapImmatureCells > 0 ? (
            <p
              className="muted"
              role="note"
              style={{ fontSize: 11, lineHeight: 1.5, margin: "10px 0 0" }}
            >
              <strong style={{ color: "var(--pw-fg)" }}>
                Observed weeks only.
              </strong>{" "}
              {cohortHeatmapImmatureCells.toLocaleString()} trailing{" "}
              {cohortHeatmapImmatureCells === 1 ? "cell is" : "cells are"} still
              maturing and shown as —, not 0%.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function SequenceFunnelPanel({
  dashboard,
}: AnalyticsDashboardProps): ReactElement | null {
  const { seqFunnel } = dashboard.controller;
  if (!seqFunnel || seqFunnel.steps.length === 0) return null;
  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Top sequence funnel
          <InlineHelp text="Step-by-step performance of your top sequence: how many subscribers were reached, opened, and clicked at each step, plus drop-off between steps." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Reach / opens / clicks per step · sequence&nbsp;
          {seqFunnel.sequence_id.slice(0, 8)}…
        </div>
      </div>
      <Funnel
        rows={seqFunnel.steps.map((step) => ({
          label: `Step ${step.position + 1}`,
          value: step.reached,
          sub: { label: "opened", value: step.opened },
        }))}
        compact
        title="Top sequence funnel"
        valueLabel="Subscribers reached"
        provenance={{
          source: "Moosewave sequence analytics API",
          asOf:
            dashboard.controller.lastUpdated != null
              ? new Date(dashboard.controller.lastUpdated).toISOString()
              : null,
          scope: `Sequence ${seqFunnel.sequence_id} · current workspace`,
          note: "The funnel visual uses reached and opened counts; click rates remain in the adjacent exact summary.",
        }}
        exportFileName="top-sequence-funnel.csv"
        exportPrivacy="confidential"
      />
      <div
        className="muted"
        style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}
      >
        {seqFunnel.steps.map((step, index) => (
          <span key={index} style={{ marginRight: 12 }}>
            <strong style={{ color: "var(--pw-fg)" }}>
              Step {step.position + 1}
            </strong>{" "}
            · open {(step.open_rate * 100).toFixed(1)}% · click{" "}
            {(step.click_rate * 100).toFixed(1)}%
            {index > 0 && step.dropoff_pct > 0 ? (
              <> · drop {(step.dropoff_pct * 100).toFixed(1)}%</>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AnalyticsHealthPanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <div className="dash-grid" style={{ marginTop: 12 }}>
        <DeliverabilityPanel dashboard={dashboard} />
        <ConversationsPanel dashboard={dashboard} />
      </div>
      <div style={{ marginTop: 12 }}>
        <InboxProviderHealthCard windowLabel={dashboard.controller.range} />
      </div>
      {/* Directly under the delivery numbers it reframes: those count opens
          and clicks, which machines also generate. */}
      <HumanEngagedReachSection />
      <CohortRetentionPanel dashboard={dashboard} />
      <SequenceFunnelPanel dashboard={dashboard} />
    </>
  );
}
