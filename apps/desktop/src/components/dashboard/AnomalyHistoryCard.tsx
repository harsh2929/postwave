/**
 * AnomalyHistoryCard — recent dashboard anomalies (PR 3).
 *
 * Reads from /api/v1/dashboard/anomalies. Hidden when the list is
 * empty (the card has no value on a healthy dashboard). Click any
 * row → drill into Analytics for that metric.
 *
 * Full-surface wiring (2026-06): rows whose metric is on the
 * anomaly-brief whitelist get an "Explain" action → AnomalyBriefModal
 * (LLM brief: summary / probable causes / suggested actions /
 * aggregates). Non-whitelisted metrics show no button rather than one
 * that 422s.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type AnomalyBriefMetric,
  apiSendTimeAssets as api,
} from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import { setSection } from "../../lib/store";

import { AnomalyBriefModal } from "./AnomalyBriefModal";
import {
  asBriefMetric,
  formatBriefMetricValue,
  formatUnscopedRevenueMinorUnits,
} from "./anomaly-brief-helpers";

const HISTORY_LIMIT = 8;

type AnomalyHistoryRange = "7d" | "30d" | "90d";

interface AnomalyHistoryRow {
  key: string;
  metric: string | null;
  value: number | null;
  mean: number | null;
  zScore: number | null;
  rangeUsed: AnomalyHistoryRange | null;
  detectedAt: string | null;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return safeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeDecimal(value: unknown, maxValue: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maxValue
    ? value
    : null;
}

function boundedZScore(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000
    ? value
    : null;
}

function decimal(value: number | null): string {
  return value === null ? "unavailable" : value.toFixed(1);
}

function safeMetric(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const metric = value.trim().toLowerCase();
  return metric.length > 0 &&
    metric.length <= 40 &&
    /^[a-z0-9 _-]+$/.test(metric)
    ? metric
    : null;
}

function safeRange(value: unknown): AnomalyHistoryRange | null {
  return value === "7d" || value === "30d" || value === "90d" ? value : null;
}

function explanationWindowDays(range: AnomalyHistoryRange | null): number {
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return 7;
}

function safeTimestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized.slice(0, 10) === value.slice(0, 10) ? normalized : null;
}

function normalizeRow(value: unknown, index: number): AnomalyHistoryRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const metric = safeMetric(row.metric);
  const detectedAt = safeTimestamp(row.detectedAt);
  const normalized: AnomalyHistoryRow = {
    key: `anomaly-${index + 1}`,
    metric,
    value: nonNegativeInteger(row.value),
    mean: nonNegativeDecimal(row.mean, Number.MAX_SAFE_INTEGER),
    zScore: boundedZScore(row.zScore),
    rangeUsed: safeRange(row.rangeUsed),
    detectedAt,
  };
  if (
    normalized.metric === null &&
    normalized.value === null &&
    normalized.mean === null &&
    normalized.zScore === null
  ) {
    return null;
  }
  return normalized;
}

function normalizeRows(value: unknown): AnomalyHistoryRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: AnomalyHistoryRow[] = [];
  for (const [index, item] of value.slice(0, HISTORY_LIMIT).entries()) {
    const row = normalizeRow(item, index);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function describe(row: AnomalyHistoryRow): string {
  const value =
    row.value === null
      ? "value unavailable"
      : row.metric === "revenue"
        ? formatUnscopedRevenueMinorUnits(row.value)
        : formatBriefMetricValue(row.metric, row.value);
  const mean =
    row.mean === null
      ? "unavailable"
      : row.metric === "revenue"
        ? formatUnscopedRevenueMinorUnits(row.mean)
        : decimal(row.mean);
  const z = decimal(row.zScore);
  if (!row.metric) {
    return `Metric unavailable · ${value} (mean ${mean}, z ${z})`;
  }
  const verb =
    row.metric === "bounces" ? "bounces spiked" : `${row.metric} spiked`;
  return `${verb} to ${value} (mean ${mean}, z ${z})`;
}

function openAnalytics(row: AnomalyHistoryRow): void {
  if (!row.metric) {
    setSection("analytics");
    return;
  }
  navigateDesktopRoute({
    section: "analytics",
    filters: [
      { key: "metric", value: row.metric },
      ...(row.rangeUsed ? [{ key: "range", value: row.rangeUsed }] : []),
    ],
  });
}

export function AnomalyHistoryCard(): ReactElement | null {
  const [rows, setRows] = useState<AnomalyHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [explain, setExplain] = useState<{
    metric: AnomalyBriefMetric;
    windowDays: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const response = await api.listDashboardAnomalies({
          limit: HISTORY_LIMIT,
        });
        if (cancelled) return;
        if (response.error) {
          setFailed(true);
          return;
        }
        const nextRows = normalizeRows(response.data?.items);
        if (!nextRows) {
          setFailed(true);
          return;
        }
        setRows(nextRows);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // A successful empty response is a healthy state, so the card stays out of
  // the dashboard. Loading and errors remain visible because both need user
  // feedback and, in the latter case, recovery.
  if (rows?.length === 0 && !failed && !loading) return null;

  return (
    <section
      className="card pw-dash-secondary-card pw-dash-secondary-anomalies"
      aria-labelledby="dashboard-anomalies-title"
      aria-busy={loading || undefined}
    >
      <header className="pw-dash-secondary-header">
        <div className="pw-dash-secondary-heading-group">
          <span className="pw-dash-secondary-eyebrow">Signal monitor</span>
          <h3 id="dashboard-anomalies-title">Recent anomalies</h3>
        </div>
        {rows && rows.length > 0 ? (
          <div className="pw-dash-secondary-header-actions">
            <span className="pw-dash-secondary-count tabular">
              {rows.length} detected
            </span>
            {!failed ? (
              <button
                type="button"
                className="btn btn-sm pw-dash-secondary-action"
                onClick={() => setAttempt((current) => current + 1)}
                disabled={loading}
                aria-busy={loading || undefined}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {failed ? (
        <div className="pw-dash-secondary-error" role="alert">
          <span>
            <strong>Anomaly history is unavailable</strong>
            <span>
              We couldn&apos;t check recent metric signals.
              {rows && rows.length > 0
                ? " The last verified signals remain visible below."
                : " Check your connection and try again."}
            </span>
          </span>
          <button
            type="button"
            className="btn pw-dash-secondary-action"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {loading && rows === null ? (
        <div
          className="pw-dash-secondary-skeleton-stack"
          role="status"
          aria-live="polite"
          aria-label="Checking for recent anomalies"
        >
          <span className="sr-only">Checking for recent anomalies</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="skel pw-dash-secondary-skeleton-line"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="pw-dash-secondary-list pw-dash-secondary-anomaly-list">
          {rows.map((r, i) => {
            const briefMetric = asBriefMetric(r.metric);
            return (
              <li key={`${r.key}-${i}`}>
                {r.metric ? (
                  <button
                    type="button"
                    className="pw-dash-secondary-anomaly-metric"
                    onClick={() => openAnalytics(r)}
                    aria-label={`Open Analytics for ${r.metric}`}
                  >
                    {r.metric}
                  </button>
                ) : (
                  <span className="pw-dash-secondary-anomaly-metric is-unavailable">
                    Metric unavailable
                  </span>
                )}
                <span className="pw-dash-secondary-anomaly-description">
                  {describe(r)}
                </span>
                <span className="pw-dash-secondary-anomaly-actions">
                  {briefMetric ? (
                    <button
                      type="button"
                      className="btn btn-ghost pw-dash-secondary-explain"
                      aria-label={`Ask AI to explain the ${r.metric ?? "metric"} anomaly`}
                      onClick={() => {
                        setExplain({
                          metric: briefMetric,
                          windowDays: explanationWindowDays(r.rangeUsed),
                        });
                      }}
                    >
                      Explain
                    </button>
                  ) : null}
                  <time
                    className="pw-dash-secondary-time tabular"
                    dateTime={r.detectedAt || undefined}
                  >
                    {fmtRel(r.detectedAt)}
                  </time>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <AnomalyBriefModal
        open={explain !== null}
        metric={explain?.metric ?? null}
        windowDays={explain?.windowDays}
        onClose={() => setExplain(null)}
      />
    </section>
  );
}
