/**
 * AuditInsightsRow — three at-a-glance cards above the audit list.
 * Refined Audit PR 1.
 *
 *   1. Actor mix       — % of events from user / api_key / agent /
 *                         system over the current window, with a
 *                         tiny stacked bar so the ratio is visible
 *                         at a glance.
 *   2. Top actions     — top-5 actions by count, ranked so spikes
 *                         (e.g. subscriber.delete suddenly 10x normal)
 *                         surface immediately.
 *   3. Activity        — events-per-day sparkline + headline total.
 *
 * All three driven by `getAuditStats` which shares the filter set
 * with the list — change the date range or actor type filter and
 * the cards recompute consistently with the rows below.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  api,
  type AuditStatsResponse,
  type RecentAnomalyRow,
} from "../../lib/api-client";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { Sparkline as CompactSparkline } from "../charts/Sparkline";

interface Props {
  stats: AuditStatsResponse | null;
  loading: boolean;
  /** Refined PR 1: clicking a top-action row drills the list filter
   *  to that exact action. Click an actor-type slice to filter by
   *  actor_type. Both optional — parent decides whether to wire. */
  onFilterAction?: (action: string) => void;
  onFilterActorType?: (actorType: string) => void;
  /** ueba-baselines (AI/Anomaly, P1): clicking a top-anomaly drills
   *  the audit list to that actor + (optionally) dominant anomaly
   *  type. Parent decides whether to wire. */
  onFilterActorLabel?: (actorLabel: string) => void;
}

const ACTOR_PALETTE: Record<string, string> = {
  user: "var(--pw-info)",
  api_key: "var(--pw-advisor)",
  agent: "var(--pw-success)",
  system: "var(--pw-fg-muted)",
};

function actorColor(label: string): string {
  return ACTOR_PALETTE[label] ?? "var(--pw-fg-muted)";
}

function fmtInt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "0";
}

const UEBA_DOMINANT_COLOR: Record<string, string> = {
  impossible_travel: "var(--pw-danger)",
  off_hours: "var(--pw-advisor)",
  escalation_chain: "var(--pw-danger)",
  peer_group: "var(--pw-info)",
};

function uebaColor(type: string): string {
  return UEBA_DOMINANT_COLOR[type] ?? "var(--pw-fg-muted)";
}

interface AuditUebaCardProps {
  anomalies: RecentAnomalyRow[];
  error: string | null;
  loading: boolean;
  onFilterActorLabel?: (actorLabel: string) => void;
  onRetry: () => void;
}

function detectorLabel(value: string): string {
  return value ? value.replaceAll("_", " ") : "Unclassified anomaly";
}

