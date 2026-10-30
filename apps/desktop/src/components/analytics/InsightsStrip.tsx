/**
 * InsightsStrip — auto-derived plain-English observations at the top of
 * the Analytics page. Every callout is a rule applied to data we already
 * have on the client, not an LLM call — so what shows up is auditable
 * and reproducible.
 *
 * Rules encoded (in order of priority):
 *   - Anomaly flags from the backend → "[metric] anomaly detected"
 *   - Complaint rate > 0.1% → deliverability danger callout
 *   - Period-over-period delta on open/click/reply rate ≥ 5%
 *   - Top performer: campaign whose open rate exceeds the fleet average
 *     by ≥ 30% (when at least 3 reports exist)
 *
 * The strip is dismissible per-session via sessionStorage; we don't want
 * to nag users who explicitly hid it within a session, but warnings
 * (e.g. a complaint spike) must come back on the next launch.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import type { CampaignReport } from "../../lib/api-client";

export interface InsightsStripInput {
  /** Anomaly flags from /api/v1/dashboard/stats */
  anomalies: Record<string, boolean>;
  openRate: number;
  prevOpenRate: number;
  clickRate: number;
  prevClickRate: number;
  bounceRate: number;
  prevBounceRate: number;
  complaintRate: number;
  campaignReports: Record<string, CampaignReport>;
  campaignNames: Record<string, string>;
  range: "7d" | "30d" | "90d";
}

interface Insight {
  id: string;
  kind: "anomaly" | "good" | "warn" | "info";
  title: string;
  detail?: string;
}

function deriveInsights(d: InsightsStripInput): Insight[] {
  const out: Insight[] = [];

  // 1. Anomalies — most urgent.
  for (const key of Object.keys(d.anomalies)) {
    if (d.anomalies[key]) {
      out.push({
        id: `anomaly-${key}`,
        kind: "anomaly",
        title: `${prettyMetric(key)} anomaly`,
        detail: `Daily ${key} count is more than 2 standard deviations from the trailing baseline.`,
      });
    }
  }

  // 2. Complaint-rate red line.
  if (d.complaintRate >= 0.1) {
    out.push({
      id: "complaint-spike",
      kind: "warn",
      title: `Complaints at ${d.complaintRate.toFixed(2)}%`,
      detail:
        "Above the 0.1% Postmaster Tools threshold. Pause low-engagement segments before sending.",
    });
  }

  // 3. Period-over-period rate moves ≥ 5pp.
  const deltas: Array<{
    label: string;
    curr: number;
    prev: number;
    inverted?: boolean;
  }> = [
    { label: "Open rate", curr: d.openRate, prev: d.prevOpenRate },
    { label: "Click rate", curr: d.clickRate, prev: d.prevClickRate },
    {
      label: "Bounce rate",
      curr: d.bounceRate,
      prev: d.prevBounceRate,
      inverted: true,
    },
  ];
  for (const m of deltas) {
    if (m.prev <= 0) continue;
    const deltaPp = m.curr - m.prev;
    if (Math.abs(deltaPp) < 5) continue;
    const directionUp = deltaPp > 0;
    const isGood = m.inverted ? !directionUp : directionUp;
    out.push({
      // Keyed by content (label + direction) so dismissing "Open rate up"
      // doesn't also suppress a later "Open rate down" within the session.
      id: `delta-${m.label}-${directionUp ? "up" : "down"}`,
      kind: isGood ? "good" : "warn",
      title: `${m.label} ${directionUp ? "up" : "down"} ${Math.abs(deltaPp).toFixed(1)}pp`,
      detail: `vs the previous ${d.range} (${m.prev.toFixed(1)}% → ${m.curr.toFixed(1)}%).`,
    });
  }

  // 4. Top performer.
  const reportEntries = Object.entries(d.campaignReports).filter(
    ([, r]) => r.sent >= 10,
  );
  if (reportEntries.length >= 3) {
    const rates = reportEntries.map(([id, r]) => ({
      id,
      rate: r.open_rate > 1 ? r.open_rate : r.open_rate * 100,
    }));
    const avg = rates.reduce((s, r) => s + r.rate, 0) / rates.length;
    const sorted = [...rates].sort((a, b) => b.rate - a.rate);
    const top = sorted[0];
    if (top && top.rate >= avg * 1.3 && top.rate >= 10) {
      const name = d.campaignNames[top.id] ?? "your top campaign";
      out.push({
        id: `top-${top.id}`,
        kind: "good",
        title: `${name}: ${top.rate.toFixed(0)}% open rate`,
        detail: `Beats the fleet average (${avg.toFixed(0)}%) by ${(((top.rate - avg) / avg) * 100).toFixed(0)}%.`,
      });
    }
  }

  return out.slice(0, 4);
}

