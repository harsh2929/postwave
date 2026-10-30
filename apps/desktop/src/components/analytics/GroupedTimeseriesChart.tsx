/**
 * GroupedTimeseriesChart — per-group engagement time-series for the
 * Analytics page's grouped mode (Group by · Campaign / Domain).
 *
 * Calls GET /api/v1/analytics/timeseries?group_by=&metric=&days= via
 * `api.getAnalyticsTimeseries` and renders one MultiLineChart line per
 * campaign / sending domain. The server returns the top-10 groups plus
 * an "other" rollup, zero-filled across the window, so the chart never
 * has to invent gaps.
 *
 * Honest states (same contract as SuppressionsTrendChart):
 *   - 404 / 501 / `unsupported_dimension` → "not available on this
 *     server build" (older APIs don't ship the endpoint)
 *   - other error → the error message + a Retry button (never an
 *     empty chart pretending zero events)
 *   - all-zero    → "No <metric> recorded in the last N days"
 *
 * Metric chips (opens/clicks/bounces) and the 7/30/90d window toggle
 * live here; the page above only decides the dimension via GroupByMenu.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type AnalyticsTimeseriesGroupBy,
  type AnalyticsTimeseriesMetric,
  type AnalyticsTimeseriesResponse,
  api,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { MultiLineChart } from "../charts/MultiLineChart";
import {
  GROUPED_METRIC_LABELS,
  buildGroupedSeries,
  groupedSeriesTotal,
} from "./grouped-series";

const DAY_OPTIONS = [7, 30, 90] as const;
type GroupedDays = (typeof DAY_OPTIONS)[number];

const METRIC_OPTIONS: AnalyticsTimeseriesMetric[] = [
  "opens",
  "clicks",
  "bounces",
];

const DIMENSION_NOUN: Record<AnalyticsTimeseriesGroupBy, string> = {
  campaign: "campaign",
  domain: "sending domain",
};

interface Props {
  /** Which grouped dimension to chart — campaign or sending domain.
   *  (The page's GroupByMenu owns the selection.) */
  dimension: AnalyticsTimeseriesGroupBy;
  /** Chart height in px. Default 220 to match the other page charts. */
  height?: number;
}

export function GroupedTimeseriesChart({
  dimension,
  height = 220,
}: Props): ReactElement {
  const [metric, setMetric] = useState<AnalyticsTimeseriesMetric>("opens");
  const [days, setDays] = useState<GroupedDays>(30);
  const [resp, setResp] = useState<AnalyticsTimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** Bumped by the Retry button to refire the effect. */
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setUnavailable(false);
    void api
      .getAnalyticsTimeseries({ groupBy: dimension, metric, days })
      .then((res) => {
        if (cancelled) return;
        if (res.error) {
          const status = res.error.status ?? 0;
          if (
            res.error.kind === "http" &&
            (status === 404 ||
              status === 501 ||
              res.error.code === "unsupported_dimension")
          ) {
            setUnavailable(true);
          } else {
            setErr(remoteFailureFromError(res.error).message);
          }
          setResp(null);
        } else {
          setResp(res.data);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResp(null);
        setErr(remoteFailureFromError({ kind: "network" }).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dimension, metric, days, attempt]);

  const rawSeries = resp?.series ?? [];
  const series = buildGroupedSeries(rawSeries);
  const total = groupedSeriesTotal(rawSeries);
  const metricLabel = GROUPED_METRIC_LABELS[metric];
  const noun = DIMENSION_NOUN[dimension];

  return (
    <div
      className="card"
      style={{
        padding: 12,
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="stat-label">
            {metricLabel} by {noun} — last {days}d
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            One line per {noun}; top 10 by volume, the rest rolled into
            &ldquo;other&rdquo;. Click a legend entry to hide it, double-click
            to solo.
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="chips">
            {METRIC_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                className={`chip${metric === m ? " is-active" : ""}`}
                onClick={() => setMetric(m)}
                aria-pressed={metric === m}
              >
                {GROUPED_METRIC_LABELS[m]}
              </button>
            ))}
          </div>
          <div className="chips">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`chip${days === d ? " is-active" : ""}`}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>
      {loading ? (
        <div className="skel-row" style={{ height }} />
      ) : unavailable ? (
        <div className="muted" style={{ fontSize: 12, padding: "32px 0" }}>
          Grouped time-series for this dimension aren&apos;t available on this
          server build.
        </div>
      ) : err ? (
        <div style={{ padding: "24px 0" }}>
          <div className="field-error" style={{ marginBottom: 8 }}>
            Couldn&apos;t load the {metricLabel.toLowerCase()} breakdown: {err}
          </div>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Retry
          </button>
        </div>
      ) : series.length === 0 || total === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: "32px 0" }}>
          No {metricLabel.toLowerCase()} recorded in the last {days} days.
        </div>
      ) : (
        <MultiLineChart
          series={series}
          height={height}
          title={`${metricLabel} by ${noun}`}
          valueLabel={metricLabel}
          provenance={{
            source: "Moosewave grouped analytics timeseries API",
            asOf: null,
            scope: `Current workspace · ${dimension} · ${metric} · last ${days} days`,
            note: `Top 10 ${noun}s by volume; remaining groups are rolled into “other”.`,
          }}
          exportFileName={`${metric}-by-${dimension}-${days}d.csv`}
          exportPrivacy="confidential"
        />
      )}
    </div>
  );
}
