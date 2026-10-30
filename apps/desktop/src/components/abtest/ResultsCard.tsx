/**
 * ResultsCard — one card per A/B variant. Shows subject, sent count,
 * hit count, rate, and a tiny "control" chip on the control variant.
 *
 * Sparkline is intentionally out of scope for v1: the parent renders
 * a row of cards (side by side or stacked) and the cumulative-rate
 * chart is a future enhancement once the per-event-time data path
 * lands. Keeping the card lightweight means it can render in both
 * the desktop slideover and the web full-page view without dragging
 * a chart library along.
 */

import { type ReactElement } from "react";

export interface ResultsCardVariant {
  id: string;
  variant_index: number;
  variant_label?: string;
  subject?: string;
  sent: number;
  hits: number;
  rate: number;
  is_control: boolean;
}

export interface ResultsCardProps {
  variant: ResultsCardVariant;
  /** Human label for the metric (e.g. "Open rate"). */
  metricLabel: string;
  /** Highlights the card when this variant is the winner. */
  isWinner?: boolean;
}

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  const v = p > 1 ? p : p * 100;
  return `${v.toFixed(1)}%`;
}

export function ResultsCard(props: ResultsCardProps): ReactElement {
  const { variant, metricLabel, isWinner } = props;
  const label = variant.variant_label ?? `Variant ${variant.variant_index + 1}`;
  return (
    <div
      className="card"
      style={{
        padding: 12,
        borderRadius: 8,
        border: isWinner
          ? "1px solid color-mix(in srgb, var(--pw-success) 45%, transparent)"
          : "1px solid var(--pw-border)",
        background: isWinner ? "color-mix(in srgb, var(--pw-success) 6%, transparent)" : undefined,
        minWidth: 200,
        flex: "1 1 220px",
      }}
      data-testid={`results-card-${variant.variant_index}`}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <strong>{label}</strong>
        {variant.is_control ? (
          <span className="badge">Control</span>
        ) : null}
        {isWinner ? <span className="badge accent">Winner</span> : null}
      </div>
      <div
        className="muted"
        style={{
          marginBottom: 10,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={variant.subject}
      >
        {variant.subject ?? "(no subject)"}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <div>
          <div className="muted" style={{ fontSize: 11 }}>
            Sent
          </div>
          <div>{variant.sent.toLocaleString()}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>
            Hits
          </div>
          <div>{variant.hits.toLocaleString()}</div>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="muted" style={{ fontSize: 11 }}>
            {metricLabel}
          </div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {fmtPct(variant.rate)}
          </div>
        </div>
      </div>
    </div>
  );
}