function AuditUebaCard({
  anomalies,
  error,
  loading,
  onFilterActorLabel,
  onRetry,
}: AuditUebaCardProps): ReactElement {
  return (
    <div
      className="audit-insight-card"
      data-testid="audit-ueba-tile"
      aria-busy={loading}
    >
      <h3 className="audit-insight-title">Top anomalies · last 24 hours</h3>
      <p className="muted audit-insight-description">
        UEBA — User and Entity Behavior Analytics
      </p>
      {loading ? (
        <div role="status" aria-live="polite" className="audit-insight-state">
          <span>Loading anomalies…</span>
          <span
            className="skel"
            style={{ height: 16, width: "100%" }}
            aria-hidden="true"
          />
        </div>
      ) : error ? (
        <div
          role="alert"
          className="audit-insight-error"
          data-testid="audit-ueba-error"
        >
          <span>Couldn&apos;t load anomalies: {error}</span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : anomalies.length === 0 ? (
        <div className="muted audit-insight-state">
          No anomalies scored in this window.
        </div>
      ) : (
        <ol className="audit-anomaly-list">
          {anomalies.map((anomaly) => (
            <li key={anomaly.auditId}>
              {onFilterActorLabel && anomaly.actorLabel ? (
                <button
                  type="button"
                  className="audit-anomaly-row"
                  onClick={() => onFilterActorLabel(anomaly.actorLabel)}
                  aria-label={`Filter audit events to actor ${anomaly.actorLabel}`}
                >
                  <span
                    className="audit-anomaly-swatch"
                    style={{ background: uebaColor(anomaly.dominantType) }}
                    aria-hidden="true"
                  />
                  <span className="audit-anomaly-content">
                    <span className="mono audit-anomaly-actor">
                      {anomaly.actorLabel}
                    </span>
                    <span className="muted audit-anomaly-meta">
                      {detectorLabel(anomaly.dominantType)} · {anomaly.bucket} ·
                      score {Math.round(anomaly.score)}
                    </span>
                  </span>
                  <span className="audit-row-filter-verb">Filter</span>
                </button>
              ) : (
                <div className="audit-anomaly-row is-static">
                  <span
                    className="audit-anomaly-swatch"
                    style={{ background: uebaColor(anomaly.dominantType) }}
                    aria-hidden="true"
                  />
                  <span className="audit-anomaly-content">
                    <span className="mono audit-anomaly-actor">
                      {anomaly.actorLabel ||
                        anomaly.action ||
                        `event ${anomaly.auditId}`}
                    </span>
                    <span className="muted audit-anomaly-meta">
                      {detectorLabel(anomaly.dominantType)} · {anomaly.bucket} ·
                      score {Math.round(anomaly.score)}
                      {onFilterActorLabel && !anomaly.actorLabel
                        ? " · Actor unavailable for filtering"
                        : ""}
                    </span>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AuditInsightsRow({
  stats,
  loading,
  onFilterAction,
  onFilterActorType,
  onFilterActorLabel,
}: Props): ReactElement {
  // ueba-baselines (AI/Anomaly, P1): top-3 anomalies in the last 24h
  // for the UEBA tile. Best-effort fetch — when the endpoint isn't
  // reachable (older deploy, 503), the tile renders an empty state.
  const [uebaTop, setUebaTop] = useState<RecentAnomalyRow[]>([]);
  const [uebaLoading, setUebaLoading] = useState<boolean>(true);
  // Distinguish "the endpoint failed" from "no anomalies scored" —
  // pre-fix both rendered the same healthy empty state.
  const [uebaErr, setUebaErr] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const uebaRequestRef = useRef<Promise<void> | null>(null);
  const loadUeba = useCallback((): Promise<void> => {
    const pending = uebaRequestRef.current;
    if (pending) return pending;
    setUebaLoading(true);
    setUebaErr(null);
    let request!: Promise<void>;
    request = (async (): Promise<void> => {
      try {
        const response = await api.getAuditRecentAnomalies(3);
        if (!mountedRef.current) return;
        if (response.error) {
          setUebaErr(response.error.message);
          return;
        }
        setUebaTop(response.data?.items ?? []);
      } catch (error) {
        if (!mountedRef.current) return;
        setUebaErr(
          error instanceof Error && error.message.trim()
            ? error.message
            : "The anomaly service did not respond.",
        );
      } finally {
        if (mountedRef.current) setUebaLoading(false);
        if (uebaRequestRef.current === request) uebaRequestRef.current = null;
      }
    })();
    uebaRequestRef.current = request;
    return request;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    void loadUeba();
    return () => {
      mountedRef.current = false;
    };
  }, [loadUeba]);
  if (!stats && loading) {
    return (
      <div
        className="audit-insights-row"
        role="status"
        aria-live="polite"
        aria-label="Loading audit insights"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="audit-insight-card" aria-hidden="true">
            <div className="skel" style={{ height: 12, width: 80 }} />
            <div
              className="skel"
              style={{ height: 22, width: 100, marginTop: 8 }}
            />
            <div
              className="skel"
              style={{ height: 12, width: 160, marginTop: 8 }}
            />
          </div>
        ))}
      </div>
    );
  }
  if (!stats) return <></>;

  /* Defensive: every list field below may arrive undefined during partial-
   * data windows (a stub response or a slow tail). Coerce once so every
   * .map / .reduce / .length read here is safe. */
  const byActorType = Array.isArray(stats.byActorType) ? stats.byActorType : [];
  const topActions = Array.isArray(stats.topActions) ? stats.topActions : [];
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const topActionMax = Math.max(
    1,
    ...topActions.map((action) => Math.max(0, action.count)),
  );
  const statsAsOf = daily.at(-1)?.date;

  return (
    <div
      className="audit-insights-row"
      role="group"
      aria-label="Audit insights"
      aria-busy={loading}
    >
      {/* Actor mix card */}
      <div className="audit-insight-card">
        <h3 className="audit-insight-title">Actor mix</h3>
        <CategoricalDistributionChart
          title="Audit events by actor type"
          segments={byActorType.map((row) => ({
            key: row.label,
            label: row.label,
            value: row.count,
            color: actorColor(row.label),
            ...(onFilterActorType
              ? { onSelect: () => onFilterActorType(row.label) }
              : {}),
          }))}
          valueLabel="Events"
          height={14}
          provenance={{
            source: "Moosewave audit statistics API",
            asOf: statsAsOf ?? null,
            scope: "Current audit statistics window",
          }}
          exportFileName="audit-events-by-actor-type.csv"
          exportPrivacy="confidential"
        />
      </div>

      {/* Top actions card */}
      <div className="audit-insight-card">
        <h3 className="audit-insight-title">Top actions</h3>
        {topActions.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            No events in this window.
          </div>
        ) : (
          <ol className="audit-top-actions">
            {topActions.slice(0, 5).map((action) => (
              <li key={action.label}>
                {onFilterAction ? (
                  <button
                    type="button"
                    className="audit-top-action-row"
                    onClick={() => onFilterAction(action.label)}
                    aria-label={`Filter audit events to action ${action.label}`}
                  >
                    <span className="audit-top-action-name mono">
                      {action.label}
                    </span>
                    <span className="audit-top-action-bar" aria-hidden>
                      <span
                        style={{
                          width: `${(Math.max(0, action.count) / topActionMax) * 100}%`,
                        }}
                      />
                    </span>
                    <span className="muted tabular audit-top-action-count">
                      {fmtInt(action.count)}
                    </span>
                    <span className="audit-row-filter-verb">Filter</span>
                  </button>
                ) : (
                  <div className="audit-top-action-row is-static">
                    <span className="audit-top-action-name mono">
                      {action.label}
                    </span>
                    <span className="audit-top-action-bar" aria-hidden>
                      <span
                        style={{
                          width: `${(Math.max(0, action.count) / topActionMax) * 100}%`,
                        }}
                      />
                    </span>
                    <span className="muted tabular audit-top-action-count">
                      {fmtInt(action.count)}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {topActions.length > 0 ? (
          <AccessibleChartData
            title="Top audit actions"
            summary={`${topActions.length} actions returned; the visual ranking shows the top ${Math.min(5, topActions.length)} by event count.`}
            rowHeaderLabel="Action"
            columns={[{ key: "count", label: "Events" }]}
            rows={topActions.map((action) => ({
              key: action.label,
              label: action.label,
              values: { count: action.count.toLocaleString() },
              exportValues: { count: action.count },
            }))}
            provenance={{
              source: "Moosewave audit statistics API",
              asOf: statsAsOf ?? null,
              scope: "Current audit statistics window",
            }}
            exportFileName="top-audit-actions.csv"
            exportPrivacy="confidential"
          />
        ) : null}
      </div>

      {/* Activity card */}
      <div className="audit-insight-card">
        <h3 className="audit-insight-title">Activity</h3>
        <div
          className="tabular"
          style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}
        >
          {fmtInt(stats.totalEvents)}{" "}
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            event{stats.totalEvents === 1 ? "" : "s"}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          across {daily.length} day{daily.length === 1 ? "" : "s"}
          {daily.length > 0 ? (
            <> · peak {fmtInt(Math.max(0, ...daily.map((d) => d.count)))}</>
          ) : null}
        </div>
        <div style={{ marginTop: 8 }}>
          <CompactSparkline
            values={daily.map((point) => point.count)}
            labels={daily.map((point) => point.date)}
            width={200}
            height={36}
            fill={false}
            color="var(--pw-info)"
            valueLabel="events"
            ariaLabel={`${daily.length} day audit activity`}
          />
        </div>
        {daily.length > 0 ? (
          <AccessibleChartData
            title="Daily audit activity"
            summary={`${daily.length} daily buckets and ${stats.totalEvents.toLocaleString()} total events in the current statistics window.`}
            rowHeaderLabel="Date"
            columns={[{ key: "events", label: "Events" }]}
            rows={daily.map((point) => ({
              key: point.date,
              label: point.date,
              values: { events: point.count.toLocaleString() },
              exportValues: { events: point.count },
            }))}
            provenance={{
              source: "Moosewave audit statistics API",
              asOf: statsAsOf ?? null,
              scope: "Current audit statistics window",
            }}
            exportFileName="daily-audit-activity.csv"
            exportPrivacy="confidential"
          />
        ) : null}
      </div>

      {/* UEBA tile — ueba-baselines (AI/Anomaly, P1).
       *  Lists the top-3 anomaly scores in the last 24h. Clicking a
       *  row drills the audit list to that actor. Detector type is
       *  colour-coded (impossible_travel/escalation_chain → danger,
       *  off_hours → advisor, peer_group → info). */}
      <AuditUebaCard
        anomalies={uebaTop}
        error={uebaErr}
        loading={uebaLoading}
        onFilterActorLabel={onFilterActorLabel}
        onRetry={() => void loadUeba()}
      />
    </div>
  );
}
