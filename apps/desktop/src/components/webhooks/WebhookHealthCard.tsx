/**
 * WebhookHealthCard — per-subscription 24h health summary. PR 1.
 *
 * Three segments: success ring + latency (p50/p99) + top errors.
 * Renders a named loading status, an actionable error, and an empty-state
 * when the webhook has had no deliveries in 24h (which would otherwise
 * show 0% and look broken).
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  getOutboundWebhookHealth,
  type OutboundWebhookHealth,
} from "../../lib/api-client";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";

interface Props {
  webhookId: string;
}

function fmtMs(ms: number): string {
  if (ms < 1) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function successRatePct(h: OutboundWebhookHealth): number {
  const denom = h.deliveries_succeeded + h.deliveries_failed;
  if (denom <= 0) return 0;
  return (h.deliveries_succeeded / denom) * 100;
}

export function WebhookHealthCard({ webhookId }: Props): ReactElement | null {
  const [h, setH] = useState<OutboundWebhookHealth | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoaded(false);
    setH(null);
    setError(null);
    void (async () => {
      try {
        const res = await getOutboundWebhookHealth(webhookId, {
          signal: controller.signal,
          requireOnline: true,
        });
        if (cancelled) return;
        setLoaded(true);
        if (res.error) {
          setError(res.error.message ?? "Webhook health request failed.");
          return;
        }
        if (res.data) {
          setH(res.data);
          return;
        }
        setError("Webhook health returned no data.");
      } catch (requestError) {
        if (!cancelled) {
          setLoaded(true);
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Webhook health request failed.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [webhookId, retryKey]);

  if (!loaded) {
    return (
      <div
        className="wh-health-card is-loading"
        role="status"
        aria-label="Loading webhook health for the trailing 24 hours"
      >
        <span
          className="skel"
          style={{ height: 16, width: "60%" }}
          aria-hidden="true"
        />
      </div>
    );
  }
  if (error || !h) {
    return (
      <div className="wh-health-card is-empty" role="alert">
        <span className="muted" style={{ fontSize: 11 }}>
          Couldn&apos;t load webhook health:{" "}
          {sanitizeInspectableText(error ?? "No response data").text}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRetryKey((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  if (h.deliveries_total === 0) {
    return (
      <div>
        <div className="wh-health-card is-empty" role="status">
          <span className="muted" style={{ fontSize: 11 }}>
            No webhook deliveries were recorded in the trailing 24 hours.
          </span>
        </div>
        <WebhookHealthData webhookId={webhookId} health={h} />
      </div>
    );
  }
  const pct = successRatePct(h);
  const skipped = h.deliveries_skipped ?? 0;
  const topErrors = h.top_errors ?? [];
  const tone = pct >= 95 ? "good" : pct >= 80 ? "ok" : "bad";
  const ringClr =
    tone === "good"
      ? "var(--pw-accent)"
      : tone === "ok"
        ? "var(--pw-warning)"
        : "var(--pw-danger)";

  return (
    <div>
      <div
        className="wh-health-card"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        }}
      >
        <SuccessRing pct={pct} color={ringClr} tone={tone} />
        <div className="wh-health-latency">
          <span className="wh-health-label">Latency</span>
          <span className="tabular" style={{ fontWeight: 600 }}>
            p50 {fmtMs(h.latency_p50_ms)}
          </span>
          <span className="muted tabular" style={{ fontSize: 11 }}>
            p99 {fmtMs(h.latency_p99_ms)}
          </span>
        </div>
        <div className="wh-health-errors">
          <span className="wh-health-label">
            {topErrors.length === 0 ? "No errors" : "Top errors"}
          </span>
          {topErrors.length === 0 ? (
            <span className="muted" style={{ fontSize: 11 }}>
              ✓ No failed delivery reasons in this window
            </span>
          ) : (
            topErrors.slice(0, 3).map((e, i) => {
              const safeMessage = sanitizeInspectableText(
                e.message || "Network error",
              ).text;
              return (
                <div
                  key={`${e.status_code}-${e.message}-${i}`}
                  className="wh-error-row"
                >
                  <span
                    className="wh-error-code"
                    style={{
                      color:
                        e.status_code >= 500
                          ? "var(--pw-danger)"
                          : "var(--pw-warning)",
                    }}
                  >
                    {e.status_code || "—"}
                  </span>
                  <span className="wh-error-msg">{safeMessage}</span>
                  <span className="muted tabular wh-error-count">
                    {e.count}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="wh-health-latency">
          <span className="wh-health-label">Cancelled</span>
          <span className="tabular" style={{ fontWeight: 600 }}>
            {skipped.toLocaleString()}
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Endpoint deletion · excluded from failures
          </span>
        </div>
      </div>
      <WebhookHealthData webhookId={webhookId} health={h} />
    </div>
  );
}

function WebhookHealthData({
  webhookId,
  health,
}: {
  webhookId: string;
  health: OutboundWebhookHealth;
}): ReactElement {
  const successRate = successRatePct(health);
  const skipped = health.deliveries_skipped ?? 0;
  const outcomeTotal = health.deliveries_succeeded + health.deliveries_failed;
  const rows = [
    {
      key: "total",
      label: "Total deliveries",
      value: health.deliveries_total.toLocaleString(),
      exportValue: health.deliveries_total,
      unit: "deliveries",
      detail: "All delivery attempts in the trailing 24-hour window",
    },
    {
      key: "success-rate",
      label: "Success rate",
      value: `${successRate.toFixed(1)}%`,
      exportValue: successRate,
      unit: "percent",
      detail: `${health.deliveries_succeeded.toLocaleString()} succeeded of ${outcomeTotal.toLocaleString()} completed deliveries`,
    },
    {
      key: "succeeded",
      label: "Succeeded",
      value: health.deliveries_succeeded.toLocaleString(),
      exportValue: health.deliveries_succeeded,
      unit: "deliveries",
      detail: "Trailing 24-hour outcome count",
    },
    {
      key: "failed",
      label: "Failed",
      value: health.deliveries_failed.toLocaleString(),
      exportValue: health.deliveries_failed,
      unit: "deliveries",
      detail: "Trailing 24-hour outcome count",
    },
    {
      key: "skipped",
      label: "Cancelled by endpoint deletion",
      value: skipped.toLocaleString(),
      exportValue: skipped,
      unit: "deliveries",
      detail: "Cancelled pending deliveries; excluded from failure rollups",
    },
    {
      key: "p50",
      label: "Latency p50",
      value: fmtMs(health.latency_p50_ms),
      exportValue: health.latency_p50_ms,
      unit: "milliseconds",
      detail: "Median delivery latency",
    },
    {
      key: "p99",
      label: "Latency p99",
      value: fmtMs(health.latency_p99_ms),
      exportValue: health.latency_p99_ms,
      unit: "milliseconds",
      detail: "99th-percentile delivery latency",
    },
    {
      key: "consecutive-failures",
      label: "Consecutive failures",
      value: health.consecutive_failures.toLocaleString(),
      exportValue: health.consecutive_failures,
      unit: "deliveries",
      detail: health.auto_disabled
        ? "Webhook is auto-disabled"
        : "Webhook is not auto-disabled",
    },
    ...Object.entries(health.status_breakdown ?? {}).map(([status, count]) => ({
      key: `status-${status}`,
      label: `HTTP ${status}`,
      value: Number(count).toLocaleString(),
      exportValue: Number(count),
      unit: "deliveries",
      detail: "HTTP status breakdown",
    })),
    ...(health.top_errors ?? []).map((item, index) => ({
      key: `error-${item.status_code}-${index}`,
      label: `Error ${item.status_code || "network"}`,
      value: item.count.toLocaleString(),
      exportValue: item.count,
      unit: "deliveries",
      detail: sanitizeInspectableText(item.message || "Network error").text,
    })),
  ];
  return (
    <AccessibleChartData
      title="Webhook health, trailing 24 hours"
      summary={`${health.deliveries_total.toLocaleString()} total deliveries; ${successRate.toFixed(1)}% of completed attempts succeeded; ${skipped.toLocaleString()} cancelled by endpoint deletion and excluded from failures; p50 latency ${fmtMs(health.latency_p50_ms)} and p99 latency ${fmtMs(health.latency_p99_ms)}.`}
      rowHeaderLabel="Metric"
      columns={[
        { key: "value", label: "Value" },
        { key: "unit", label: "Unit" },
        { key: "detail", label: "Definition or detail" },
      ]}
      rows={rows.map((row) => ({
        key: row.key,
        label: row.label,
        values: { value: row.value, unit: row.unit, detail: row.detail },
        exportValues: {
          value: row.exportValue,
          unit: row.unit,
          detail: row.detail,
        },
      }))}
      provenance={dux025Provenance("webhookHealth", {
        scope: `Webhook ${webhookId} · trailing 24 hours`,
        note:
          health.last_succeeded_at || health.last_failed_at
            ? `Latest recorded outcome: ${[
                health.last_succeeded_at,
                health.last_failed_at,
              ]
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1)}.`
            : "No delivery outcome timestamp was returned.",
      })}
      exportFileName="webhook-health-trailing-24-hours.csv"
      exportPrivacy="confidential"
    />
  );
}

function SuccessRing({
  pct,
  color,
  tone,
}: {
  pct: number;
  color: string;
  tone: "good" | "ok" | "bad";
}): ReactElement {
  // SVG ring with two arcs — gray track + colored portion.
  const r = 22;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <div className="wh-health-ring">
      <svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          stroke="var(--pw-bg-elev-2)"
          strokeWidth="5"
        />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 28 28)"
        />
        <text
          x="28"
          y="32"
          textAnchor="middle"
          fontSize="13"
          fontWeight="600"
          fill="var(--pw-fg)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {pct.toFixed(0)}%
        </text>
      </svg>
      <strong className="tabular">{pct.toFixed(1)}%</strong>
      <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        24h success ·{" "}
        {tone === "good" ? "healthy" : tone === "ok" ? "watch" : "degraded"}
      </span>
    </div>
  );
}
