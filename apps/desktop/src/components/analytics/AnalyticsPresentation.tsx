/**
 * Analytics dashboard presentation primitives and deterministic formatters.
 *
 * Keeping these stateless boundaries separate leaves the page responsible for
 * data orchestration while cards, range controls, and hash mappings remain
 * independently testable.
 */

import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from "react";

import { getDesktopRoute } from "../../lib/desktop-router";
import { Sparkline } from "../charts/Sparkline";
import type { CustomRange } from "./DateRangePicker";
import type { Campaign, DashboardStatsResponse } from "../../lib/api-client";

export type Range = "7d" | "30d" | "90d";

export interface FlatStats {
  subscribers_total: number;
  subscribers_added: number;
  subscribers_unsubbed: number;
  opens_total: number;
  clicks_total: number;
  campaigns_sent: number;
  /** Per-recipient 'sent' events — the only valid rate denominator.
   *  null when the backend hasn't reported it (or it's 0); rates render
   *  "—" in that case rather than falling back to campaigns_sent. */
  emails_sent: number | null;
  bounces_total: number;
}

export const ZERO_STATS: FlatStats = {
  subscribers_total: 0,
  subscribers_added: 0,
  subscribers_unsubbed: 0,
  opens_total: 0,
  clicks_total: 0,
  campaigns_sent: 0,
  emails_sent: null,
  bounces_total: 0,
};

/**
 * D09-analytics-dashboard#1: the /dashboard/live SSE snapshot is always the
 * 30-day window. These are the only fields whose value is independent of the
 * selected range (7d/30d/90d), so they're the only ones safe to splice into a
 * range-scoped stats object from the live stream. Everything else (the *_30d
 * totals, previous, sparklines, anomalies) is range-scoped and must come from
 * the range-aware load() call, not the stream.
 */
export const RANGE_INDEPENDENT_SSE_KEYS = [
  "subscribers_total",
  "inbox_health",
  "recent_audit",
  "active_sequences_count",
  "subscribers",
  "active_sequences",
] as const;

export function readFlatStats(d: DashboardStatsResponse | null): FlatStats {
  if (!d) return { ...ZERO_STATS };
  const r = d as unknown as Record<string, unknown>;
  const num = (k: string): number => {
    const v = r[k];
    return typeof v === "number" ? v : 0;
  };
  const emailsSent = r["emails_sent_30d"];
  return {
    subscribers_total: num("subscribers_total"),
    subscribers_added: num("subscribers_added_30d"),
    subscribers_unsubbed: num("subscribers_unsubbed_30d"),
    opens_total: num("opens_total_30d"),
    clicks_total: num("clicks_total_30d"),
    campaigns_sent: num("campaigns_sent_30d"),
    emails_sent:
      typeof emailsSent === "number" && emailsSent > 0 ? emailsSent : null,
    bounces_total: num("bounces_total_30d"),
  };
}

export function readSparkline(
  d: DashboardStatsResponse | null,
  key: string,
): number[] {
  if (!d) return [];
  const sp = d.sparklines;
  if (sp && Array.isArray(sp[key])) return sp[key] as number[];
  return [];
}

export function rangeDays(r: Range): number {
  return r === "7d" ? 7 : r === "30d" ? 30 : 90;
}

export function xTickStrideFor(r: Range): number {
  if (r === "7d") return 1;
  if (r === "30d") return 5;
  return 15;
}

export function pctNum(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return (num / denom) * 100;
}

export function fmtPct(p: number, digits = 1): string {
  return `${p.toFixed(digits)}%`;
}

/** Display helper: format a rate, or show "—" when the denominator
 *  is zero. Fresh workspaces (campaigns_sent = 0) used to show
 *  misleading "0.0%" values for open/click/bounce/unsub rates instead
 *  of "no data yet". */
export function fmtRate(num: number, denom: number, digits = 1): string {
  if (denom <= 0) return "—";
  return fmtPct((num / denom) * 100, digits);
}

export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function campaignKey(campaign: Campaign): string {
  return campaign.id == null ? "" : String(campaign.id);
}

export function deltaPct(curr: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((curr - prev) / prev) * 100;
}

