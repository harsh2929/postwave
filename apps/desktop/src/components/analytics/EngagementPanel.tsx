/**
 * EngagementPanel — Surfacing Analytics (#3) honest engagement panel.
 *
 * Two visually-separated subsections:
 *
 *   1. Trust Signals (HARD data, NO EstimateBadge, no hedging): the
 *      MPP-stripped human open rate (with the raw rate + bot-inflation
 *      delta), the reply rate, and the open-decoupled conversion count
 *      ("acted on without a recorded open"). Every number here is a count
 *      from the database — never estimated.
 *
 *   2. AI-surfacing estimate (EstimateBadge MANDATORY): a heuristic score
 *      derived purely from engagement proxies, with NO inbox-provider
 *      signal. The EstimateBadge is part of the header JSX — not
 *      conditional — so the score can NEVER render as fact. SampleSize and
 *      (only-when-low) ConfidenceNote are always disclosed.
 *
 * Honest-UI is the founding constraint: the word "estimate" appears in the
 * section label itself (not only the tooltip), the raw/human inflation
 * delta is shown so the operator sees what was stripped, and when
 * bot-filtering is OFF a disclosure note explains why the human row is
 * absent (approved decision D4). Backed by
 * apps/api/internal/analytics/engagement.go.
 */

import { type ReactElement } from "react";

import {
  aiSurfacingLabel,
  formatInflationDelta,
  shouldShowHumanRow,
} from "../../lib/engagement-helpers";
import { RateBar } from "../dashboard/RateBar";
import {
  ConfidenceNote,
  EstimateBadge,
  SampleSize,
} from "../common/Provenance";

/**
 * EngagementPanel wire shape — mirrors
 * apps/api/internal/analytics/analytics.go::EngagementPanel (returned by
 * GET /api/v1/campaigns/{id}/engagement). Declared here as the canonical
 * desktop type and re-exported by api-client (see the integrator manifest
 * for the api-client addition) so this component compiles standalone in
 * parallel work. All rates are fractions in [0,1], NOT percent.
 */
export interface EngagementPanel {
  campaign_id: string;
  delivered: number;
  human_unique_opens: number;
  human_open_rate: number; // fraction 0..1
  raw_open_rate: number; // fraction 0..1
  reply_count: number;
  distinct_replyers: number;
  reply_rate: number; // fraction 0..1
  open_decoupled_conversions: number;
  total_attributed_conversions: number;
  bot_signatures_applied: string[];
  ai_surfacing_score: number; // estimate, fraction 0..1
  ai_surfacing_basis: string[];
  ai_surfacing_confidence_level: "low" | "ok";
  ai_surfacing_sample_opens: number;
}

interface Props {
  panel: EngagementPanel | null;
  loading: boolean;
  error: string | null;
}

/** Format a FRACTION-unit rate (0.083 → "8.3%"). Wire rates here are
 *  fractions in [0,1] (engagement.go), so no /100 at the call site. */
function fmtRate(frac: number | null | undefined): string {
  const v = (typeof frac === "number" && Number.isFinite(frac) ? frac : 0) * 100;
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

const labelStyle = {
  fontSize: 11,
  color: "var(--pw-fg-subtle)",
  textTransform: "uppercase" as const,
  letterSpacing: 0.4,
};

const valueStyle = {
  fontSize: 22,
  fontWeight: 600,
  color: "var(--pw-fg)",
  lineHeight: 1.1,
};

const hintStyle = {
  fontSize: 11,
  color: "var(--pw-fg-muted)",
  marginTop: 2,
};

/** One trust-signal tile: label, big value, optional hint. Pure data — no
 *  estimate, no badge. */
function TrustStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={valueStyle}>{value}</div>
      {hint ? <div style={hintStyle}>{hint}</div> : null}
    </div>
  );
}

