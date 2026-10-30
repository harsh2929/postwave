/**
 * MailchimpParityCard — compact native-desktop surface for the same
 * compatibility APIs the web app exposes in depth.
 */
import { type ReactElement, useEffect, useState } from "react";

import { api } from "../../lib/api-client";
// Hide-vs-error gating: only 404/501 (feature absent) hide the card;
// 401/403 are honest errors now that the parity reads accept session
// auth.
import { isFeatureAbsent } from "./parityFeatureGate";

type MetricState =
  | { kind: "ready"; label: string; value: string; detail: string }
  | { kind: "absent"; label: string }
  | { kind: "failed"; label: string };

type Snapshot = { metrics: MetricState[] };
type ReadyMetricPayload = { value: string; detail: string };
type ParityApiResult = {
  data?: unknown;
  error?: { status?: number } | null;
};

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeStatus(value: unknown): string {
  if (typeof value !== "string") return "files in studio";
  const trimmed = value.trim();
  return !trimmed || trimmed === "unknown"
    ? "files in studio"
    : trimmed.slice(0, 80);
}

function resolveMetric(
  settled: PromiseSettledResult<ParityApiResult>,
  label: string,
  ready: (data: Record<string, unknown>) => ReadyMetricPayload,
): MetricState {
  if (settled.status === "rejected") return { kind: "failed", label };
  if (settled.value.error) {
    return isFeatureAbsent(settled.value.error.status)
      ? { kind: "absent", label }
      : { kind: "failed", label };
  }
  try {
    return { kind: "ready", label, ...ready(recordValue(settled.value.data)) };
  } catch {
    return { kind: "failed", label };
  }
}

export function MailchimpParityCard(): ReactElement | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [absent, setAbsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const [planner, audience, studio, channels] = await Promise.allSettled([
        api.getMailchimpCampaignPlanner(),
        api.getMailchimpAudienceInsights(),
        api.getMailchimpContentStudio(),
        api.getMailchimpMultiChannelReadiness(),
      ]);
      if (cancelled) return;
      const metrics: MetricState[] = [
        resolveMetric(planner, "Planner", (data) => ({
          value: `${arrayLength(data.touchpoints)}/${arrayLength(data.tasks)}`,
          detail: "touchpoints/tasks",
        })),
        resolveMetric(channels, "Channels", (data) => ({
          value: arrayLength(data.channels).toLocaleString(),
          detail: "social, ads, surveys",
        })),
        resolveMetric(audience, "Audience", (data) => ({
          value: arrayLength(data.segment_dimensions).toLocaleString(),
          detail: "segment dimensions",
        })),
        resolveMetric(studio, "Content", (data) => ({
          value: arrayLength(data.files).toLocaleString(),
          detail: safeStatus(data.status),
        })),
      ];
      if (metrics.every((metric) => metric.kind === "absent")) {
        // The whole compatibility feature is absent on this deployment.
        setAbsent(true);
        setSnapshot(null);
        setLoading(false);
        return;
      }
      setAbsent(false);
      setSnapshot({ metrics });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (absent) return null;

  return (
    <section
      className="card pw-dash-secondary-card pw-dash-secondary-parity"
      aria-labelledby="dashboard-parity-title"
      aria-busy={loading || undefined}
    >
      <header className="pw-dash-secondary-parity-header">
        <div className="pw-dash-secondary-heading-group">
          <span className="pw-dash-secondary-eyebrow">Workspace coverage</span>
          <h3 id="dashboard-parity-title">Mailchimp parity surfaces</h3>
          <p>
            A readiness snapshot across campaign planning, audience
            intelligence, channels, and content studio.
          </p>
        </div>
      </header>
      {loading && !snapshot ? (
        <div
          className="pw-dash-secondary-metric-grid"
          role="status"
          aria-live="polite"
          aria-label="Loading workspace coverage"
        >
          <span className="sr-only">Loading workspace coverage</span>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="pw-dash-secondary-metric pw-dash-secondary-metric-skeleton"
              aria-hidden="true"
            >
              <span className="skel" />
              <span className="skel" />
              <span className="skel" />
            </span>
          ))}
        </div>
      ) : snapshot ? (
        <>
          {loading ? (
            <div className="pw-dash-secondary-refresh" role="status">
              Refreshing workspace coverage; showing the last confirmed
              snapshot.
            </div>
          ) : null}
          {snapshot.metrics.some((metric) => metric.kind === "failed") ? (
            <div className="pw-dash-secondary-error" role="alert">
              <span>
                <strong>Coverage snapshot incomplete</strong>
                <span>
                  Some coverage data couldn&apos;t be loaded. Available surfaces
                  remain visible below.
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
          <dl className="pw-dash-secondary-metric-grid">
            {snapshot.metrics.map((metric) =>
              metric.kind === "ready" ? (
                <MiniMetric
                  key={metric.label}
                  label={metric.label}
                  value={metric.value}
                  detail={metric.detail}
                />
              ) : (
                <MiniMetric
                  key={metric.label}
                  label={metric.label}
                  value={
                    metric.kind === "absent" ? "Not available" : "Unavailable"
                  }
                  detail={
                    metric.kind === "absent"
                      ? "Not shipped on this deployment"
                      : "Couldn’t load this surface"
                  }
                  unavailable
                />
              ),
            )}
          </dl>
        </>
      ) : null}
    </section>
  );
}

function MiniMetric({
  label,
  value,
  detail,
  unavailable = false,
}: {
  label: string;
  value: string;
  detail: string;
  unavailable?: boolean;
}) {
  return (
    <div
      className={`pw-dash-secondary-metric${unavailable ? " is-unavailable" : ""}`}
    >
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
      <dd>{detail}</dd>
    </div>
  );
}