/**
 * Trigger label for an applied custom range. The data layer only
 * supports the 7d/30d/90d presets, so a custom pick snaps to the
 * nearest one — surface the effective window on the trigger instead
 * of pretending the exact dates are honored.
 */
export function customRangeTriggerLabel(
  r: CustomRange,
  snapped: Range,
): string {
  const parse = (s: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    // Local-time construction — avoids the UTC day-drift of `new Date(s)`.
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const fmt = (d: Date): string =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const a = parse(r.from);
  const b = parse(r.to);
  const dates =
    a && b
      ? r.from === r.to
        ? fmt(a)
        : `${fmt(a)} – ${fmt(b)}`
      : `${r.from} – ${r.to}`;
  return `${dates} · data shown for last ${snapped}`;
}

/* ---------- header --------------------------------------------------- */

export interface HeaderProps {
  range: Range;
  onRange: (r: Range) => void;
  customRange: CustomRange | null;
  onCustomRange: (r: CustomRange | null) => void;
  vsPrevious: boolean;
  onVsPrevious: (v: boolean) => void;
  liveStatus: "connecting" | "open" | "closed";
  liveUnavailable?: boolean;
  lastUpdated: number | null;
  onRefresh: () => void;
  refreshing?: boolean;
  scopeLabel?: string;
  /** Extra action slots — Export menu, Saved Views. */
  rightExtras?: React.ReactNode;
}

function RelativeSnapshotTime({
  acceptedAt,
}: {
  acceptedAt: number | null;
}): ReactElement {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (acceptedAt == null) return;
    const interval = window.setInterval(
      () => setClock((value) => value + 1),
      30_000,
    );
    return () => window.clearInterval(interval);
  }, [acceptedAt]);
  if (acceptedAt == null) return <span>No accepted snapshot yet</span>;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - acceptedAt) / 1000));
  const relative =
    ageSeconds < 45
      ? "just now"
      : ageSeconds < 3600
        ? `${Math.floor(ageSeconds / 60)}m ago`
        : `${Math.floor(ageSeconds / 3600)}h ago`;
  return (
    <span>
      Accepted{" "}
      <time dateTime={new Date(acceptedAt).toISOString()}>{relative}</time>
    </span>
  );
}

export function AnalyticsHeader(props: HeaderProps): ReactElement {
  const {
    range,
    onRange,
    customRange,
    onCustomRange,
    vsPrevious,
    onVsPrevious,
    liveStatus,
    liveUnavailable,
    lastUpdated,
    onRefresh,
    refreshing = false,
    scopeLabel = "Current workspace",
    rightExtras,
  } = props;
  const liveColor =
    liveStatus === "open"
      ? "var(--pw-accent)"
      : liveStatus === "connecting"
        ? "var(--pw-fg-muted)"
        : "var(--pw-fg-subtle)";
  return (
    <header className="analytics-route-header">
      <div className="analytics-title-row">
        <div className="analytics-title-copy">
          <span className="analytics-eyebrow">Decision intelligence</span>
          <h1 className="analytics-route-title">Analytics</h1>
          <p className="analytics-route-subtitle">
            Read growth, engagement, revenue, and delivery health as one
            decision workspace—without losing the scope behind each signal.
          </p>
        </div>
        <div className="analytics-freshness">
          <strong>Snapshot status</strong>
          <RelativeSnapshotTime acceptedAt={lastUpdated} />
          <span>Reporting timezone · UTC</span>
        </div>
      </div>

      <div className="analytics-scope-bar" aria-label="Analytics scope">
        <div
          className="analytics-live-state"
          data-state={liveStatus}
          role="status"
          aria-live="polite"
          title={
            liveStatus === "open"
              ? "The KPI stream is connected. Other panels remain point-in-time snapshots."
              : "The KPI stream is not currently connected. Loaded snapshots remain available."
          }
        >
          <span
            className="analytics-live-dot"
            style={
              { "--analytics-live-color": liveColor } as React.CSSProperties
            }
            aria-hidden="true"
          />
          <span className="analytics-live-copy">
            <strong>{scopeLabel}</strong>
            <span>
              {liveStatus === "open"
                ? "KPI stream live"
                : liveUnavailable
                  ? "KPI live updates unavailable"
                  : liveStatus === "connecting"
                    ? "Connecting KPI stream"
                    : "KPI stream paused"}
            </span>
          </span>
        </div>

        <div className="analytics-scope-controls">
          <div
            className="analytics-range-group"
            role="group"
            aria-label="Analytics reporting period"
          >
            {(["7d", "30d", "90d"] as Range[]).map((period) => (
              <button
                key={period}
                type="button"
                className="analytics-range-button"
                aria-pressed={range === period && customRange == null}
                onClick={() => {
                  onCustomRange(null);
                  onRange(period);
                }}
              >
                {period}
              </button>
            ))}
          </div>

          <label className="analytics-compare-toggle">
            <input
              type="checkbox"
              checked={vsPrevious}
              onChange={(event) => onVsPrevious(event.target.checked)}
            />
            Compare with prior period
          </label>

          <span className="analytics-scope-note">Snapshot panels · UTC</span>
        </div>

        <div className="analytics-header-actions">
          <button
            type="button"
            className="btn btn-sm analytics-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label={
              refreshing
                ? "Refreshing analytics snapshot"
                : "Refresh analytics snapshot"
            }
          >
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
          {rightExtras}
        </div>
      </div>
    </header>
  );
}