export function EngagementPanelSection({
  panel,
  loading,
  error,
}: Props): ReactElement | null {
  if (error) {
    return (
      <div className="card pw-chart-card">
        <div className="section-title" style={{ marginBottom: 4 }}>
          Engagement
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Couldn&apos;t load engagement signals: {error}
        </div>
      </div>
    );
  }
  if (loading || !panel) {
    return (
      <div className="card pw-chart-card">
        <div className="section-title" style={{ marginBottom: 4 }}>
          Engagement
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {loading ? "Loading engagement signals…" : "No engagement data."}
        </div>
      </div>
    );
  }

  const showHuman = shouldShowHumanRow(panel);
  const sigs = Array.isArray(panel.bot_signatures_applied)
    ? panel.bot_signatures_applied
    : [];

  return (
    <div
      className="card pw-chart-card"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* ---------- Subsection 1: Trust Signals (hard data) ---------- */}
      <div>
        <div className="pw-chart-head" style={{ marginBottom: 10 }}>
          <div className="section-title" style={{ marginBottom: 0 }}>
            Trust signals
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Hard data · no estimates
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 12,
          }}
        >
          {showHuman ? (
            <TrustStat
              label="Human open rate"
              value={fmtRate(panel.human_open_rate)}
              hint={`raw ${fmtRate(panel.raw_open_rate)} · ${formatInflationDelta(
                panel.raw_open_rate,
                panel.human_open_rate,
              )}`}
            />
          ) : (
            <TrustStat
              label="Open rate"
              value={fmtRate(panel.raw_open_rate)}
              hint="bot filtering not enabled — showing raw rate"
            />
          )}

          <TrustStat
            label="Reply rate"
            value={fmtRate(panel.reply_rate)}
            hint={`${panel.distinct_replyers.toLocaleString()} replyers / ${panel.delivered.toLocaleString()} delivered`}
          />

          <TrustStat
            label="Open-decoupled conversions"
            value={panel.open_decoupled_conversions.toLocaleString()}
            hint={
              panel.total_attributed_conversions > 0
                ? `acted on without a recorded open · ${panel.open_decoupled_conversions.toLocaleString()}/${panel.total_attributed_conversions.toLocaleString()} attributed`
                : "No attributed conversions yet"
            }
          />
        </div>

        {sigs.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 10,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--pw-fg-subtle)" }}>
              Stripped:
            </span>
            {sigs.map((s) => (
              <span key={s} className="badge" title="Bot signature excluded from the human open rate">
                {s}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* ------- Subsection 2: AI-surfacing ESTIMATE (badge required) ------- */}
      <div
        style={{
          borderTop: "1px solid var(--pw-border)",
          paddingTop: 14,
        }}
      >
        <div
          className="pw-chart-head"
          style={{ marginBottom: 10, gap: 8, alignItems: "center" }}
        >
          <div
            className="section-title"
            style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}
          >
            AI-surfacing estimate
            <EstimateBadge
              label="Estimate"
              title="Derived from engagement proxies (human open rate, reply rate, bounce rate). Not an inbox-provider signal."
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={valueStyle}>{fmtRate(panel.ai_surfacing_score)}</div>
          <div style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}>
            {aiSurfacingLabel(panel.ai_surfacing_score)}
          </div>
        </div>

        <div style={{ marginTop: 8, marginBottom: 6 }}>
          <RateBar
            value={panel.ai_surfacing_score}
            title={`AI-surfacing estimate: ${fmtRate(panel.ai_surfacing_score)}`}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <SampleSize n={panel.ai_surfacing_sample_opens} noun="opens analysed" />
          <ConfidenceNote
            level={panel.ai_surfacing_confidence_level === "low" ? "low" : undefined}
          />
          {Array.isArray(panel.ai_surfacing_basis) &&
          panel.ai_surfacing_basis.length > 0 ? (
            <span style={{ fontSize: 10, color: "var(--pw-fg-subtle)" }}>
              Based on: {panel.ai_surfacing_basis.join(", ")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
