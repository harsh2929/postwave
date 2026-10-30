/**
 * AnalyticsTab — growth, source-mix, engagement, and health-history
 * for a single list.
 *
 * Wave-2 (GAP-LS-046, 051, 052, 053, 054, 060). Each card hits its
 * own endpoint. Fetch failures render a distinct inline error (red,
 * role="alert", with the server message) — NOT the empty state — so
 * an outage or missing route is never mistaken for "no data yet".
 * The health-history card explicitly notes "—" when there isn't
 * enough scored history yet rather than silently rendering an empty
 * chart.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type List,
  type ListEngagementBreakdown,
  type ListGrowthResponse,
  type ListHealthHistoryPoint,
  type ListPerRowEngagement,
  type ListSourceMixResponse,
  listsAnalyticsApi,
} from "../../../lib/api-client";
import { fmtDate } from "../../../lib/format-date";
import { AccessibleChartData } from "../../charts/AccessibleChartData";
import { BarChart } from "../../charts/BarChart";
import { Donut } from "../../charts/Donut";
import { LineChart } from "../../charts/LineChart";
import { Sparkline } from "../../charts/Sparkline";

interface Props {
  list: List;
}

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  err: string | null;
}

function emptyLoad<T>(): LoadState<T> {
  return { data: null, loading: true, err: null };
}

function useListAnalytics(listId: string): {
  engagement: LoadState<ListEngagementBreakdown>;
  growth: LoadState<ListGrowthResponse>;
  health: LoadState<{ points: ListHealthHistoryPoint[] }>;
  perRow: LoadState<{ items: ListPerRowEngagement[]; total: number }>;
  sourceMix: LoadState<ListSourceMixResponse>;
} {
  const [growth, setGrowth] =
    useState<LoadState<ListGrowthResponse>>(emptyLoad);
  const [sourceMix, setSourceMix] =
    useState<LoadState<ListSourceMixResponse>>(emptyLoad);
  const [engagement, setEngagement] =
    useState<LoadState<ListEngagementBreakdown>>(emptyLoad);
  const [perRow, setPerRow] =
    useState<LoadState<{ items: ListPerRowEngagement[]; total: number }>>(
      emptyLoad,
    );
  const [health, setHealth] =
    useState<LoadState<{ points: ListHealthHistoryPoint[] }>>(emptyLoad);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [g, s, e, p, h] = await Promise.all([
        listsAnalyticsApi.growth(listId, 30),
        listsAnalyticsApi.sourceMix(listId),
        listsAnalyticsApi.engagementBreakdown(listId),
        listsAnalyticsApi.perRowEngagement(listId, { perPage: 10 }),
        listsAnalyticsApi.healthHistory(listId, 90),
      ]);
      if (cancelled) return;
      setGrowth({
        data: g.data ?? null,
        loading: false,
        err: g.error?.message ?? null,
      });
      setSourceMix({
        data: s.data ?? null,
        loading: false,
        err: s.error?.message ?? null,
      });
      setEngagement({
        data: e.data ?? null,
        loading: false,
        err: e.error?.message ?? null,
      });
      setPerRow({
        data: p.data ?? null,
        loading: false,
        err: p.error?.message ?? null,
      });
      setHealth({
        data: h.data ?? null,
        loading: false,
        err: h.error?.message ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [listId]);

  return { engagement, growth, health, perRow, sourceMix };
}

export function AnalyticsTab({ list }: Props): ReactElement {
  const { engagement, growth, health, perRow, sourceMix } = useListAnalytics(
    String(list.id),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Growth sparkline (subscribed/unsub/net) */}
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Subscriber growth
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Last {growth.data?.window_days ?? 30} days
          </div>
        </div>
        {growth.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : growth.err ? (
          <SectionError what="growth data" message={growth.err} />
        ) : !growth.data || growth.data.points.length === 0 ? (
          <div className="pw-chart-empty">
            No growth data yet. Once subscribers join or leave this list, the
            daily net trend will appear here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              <GrowthSparkCard
                label="Subscribed"
                values={growth.data.points.map((p) => p.subscribed)}
                labels={growth.data.points.map((p) => p.date)}
              />
              <GrowthSparkCard
                label="Unsubscribed"
                values={growth.data.points.map((p) => p.unsubscribed)}
                labels={growth.data.points.map((p) => p.date)}
                trend="down"
              />
              <GrowthSparkCard
                label="Net"
                values={growth.data.points.map((p) => p.net)}
                labels={growth.data.points.map((p) => p.date)}
              />
            </div>
            <AccessibleChartData
              title="List subscriber growth"
              summary={`${growth.data.points.length} daily growth buckets over ${growth.data.window_days ?? 30} days.`}
              rowHeaderLabel="Date"
              columns={[
                { key: "subscribed", label: "Subscribed" },
                { key: "unsubscribed", label: "Unsubscribed" },
                { key: "net", label: "Net change" },
              ]}
              rows={growth.data.points.map((point) => ({
                key: point.date,
                label: point.date,
                values: {
                  subscribed: point.subscribed.toLocaleString(),
                  unsubscribed: point.unsubscribed.toLocaleString(),
                  net: point.net.toLocaleString(undefined, {
                    signDisplay: "always",
                  }),
                },
                exportValues: {
                  subscribed: point.subscribed,
                  unsubscribed: point.unsubscribed,
                  net: point.net,
                },
              }))}
              provenance={{
                source: "Moosewave list-growth API",
                asOf: null,
                scope: `List ${list.id} · last ${growth.data.window_days ?? 30} days`,
              }}
              exportFileName="list-subscriber-growth.csv"
              exportPrivacy="confidential"
            />
          </div>
        )}
      </div>

      {/* Source mix donut */}
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Source mix
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            How members joined this list
          </div>
        </div>
        {sourceMix.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : sourceMix.err ? (
          <SectionError what="source mix" message={sourceMix.err} />
        ) : !sourceMix.data || sourceMix.data.slices.length === 0 ? (
          <div className="pw-chart-empty">
            No source attribution recorded yet for this list.
          </div>
        ) : (
          <Donut
            slices={sourceMix.data.slices.map((s) => ({
              label: s.source || "unknown",
              value: s.count,
            }))}
            centerLabel="members"
            title="List member source mix"
            valueLabel="Members"
            provenance={{
              source: "Moosewave list source-mix API",
              asOf: null,
              scope: `List ${list.id} · current membership`,
            }}
            exportFileName="list-member-source-mix.csv"
            exportPrivacy="confidential"
          />
        )}
      </div>

      {/* Engagement breakdown bar */}
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Engagement breakdown
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Subscribers grouped by opens + clicks
          </div>
        </div>
        {engagement.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : engagement.err ? (
          <SectionError what="engagement breakdown" message={engagement.err} />
        ) : !engagement.data || engagement.data.buckets.length === 0 ? (
          <div className="pw-chart-empty">
            Engagement breakdown appears once campaigns have been sent to this
            list.
          </div>
        ) : (
          <BarChart
            categories={engagement.data.buckets.map((b) => b.label)}
            series={[
              {
                label: "Subscribers",
                values: engagement.data.buckets.map((b) => b.count),
              },
            ]}
            height={180}
            title="List engagement breakdown"
            valueLabel="Subscribers"
            provenance={{
              source: "Moosewave list engagement-breakdown API",
              asOf: null,
              scope: `List ${list.id} · current server-defined engagement buckets`,
            }}
            exportFileName="list-engagement-breakdown.csv"
            exportPrivacy="confidential"
          />
        )}
      </div>

      {/* Health-history line chart */}
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            List health over time
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Daily score (0–100)
          </div>
        </div>
        {health.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : health.err ? (
          <SectionError what="health history" message={health.err} />
        ) : !health.data || health.data.points.length < 2 ? (
          <div className="pw-chart-empty">
            — Health history needs at least two scored days before a trend line
            can be drawn.
          </div>
        ) : (
          <LineChart
            data={health.data.points.map((p) => ({
              date: p.date,
              count: p.score,
            }))}
            height={160}
            title="List health over time"
            valueLabel="Health score (0–100)"
            provenance={{
              source: "Moosewave list health-history API",
              asOf: null,
              scope: `List ${list.id} · last 90 days`,
            }}
            exportFileName="list-health-history.csv"
            exportPrivacy="confidential"
          />
        )}
      </div>

      {/* Per-row engagement table preview */}
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Top engaged subscribers
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Highest opens + clicks in this list
          </div>
        </div>
        {perRow.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : perRow.err ? (
          <SectionError what="per-row engagement" message={perRow.err} />
        ) : !perRow.data || perRow.data.items.length === 0 ? (
          <div className="pw-chart-empty">
            Per-row engagement appears once campaigns have been delivered to
            members of this list.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {perRow.data.items.map((r) => (
              <div
                key={r.subscriber_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 60px 60px 90px",
                  gap: 8,
                  alignItems: "center",
                  padding: "6px 10px",
                  background: "var(--pw-bg-elev-2)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={r.email}
                >
                  {r.email}
                </span>
                <span
                  className="tabular"
                  style={{ textAlign: "right", fontSize: 11 }}
                >
                  {r.opens.toLocaleString()}
                </span>
                <span
                  className="tabular"
                  style={{ textAlign: "right", fontSize: 11 }}
                >
                  {r.clicks.toLocaleString()}
                </span>
                <span
                  className="muted tabular"
                  style={{ fontSize: 10, textAlign: "right" }}
                  title={r.last_engaged_at}
                >
                  {r.last_engaged_at ? fmtDate(r.last_engaged_at) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- helpers ----------------------------------------------- */

/** Small inline error for a failed card fetch — keeps a server
 *  failure visually distinct from a genuinely-empty section.
 *  (Mirrors SectionError in CampaignAnalyticsSlideover.) */
function SectionError({
  what,
  message,
}: {
  what: string;
  message: string;
}): ReactElement {
  return (
    <div
      className="pw-chart-empty"
      role="alert"
      style={{ color: "var(--pw-danger)" }}
    >
      Couldn&apos;t load {what}: {message}
    </div>
  );
}

function GrowthSparkCard({
  label,
  labels,
  values,
  trend,
}: {
  label: string;
  labels: string[];
  values: number[];
  trend?: "up" | "down" | "flat";
}): ReactElement {
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <div
      style={{
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <div
        className="muted"
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
      <div
        className="tabular"
        style={{ fontSize: 16, fontWeight: 600, color: "var(--pw-fg)" }}
      >
        {total.toLocaleString()}
      </div>
      <Sparkline
        values={values}
        labels={labels}
        trend={trend}
        width={120}
        height={24}
        valueLabel={label.toLocaleLowerCase()}
        ariaLabel={`${label} per day for the selected list-growth window`}
      />
    </div>
  );
}