/* ---------- KPI card ------------------------------------------------- */

export interface KpiCardProps {
  label: ReactNode;
  value: string;
  hint?: string;
  sparkline?: number[];
  deltaPct?: number | null;
  /** When true, increases are bad (e.g. bounce rate). */
  inverted?: boolean;
  vsPrevious: boolean;
  anomaly?: boolean;
  /**
   * Health colour for derived cards (e.g. deliverability). Tints just the
   * value text — no left rail. Keeps the card uniform with every other
   * KPI in the strip and lets the number itself carry the signal.
   */
  valueAccent?: string;
  /** PR 2 follow-up: machine-readable metric key, used by the
   *  Dashboard drill-down hash pickup to scroll to + highlight
   *  the right card. */
  metricKey?: string;
  /** PR 2 follow-up: when true, briefly highlight the card to draw
   *  the eye after a drill-down navigation. */
  highlighted?: boolean;
}

export function KpiCard(props: KpiCardProps): ReactElement {
  const {
    label,
    value,
    hint,
    sparkline,
    vsPrevious,
    anomaly,
    valueAccent,
    metricKey,
    highlighted,
  } = props;
  const dp = props.deltaPct ?? null;
  const inverted = props.inverted ?? false;

  let deltaClass: "up" | "down" | "flat" = "flat";
  let deltaText = "";
  if (dp != null) {
    if (Math.abs(dp) < 0.05) {
      deltaClass = "flat";
      deltaText = "no change";
    } else {
      const directionUp = dp > 0;
      const isGood = inverted ? !directionUp : directionUp;
      deltaClass = isGood ? "up" : "down";
      const arrow = directionUp ? "▲" : "▼";
      deltaText = `${arrow} ${Math.abs(dp).toFixed(1)}% vs prev`;
    }
  }

  return (
    <div
      className={`stat-card${highlighted ? " is-drilldown-highlight" : ""}`}
      data-kpi-metric={metricKey}
      style={{ position: "relative" }}
    >
      {anomaly ? (
        <span
          className="analytics-kpi-anomaly"
          aria-label="Anomaly detected. The latest daily count is more than 2.5 standard deviations from its trailing baseline."
        >
          Anomaly
        </span>
      ) : null}
      <div className="stat-label">{label}</div>
      <div
        className="stat-value tabular"
        style={valueAccent ? { color: valueAccent } : undefined}
      >
        {value}
      </div>
      {sparkline && sparkline.length >= 2 ? (
        <div style={{ marginTop: 4 }}>
          <Sparkline
            values={sparkline}
            height={26}
            width={120}
            trend={dp != null ? (dp > 0 ? "up" : "down") : undefined}
            color={
              inverted && dp != null && dp > 0 ? "var(--pw-danger)" : undefined
            }
          />
        </div>
      ) : null}
      {vsPrevious && dp != null ? (
        <>
          <div className={`stat-delta ${deltaClass} tabular`}>{deltaText}</div>
          {hint ? <div className="analytics-kpi-context">{hint}</div> : null}
        </>
      ) : (
        <div className="stat-delta subtle">{hint ?? ""}</div>
      )}
    </div>
  );
}

