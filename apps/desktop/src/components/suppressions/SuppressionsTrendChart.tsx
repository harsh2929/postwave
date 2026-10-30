/**
 * SuppressionsTrendChart — line chart of suppressions added per day,
 * faceted by reason (GAP-LS-153).
 *
 * Restored after the trend endpoint shipped for real: calls
 * GET /api/v1/suppressions/trend?days=N via `suppressionsApi.trend`
 * and renders a MultiLineChart with one series per reason present in
 * the window (`points[].by_reason`).
 *
 * Honest states:
 *   - 404 / 501  → "endpoint not available on this server build"
 *   - other error → the error message + a Retry button (never an
 *     empty chart pretending zero suppressions)
 *   - all-zero    → "No suppressions added in the last N days"
 *   - <2 points   → textual summary (a one-point line is invisible)
 *
 * Window toggle (7/30/90d) lives here; defaults to 30d.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type SuppressionTrendResponse,
  suppressionsApi,
} from "../../lib/api-client";
import { MultiLineChart } from "../charts/MultiLineChart";
import { buildTrendSeries, trendTotal } from "./trend-series";

const DAY_OPTIONS = [7, 30, 90] as const;
export type TrendDays = (typeof DAY_OPTIONS)[number];

export function SuppressionsTrendChart(): ReactElement {
  const [days, setDays] = useState<TrendDays>(30);
  const [trend, setTrend] = useState<SuppressionTrendResponse | null>(null);
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
    void suppressionsApi.trend({ days }).then((res) => {
      if (cancelled) return;
      if (res.error) {
        const status = res.error.status ?? 0;
        if (res.error.kind === "http" && (status === 404 || status === 501)) {
          setUnavailable(true);
        } else {
          setErr(res.error.message);
        }
        setTrend(null);
      } else {
        setTrend(res.data);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [days, attempt]);

  const points = trend?.points ?? [];
  const series = trend ? buildTrendSeries(points) : [];
  const total = trendTotal(points);

  return (
    <div
      className="card"
      style={{
        padding: 12,
        marginBottom: 12,
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
          <div className="stat-label">Suppressions added — last {days}d</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Faceted by reason. Spikes correlate with deliverability events.
          </div>
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
      {loading ? (
        <div className="skel-row" style={{ height: 200 }} />
      ) : unavailable ? (
        <div className="muted" style={{ fontSize: 12, padding: "32px 0" }}>
          Trend endpoint not available on this server build.
        </div>
      ) : err ? (
        <div style={{ padding: "24px 0" }}>
          <div className="field-error" style={{ marginBottom: 8 }}>
            Couldn&apos;t load the suppressions trend: {err}
          </div>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Retry
          </button>
        </div>
      ) : total === 0 || series.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: "32px 0" }}>
          No suppressions added in the last {days} days.
        </div>
      ) : points.length < 2 ? (
        // A one-point "line" renders as nothing — summarize instead.
        <div className="muted" style={{ fontSize: 12, padding: "32px 0" }}>
          {total.toLocaleString()} suppression{total === 1 ? "" : "s"} added on{" "}
          {points[0]?.date ?? "—"}.
        </div>
      ) : (
        <MultiLineChart
          series={series}
          height={200}
          title="Suppressions added by reason"
          valueLabel="Suppressions"
          provenance={{
            source: "Moosewave suppression-trend API",
            asOf: null,
            scope: `Current workspace · last ${days} days`,
            note: "Each line represents a server-reported suppression reason.",
          }}
          exportFileName={`suppressions-by-reason-${days}d.csv`}
          exportPrivacy="confidential"
        />
      )}
    </div>
  );
}
