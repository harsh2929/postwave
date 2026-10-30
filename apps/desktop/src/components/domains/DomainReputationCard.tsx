/**
 * DomainReputationCard — 0–100 reputation score + grade + 7d rate
 * breakdown + 14-day trend sparkline. Backed by:
 *   GET /api/v1/sender-reputation             (current snapshot)
 *   GET /api/v1/sender-reputation/{domain}/history  (lazy on mount)
 *
 * The card is intentionally self-contained: the parent passes the
 * cached current snapshot (so the slideover renders instantly), and
 * the card fetches the 14-day history lazily for the sparkline.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  api,
  type SenderReputationDomain,
  type SenderReputationHistoryPoint,
} from "../../lib/api-client";
import { Sparkline as CompactSparkline } from "../charts/Sparkline";

interface Props {
  domain: string;
  /** Cached current snapshot from the parent; null = no rep yet. */
  rep: SenderReputationDomain | null;
}

function gradeColor(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "excellent") return "var(--pw-accent)";
  if (g === "good")
    return "color-mix(in srgb, var(--pw-accent) 70%, var(--pw-warning))";
  if (g === "fair") return "var(--pw-warning)";
  if (g === "poor")
    return "color-mix(in srgb, var(--pw-warning) 60%, var(--pw-danger))";
  if (g === "critical") return "var(--pw-danger)";
  return "var(--pw-fg-muted)";
}

export function DomainReputationCard({ domain, rep }: Props): ReactElement {
  const [history, setHistory] = useState<SenderReputationHistoryPoint[] | null>(
    null,
  );

  useEffect(() => {
    if (!rep) return; // no rep yet → no history endpoint result either
    let cancelled = false;
    void api.getSenderReputationHistory(domain).then((r) => {
      if (cancelled) return;
      if (r.data?.days) setHistory(r.data.days);
    });
    return () => {
      cancelled = true;
    };
  }, [domain, rep]);

  if (!rep) {
    return (
      <div className="card" style={{ padding: 12 }}>
        <div className="section-title" style={{ marginBottom: 4 }}>
          Reputation
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          No sends in the last 7 days — reputation appears once outbound traffic
          flows through this domain.
        </div>
      </div>
    );
  }

  const color = gradeColor(rep.grade);
  return (
    <div
      className="card"
      style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div className="section-title" style={{ marginBottom: 0 }}>
        Reputation
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 14,
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
            color,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
            {rep.score}
          </div>
          <div className="tabular muted" style={{ fontSize: 10, marginTop: 2 }}>
            /100
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            fontSize: 11,
          }}
        >
          <RateRow
            label={rep.grade}
            value={`${rep.sends_last_7d.toLocaleString()} sends · 7d`}
            color={color}
            big
          />
          {/* Backend emits these as percents already (sender_reputation.go
              bounces/sends*100); render + threshold in percent units. The
              old *100 showed 100x, and fraction thresholds (>0.02) fired on
              every non-zero percent. */}
          <RateRow
            label="Bounce"
            value={`${rep.bounce_rate.toFixed(2)}%`}
            danger={rep.bounce_rate > 2}
          />
          <RateRow
            label="Complaint"
            value={`${rep.complaint_rate.toFixed(2)}%`}
            danger={rep.complaint_rate > 0.1}
          />
          <RateRow
            label="DMARC pass"
            value={`${rep.dmarc_pass_rate.toFixed(0)}%`}
            danger={rep.dmarc_pass_rate < 90}
          />
        </div>
      </div>

      {rep.blocklist_hits > 0 ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--pw-fg)",
            background: "color-mix(in srgb, var(--pw-danger) 8%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--pw-danger) 28%, transparent)",
            padding: "8px 10px",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--pw-danger)",
              flexShrink: 0,
            }}
          />
          <span>
            {rep.blocklist_hits} active blocklist listing
            {rep.blocklist_hits === 1 ? "" : "s"} in the last 24 hours.
          </span>
        </div>
      ) : null}

      {history && history.length > 1 ? (
        <div>
          <div
            className="muted"
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
            }}
          >
            14-day score trend
          </div>
          <TrendSpark points={history} />
        </div>
      ) : null}
    </div>
  );
}

function RateRow({
  label,
  value,
  color,
  big,
  danger,
}: {
  label: string;
  value: string;
  color?: string;
  big?: boolean;
  danger?: boolean;
}): ReactElement {
  return (
    <div>
      <div
        className="muted"
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: color ?? "var(--pw-fg-muted)",
        }}
      >
        {label}
      </div>
      <div
        className="tabular"
        style={{
          fontSize: big ? 13 : 12,
          color: danger ? "var(--pw-danger)" : "var(--pw-fg)",
          fontWeight: big ? 600 : 500,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** Fixed-scale, keyboard-inspectable daily reputation trend. */
function TrendSpark({
  points,
}: {
  points: SenderReputationHistoryPoint[];
}): ReactElement {
  const first = points[0]?.score ?? 0;
  const last = points.at(-1)?.score ?? first;
  return (
    <CompactSparkline
      values={points.map((point) => point.score)}
      labels={points.map((point) => point.day)}
      width={220}
      height={32}
      domain={[0, 100]}
      fill={false}
      trend={last > first ? "up" : last < first ? "down" : "flat"}
      valueLabel="reputation score out of 100"
      ariaLabel="14-day sender-reputation score trend"
    />
  );
}
