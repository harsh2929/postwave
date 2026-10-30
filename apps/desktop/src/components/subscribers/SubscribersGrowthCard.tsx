/**
 * SubscribersGrowthCard — SUB-124 audience growth report for the
 * Subscribers page. Renders a configurable (7/30/90d) daily series of
 * adds, verified exact-address withdrawals, and available lapse counts as
 * sparklines, with a
 * window-level delta summary ("+312 added (+4.1%) over 90d") and a churn
 * anomaly badge (z-score on the verified-withdrawal series, mirroring the
 * bounces anomaly elsewhere in the dashboard).
 *
 * Honest-UI: the series is populated by a daily snapshot worker, so new
 * tenants see an empty series until snapshots accumulate — the server's
 * `note` field is rendered verbatim, and the delta reads "not enough
 * snapshots" rather than a misleading "no change" below two points.
 * Anomaly detection is suppressed on sparse early data (< 7 points) to
 * avoid false positives. A 404 (routes not mounted on this deployment)
 * hides the card rather than nagging.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import {
  type AudienceGrowthResponse,
  audienceGrowthApi,
} from "../../lib/api/audience-growth";
import {
  type GrowthMetric,
  audienceDeltaCopy,
  audienceGrowthCaption,
  detectChurnAnomalies,
} from "./subscriber-growth-helpers";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { Sparkline as CompactSparkline } from "../charts/Sparkline";

const WINDOWS = [7, 30, 90] as const;
const SPARK_W = 280;
const SPARK_H = 40;
const DAILY_SNAPSHOT_STALE_MS = 36 * 60 * 60 * 1_000;
type GrowthFlowMetric = Exclude<GrowthMetric, "total">;

const METRICS: Array<{
  key: GrowthFlowMetric;
  label: string;
  color: string;
}> = [
  { key: "added", label: "Added", color: "var(--pw-success)" },
  {
    key: "unsubbed",
    label: "Verified withdrawals",
    color: "var(--pw-danger)",
  },
  { key: "lapsed", label: "Lapsed", color: "var(--pw-warning)" },
];

export function SubscribersGrowthCard(): ReactElement | null {
  const [days, setDays] = useState<number>(90);
  const [resp, setResp] = useState<AudienceGrowthResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const responseRef = useRef<AudienceGrowthResponse | null>(null);
  const confirmedDaysRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const canRetain =
      responseRef.current !== null && confirmedDaysRef.current === days;
    if (canRetain) {
      setLoading(false);
      setRefreshing(true);
    } else {
      responseRef.current = null;
      setResp(null);
      setLoading(true);
      setRefreshing(false);
    }
    setErr(null);
    setUnavailable(false);
    void (async () => {
      let res: Awaited<ReturnType<typeof audienceGrowthApi.get>>;
      try {
        res = await audienceGrowthApi.get({
          days,
          signal: controller.signal,
        });
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Audience growth request failed.",
        );
        return;
      }
      if (controller.signal.aborted) return;
      setLoading(false);
      setRefreshing(false);
      if (res.error) {
        if (res.error.kind === "network" && res.error.code === "aborted") {
          return;
        }
        if (res.error.kind === "http" && res.error.status === 404) {
          setUnavailable(true);
        } else {
          setErr(res.error.message);
        }
        return;
      }
      responseRef.current = res.data;
      confirmedDaysRef.current = days;
      setResp(res.data);
    })();
    return () => controller.abort();
  }, [days, reloadTick]);

  if (unavailable) return null;

  const series = resp?.series ?? [];
  const delta = resp ? audienceDeltaCopy(resp) : null;
  const deltaColor =
    delta?.tone === "up"
      ? "var(--pw-success)"
      : delta?.tone === "down"
        ? "var(--pw-danger)"
        : "var(--pw-fg-muted)";
  const unavailableMetrics = new Set(resp?.unavailable_metrics ?? []);
  const partialMetrics = new Set(resp?.partial_metrics ?? []);
  const availableMetrics = METRICS.filter(
    (metric) => !unavailableMetrics.has(metric.key),
  );
  const unavailableMetricLabels = METRICS.filter((metric) =>
    unavailableMetrics.has(metric.key),
  ).map((metric) => metric.label);
  const partialMetricLabels = METRICS.filter((metric) =>
    partialMetrics.has(metric.key),
  ).map((metric) => metric.label);
  const anomalies = unavailableMetrics.has("unsubbed")
    ? []
    : detectChurnAnomalies(series);
  const flowSummary: string[] = [];
  if (resp && !unavailableMetrics.has("added") && resp.total_added > 0) {
    flowSummary.push(`+${resp.total_added.toLocaleString()} added`);
  }
  if (resp && !unavailableMetrics.has("unsubbed") && resp.total_unsubbed > 0) {
    flowSummary.push(
      `−${resp.total_unsubbed.toLocaleString()} verified withdrawals`,
    );
  }
  const latestSnapshot = series.at(-1) ?? null;
  const asOf = latestSnapshot?.evaluated_at ?? null;
  const snapshotAge = asOf ? Date.now() - Date.parse(asOf) : null;
  const snapshotIsStale =
    snapshotAge !== null &&
    Number.isFinite(snapshotAge) &&
    snapshotAge > DAILY_SNAPSHOT_STALE_MS;

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 12,
        background: "var(--pw-bg-elev)",
      }}
      role="region"
      aria-label="Audience growth"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Audience growth</span>
        {anomalies.length > 0 ? (
          <span
            className="badge"
            style={{ fontSize: 10, color: "var(--pw-warning)" }}
          >
            {anomalies.length} verified-withdrawal spike
            {anomalies.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {unavailableMetricLabels.length > 0 ? (
          <span className="badge" style={{ fontSize: 10 }}>
            {unavailableMetricLabels.join(", ")} unavailable
          </span>
        ) : null}
        {partialMetricLabels.length > 0 ? (
          <span className="badge warning" style={{ fontSize: 10 }}>
            {partialMetricLabels.join(", ")} partial coverage
          </span>
        ) : null}
        {resp ? (
          <span
            className="badge"
            style={{ fontSize: 10 }}
            title={`Metric contract ${resp.metric_contract_version}`}
          >
            Verified ledger v2
          </span>
        ) : null}
        {snapshotIsStale ? (
          <span className="badge warning" style={{ fontSize: 10 }}>
            Snapshot stale
          </span>
        ) : null}
        {refreshing ? (
          <span className="badge" role="status" style={{ fontSize: 10 }}>
            Refreshing…
          </span>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => setReloadTick((tick) => tick + 1)}
          disabled={loading || refreshing}
          aria-label="Refresh audience growth"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <div className="chips" role="group" aria-label="Growth window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`chip${days === w ? " is-active" : ""}`}
              aria-pressed={days === w}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {loading && !resp ? (
        <div className="skel" style={{ height: SPARK_H + 24 }} />
      ) : err && !resp ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Couldn&apos;t load audience growth: {err}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            Retry
          </button>
        </div>
      ) : resp ? (
        <>
          {err ? (
            <div
              className="notice"
              role="alert"
              style={{ fontSize: 11, padding: "5px 8px", marginBottom: 8 }}
            >
              Refresh failed. Showing the last verified snapshot: {err}
              <button
                type="button"
                className="btn btn-xs"
                style={{ marginLeft: 8 }}
                onClick={() => setReloadTick((tick) => tick + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {series.length === 0 ? (
            <div
              className="notice"
              role="status"
              style={{ fontSize: 11, padding: "6px 8px", marginBottom: 8 }}
            >
              <strong>No verified snapshots yet.</strong> Growth history begins
              with the first verified daily run; incompatible legacy estimates
              are intentionally excluded.
            </div>
          ) : null}

          {/* Keep the complete server-owned scope available without turning an
              800+ character compliance definition into permanent chart chrome. */}
          {resp.note ? (
            <details
              style={{
                fontSize: 11,
                marginBottom: 8,
                color: "var(--pw-fg-muted)",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  width: "max-content",
                  maxWidth: "100%",
                }}
              >
                Metric scope and coverage
              </summary>
              <p
                className="notice"
                style={{ padding: "6px 8px", margin: "6px 0 0" }}
              >
                {resp.note}
              </p>
            </details>
          ) : null}

          {anomalies.length > 0 ? (
            <div
              className="notice"
              role="note"
              style={{ fontSize: 11, padding: "4px 8px", marginBottom: 8 }}
            >
              Review the verified-withdrawal spike
              {anomalies.length === 1 ? "" : "s"} on{" "}
              {anomalies
                .map(
                  (anomaly) =>
                    `${anomaly.date} (${anomaly.unsubbed.toLocaleString()} verified withdrawals)`,
                )
                .join(", ")}
              . Compare recent consent sources before using this audience.
            </div>
          ) : null}

          {series.length >= 2 && availableMetrics.length > 0 ? (
            <div
              style={{
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              {availableMetrics.map((m) => {
                const values = series.map((point) =>
                  m.key === "added"
                    ? point.added
                    : m.key === "unsubbed"
                      ? point.unsubbed
                      : point.lapsed,
                );
                const total = values.reduce((sum, value) => sum + value, 0);
                const first = values[0] ?? 0;
                const last = values.at(-1) ?? first;
                return (
                  <div key={m.key} style={{ minWidth: 200, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        marginBottom: 2,
                        fontSize: 11,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: m.color,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontWeight: 600 }}>{m.label}</span>
                      <span className="muted tabular">
                        {total.toLocaleString()} total
                      </span>
                    </div>
                    <CompactSparkline
                      values={values}
                      labels={series.map((point) => point.date)}
                      width={SPARK_W}
                      height={SPARK_H}
                      responsive
                      fill={false}
                      color={m.color}
                      trend={
                        last > first ? "up" : last < first ? "down" : "flat"
                      }
                      valueLabel={m.label.toLocaleLowerCase()}
                      ariaLabel={`${m.label} per day over the last ${resp.days} days, ${total.toLocaleString()} total`}
                    />
                  </div>
                );
              })}
            </div>
          ) : series.length === 1 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              One snapshot so far ({series[0]!.date}) — a trend needs at least
              two.
            </div>
          ) : series.length >= 2 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              Daily snapshots are present, but no verified flow metric is
              available to chart.
            </div>
          ) : null}

          {series.length > 0 && availableMetrics.length > 0 ? (
            <AccessibleChartData
              title="Audience growth by day"
              summary={`${series.length} daily snapshots over ${resp.days} days.`}
              rowHeaderLabel="Date"
              columns={availableMetrics.map((metric) => ({
                key: metric.key,
                label: metric.label,
              }))}
              rows={series.map((point) => ({
                key: point.date,
                label: point.date,
                values: Object.fromEntries(
                  availableMetrics.map((metric) => [
                    metric.key,
                    point[metric.key].toLocaleString(),
                  ]),
                ),
                exportValues: Object.fromEntries(
                  availableMetrics.map((metric) => [
                    metric.key,
                    point[metric.key],
                  ]),
                ),
              }))}
              provenance={{
                source: "Moosewave audience growth snapshot API",
                asOf,
                scope: `Current workspace · last ${resp.days} days`,
                note:
                  resp.note ||
                  "Daily snapshots may be sparse until the background worker has accumulated history.",
              }}
              exportFileName="audience-growth-by-day.csv"
              exportPrivacy="confidential"
            />
          ) : null}

          {/* Window-level summary. */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              fontSize: 12,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            {delta && !delta.insufficient ? (
              <span className="tabular" style={{ color: deltaColor }}>
                {flowSummary.length > 0 ? `${flowSummary.join(", ")} · ` : ""}
                {delta.label}
              </span>
            ) : (
              <span className="muted">{delta?.label}</span>
            )}
            <span className="muted">{audienceGrowthCaption(resp)}</span>
            {latestSnapshot ? (
              <span className="muted tabular">
                Latest snapshot · {latestSnapshot.total.toLocaleString()} total
                · evaluated{" "}
                {new Date(latestSnapshot.evaluated_at).toLocaleString()}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