function prettyMetric(key: string): string {
  if (key === "subscribers") return "Subscriber growth";
  if (key === "opens") return "Opens";
  if (key === "clicks") return "Clicks";
  if (key === "bounces") return "Bounces";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const DISMISS_KEY = "postwave.analytics.insights-dismissed.v1";

export function InsightsStrip(props: InsightsStripInput): ReactElement | null {
  const insights = useMemo(() => deriveInsights(props), [props]);
  // Per-session dismissals (the header's contract): sessionStorage clears
  // on app restart, so dismissing a complaint-spike warning today doesn't
  // permanently suppress all future ones.
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      // Drop the legacy forever-persisted localStorage copy so old
      // dismissals don't keep suppressing warnings across launches.
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* ignore */
    }
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed]));
    } catch {
      /* ignore quota errors */
    }
  }, [dismissed]);

  const visible = insights.filter((i) => !dismissed.has(i.id));
  if (visible.length === 0) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(4, visible.length)}, minmax(0, 1fr))`,
        gap: 8,
        marginBottom: 12,
      }}
    >
      {visible.map((i) => (
        <InsightCard
          key={i.id}
          insight={i}
          onDismiss={() => setDismissed((d) => new Set(d).add(i.id))}
        />
      ))}
    </div>
  );
}

function kindStyles(kind: Insight["kind"]): {
  accent: string;
  glyph: string;
  glyphBg: string;
} {
  if (kind === "anomaly") {
    return {
      accent: "var(--pw-warning)",
      glyph: "⚡",
      glyphBg: "color-mix(in srgb, var(--pw-warning) 16%, transparent)",
    };
  }
  if (kind === "warn") {
    return {
      accent: "var(--pw-danger)",
      glyph: "!",
      glyphBg: "color-mix(in srgb, var(--pw-danger) 16%, transparent)",
    };
  }
  if (kind === "good") {
    return {
      accent: "var(--pw-accent)",
      glyph: "✓",
      glyphBg: "color-mix(in srgb, var(--pw-accent) 16%, transparent)",
    };
  }
  return {
    accent: "var(--pw-fg-muted)",
    glyph: "i",
    glyphBg: "var(--pw-bg-elev-2)",
  };
}

function InsightCard({
  insight,
  onDismiss,
}: {
  insight: Insight;
  onDismiss: () => void;
}): ReactElement {
  const styles = kindStyles(insight.kind);
  return (
    <div
      style={{
        position: "relative",
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        minHeight: 56,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: styles.glyphBg,
          color: styles.accent,
          fontSize: 13,
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {styles.glyph}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--pw-fg)",
            lineHeight: 1.3,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {insight.title}
        </div>
        {insight.detail ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--pw-fg-muted)",
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {insight.detail}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss insight"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--pw-fg-subtle)",
          cursor: "pointer",
          padding: 0,
          width: 16,
          height: 16,
          lineHeight: 1,
          fontSize: 14,
        }}
      >
        ×
      </button>
    </div>
  );
}