/* ---------- benchmark badge ----------------------------------------- */

export function BenchmarkBadge({ verdict }: { verdict: string }): ReactElement {
  const tone =
    verdict === "above"
      ? "var(--pw-accent)"
      : verdict === "below"
        ? "var(--pw-danger)"
        : "var(--pw-info)";
  const text =
    verdict === "above"
      ? "above baseline"
      : verdict === "below"
        ? "below baseline"
        : "on par";
  return (
    <span
      className="analytics-benchmark-badge"
      data-verdict={verdict}
      style={
        {
          "--analytics-benchmark-tone": tone,
        } as CSSProperties
      }
    >
      <span className="analytics-benchmark-badge-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

/* ---------- deliverability score ------------------------------------ */

export function deliverabilityScore(args: {
  bounceRate: number;
  complaintRate: number;
  unsubRate: number;
}): { score: number; band: "good" | "warn" | "bad" } {
  // Penalise complaints heavily (Postmaster Tools' threshold is 0.1%).
  const raw =
    100 - args.bounceRate - args.complaintRate * 30 - args.unsubRate * 2;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const band = score >= 90 ? "good" : score >= 75 ? "warn" : "bad";
  return { score, band };
}

/* ---------- main page ----------------------------------------------- */

/**
 * Refined Dashboard PR 2 follow-up: the Dashboard's StatCard
 * drill-down sets `#analytics?metric=opens&range=30d` and navigates
 * here. We read both params on mount: `range` seeds the chip state,
 * `metric` scrolls to + briefly highlights the matching KpiCard.
 *
 * Unknown values are ignored so older hashes (or hand-typed URLs)
 * never break the page.
 */
export function parseAnalyticsHash(): {
  range?: Range;
  metric?: string;
  focus?: string;
} {
  try {
    const route = getDesktopRoute();
    if (route.section === "analytics") {
      const filters = new Map(
        (route.filters ?? []).map((filter) => [filter.key, filter.value]),
      );
      const routed: { range?: Range; metric?: string; focus?: string } = {};
      const routedRange = filters.get("range");
      if (
        routedRange === "7d" ||
        routedRange === "30d" ||
        routedRange === "90d"
      ) {
        routed.range = routedRange;
      }
      const metric = filters.get("metric");
      if (metric) routed.metric = metric;
      const focus = filters.get("focus");
      if (focus) routed.focus = focus;
      if (Object.keys(routed).length > 0) return routed;
    }
    const h = typeof window === "undefined" ? "" : window.location.hash || "";
    const qIdx = h.indexOf("?");
    if (qIdx < 0) return {};
    const p = new URLSearchParams(h.slice(qIdx + 1));
    const out: { range?: Range; metric?: string; focus?: string } = {};
    const r = p.get("range");
    if (r === "7d" || r === "30d" || r === "90d") out.range = r;
    const m = p.get("metric");
    if (m) out.metric = m;
    const focus = p.get("focus");
    if (focus) out.focus = focus;
    return out;
  } catch {
    return {};
  }
}

/** Map a Dashboard drill-down metric key into the Analytics KpiCard
 *  it should reveal. Dashboard uses {opens|clicks|bounces|subs};
 *  Analytics has matching cards plus a couple of extras. */
export function metricKeyToCard(key: string): string | null {
  switch (key) {
    case "subs":
    case "subscribers":
      return "subscribers";
    case "opens":
    case "open_rate":
      return "opens";
    case "clicks":
    case "click_rate":
      return "clicks";
    case "bounces":
    case "bounce_rate":
      return "bounces";
    case "unsubs":
    case "unsubscribes":
      return "unsubs";
    default:
      return null;
  }
}

export const HIGHLIGHT_MS = 2500;
