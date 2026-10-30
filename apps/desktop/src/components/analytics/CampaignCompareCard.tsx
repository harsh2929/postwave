/**
 * CampaignCompareCard — side-by-side rate comparison across up to 6
 * campaigns. Backed by GET /api/v1/analytics/campaigns/compare, which
 * accepts up to 25 IDs but the practical UI sweet spot is 2–6 so a
 * 1440-wide canvas can fit five rate bars without horizontal scroll.
 *
 * UX choices:
 *   - Picker is a horizontal pill rack — clicking a pill toggles its
 *     campaign in/out of the compare set. Visual reinforces which are
 *     included by colour, not by hidden state.
 *   - The table renders five rate columns (open / click / bounce /
 *     complaint / unsub). Each cell shows the raw % plus an inline mini
 *     bar so eyes can scan magnitudes without doing arithmetic.
 *   - The best/worst campaign in each column gets a tiny annotation.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { type Campaign, type CompareRow, api } from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { type ConfidenceLabel, confidenceLabel, ztest } from "../../lib/stats";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

interface Props {
  /** Candidate pool — typically the 20 most recent campaigns. */
  candidates: Campaign[];
  /** IDs preselected on first render (e.g. the most recent 3). */
  initialIds: string[];
  /** Maximum number that can be selected at once. Default 6. */
  maxSelected?: number;
}

const RATE_COLS: Array<{
  key: keyof CompareRow;
  label: string;
  invert: boolean;
}> = [
  { key: "open_rate", label: "Open", invert: false },
  { key: "click_rate", label: "Click", invert: false },
  { key: "bounce_rate", label: "Bounce", invert: true },
  { key: "complaint_rate", label: "Complaint", invert: true },
  { key: "unsub_rate", label: "Unsub", invert: true },
];

function campaignKey(c: Campaign): string {
  return c.id == null ? "" : String(c.id);
}

function campaignLabel(c: Campaign): string {
  return c.name ?? c.subject ?? `Campaign ${campaignKey(c) || "—"}`;
}

/**
 * Format a FRACTION-unit rate (0.083 → "8.3%"). CompareRow rates are
 * fractions on the wire (analytics/service.go divides opens/clicks/etc.
 * by total_recipients with no ×100) — no unit guessing here, since a
 * genuine 0.8% rate must never render as 80%.
 */
function fmtRate(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  const v = frac * 100;
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

/** Fraction → percent for bar-width math. Same wire contract as fmtRate. */
function ratePct(frac: number): number {
  return Number.isFinite(frac) ? Math.max(0, frac * 100) : 0;
}

function comparisonCellLabel(
  row: CompareRow,
  column: (typeof RATE_COLS)[number],
  winners: Map<string, string>,
  losers: Map<string, string>,
  confidence: Map<string, ConfidenceLabel>,
): string {
  const key = String(column.key);
  const value = fmtRate(Number(row[column.key]));
  const winner = winners.get(key) === row.campaign_id;
  const loser = losers.get(key) === row.campaign_id;
  const confidenceLabelValue = confidence.get(key);
  if (winner) {
    if (confidenceLabelValue === "95" || confidenceLabelValue === "99") {
      return `${value} · best observed (${confidenceLabelValue}% confidence)`;
    }
    return `${value} · best observed (${confidenceLabelValue === "low_sample" ? "low sample" : "not statistically significant"})`;
  }
  if (loser) return `${value} · least favorable observed`;
  return value;
}

export function CampaignCompareCard({
  candidates,
  initialIds,
  maxSelected = 6,
}: Props): ReactElement {
  const [selected, setSelected] = useState<string[]>(() =>
    initialIds.slice(0, maxSelected),
  );
  const [rows, setRows] = useState<CompareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of candidates) m[campaignKey(c)] = campaignLabel(c);
    return m;
  }, [candidates]);

  useEffect(() => {
    if (selected.length < 2) {
      setRows([]);
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void api
      .getCampaignCompare(selected)
      .then((r) => {
        if (cancelled) return;
        if (r.error) {
          setErr(remoteFailureFromError(r.error).message);
          setRows([]);
        } else {
          setRows(r.data ?? []);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setErr(remoteFailureFromError({ kind: "network" }).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, reloadKey]);

  function toggle(id: string): void {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxSelected) return prev;
      return [...prev, id];
    });
  }

  if (candidates.length < 2) {
    return (
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Compare campaigns
          </div>
        </div>
        <div className="pw-chart-empty">
          Send at least two campaigns to enable side-by-side comparison.
        </div>
      </div>
    );
  }

  // Compute best/worst per column for annotations.
  const winners = new Map<string, string>();
  const losers = new Map<string, string>();
  // D09-analytics-dashboard#9: statistical confidence of the column winner
  // vs. its runner-up. The "best" pill is only shown when this clears 95% —
  // otherwise a handful of recipients could crown a "winner" on pure noise.
  // Rates are fractions in [0,1] on the wire; n = total_recipients.
  const confidence = new Map<string, ConfidenceLabel>();
  for (const col of RATE_COLS) {
    const comparableRows = rows.filter((row) =>
      Number.isFinite(Number(row[col.key])),
    );
    if (comparableRows.length < 2) continue;
    let best = comparableRows[0];
    let worst = comparableRows[0];
    if (!best || !worst) continue;
    for (const r of comparableRows) {
      const v = Number(r[col.key]);
      const bv = Number(best[col.key]);
      const wv = Number(worst[col.key]);
      if (col.invert) {
        if (v < bv) best = r;
        if (v > wv) worst = r;
      } else {
        if (v > bv) best = r;
        if (v < wv) worst = r;
      }
    }
    winners.set(String(col.key), best.campaign_id);
    losers.set(String(col.key), worst.campaign_id);

    // Runner-up = the best row among the rest, ranked in the column's
    // "better" direction. Two-sided z-test → confidence label (low_sample
    // when either side has < 100 recipients, ns when not significant).
    const ordered = [...comparableRows].sort((a, b) => {
      const av = Number(a[col.key]);
      const bv = Number(b[col.key]);
      return col.invert ? av - bv : bv - av;
    });
    const top = ordered[0];
    const runnerUp = ordered[1];
    if (top && runnerUp) {
      const res = ztest(
        Number(top[col.key]),
        top.total_recipients,
        Number(runnerUp[col.key]),
        runnerUp.total_recipients,
      );
      confidence.set(
        String(col.key),
        confidenceLabel(res, top.total_recipients, runnerUp.total_recipients),
      );
    }
  }

  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Compare campaigns
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {selected.length}/{maxSelected} selected · click pills to toggle
        </div>
      </div>

      <CampaignPicker
        candidates={candidates}
        selected={selected}
        maxSelected={maxSelected}
        onToggle={toggle}
      />

      {err ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Compare failed: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Comparing…
        </div>
      ) : null}

      {!loading && !err && selected.length < 2 ? (
        <div className="pw-chart-empty" role="status">
          Select at least two campaigns to compare their recipient-normalized
          rates.
        </div>
      ) : null}

      {!loading && rows.length === 0 && selected.length >= 2 ? (
        <div className="pw-chart-empty" role="status">
          No event data for the selected campaigns yet.
        </div>
      ) : null}

      {!loading && rows.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `minmax(160px, 1.5fr) 80px repeat(${RATE_COLS.length}, minmax(110px, 1fr))`,
              gap: "6px 12px",
              minWidth: 720,
              fontSize: 12,
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "var(--pw-fg-subtle)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              Campaign
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--pw-fg-subtle)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
                textAlign: "right",
              }}
            >
              Recipients
            </div>
            {RATE_COLS.map((c) => (
              <div
                key={String(c.key)}
                style={{
                  fontSize: 10,
                  color: "var(--pw-fg-subtle)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                {c.label}{" "}
                <span style={{ color: "var(--pw-fg-subtle)" }}>
                  {c.invert ? "(lower better)" : ""}
                </span>
              </div>
            ))}

            {rows.map((row) => (
              <CompareRowView
                key={row.campaign_id}
                row={row}
                name={nameById[row.campaign_id] ?? row.campaign_id.slice(0, 8)}
                winners={winners}
                losers={losers}
                confidence={confidence}
                allRows={rows}
              />
            ))}
          </div>
          <AccessibleChartData
            title="Selected campaign rate comparison"
            summary={`${rows.length} selected campaigns compared across recipient count, open, click, bounce, complaint and unsubscribe rates. Exact values include observed rank and statistical-confidence context.`}
            rowHeaderLabel="Campaign"
            columns={[
              { key: "recipients", label: "Recipients" },
              ...RATE_COLS.map((column) => ({
                key: String(column.key),
                label: `${column.label} rate${column.invert ? " (lower is better)" : ""}`,
              })),
            ]}
            rows={rows.map((row) => ({
              key: row.campaign_id,
              label: nameById[row.campaign_id] ?? row.campaign_id.slice(0, 8),
              values: {
                recipients: row.total_recipients.toLocaleString(),
                ...Object.fromEntries(
                  RATE_COLS.map((column) => [
                    String(column.key),
                    comparisonCellLabel(
                      row,
                      column,
                      winners,
                      losers,
                      confidence,
                    ),
                  ]),
                ),
              },
              exportValues: {
                recipients: row.total_recipients,
                ...Object.fromEntries(
                  RATE_COLS.map((column) => [
                    String(column.key),
                    comparisonCellLabel(
                      row,
                      column,
                      winners,
                      losers,
                      confidence,
                    ),
                  ]),
                ),
              },
            }))}
            provenance={dux025Provenance("campaignCompare", {
              scope: `${rows.length} returned campaigns · ${selected.length} selected campaign IDs`,
              note: "Best annotations use a two-proportion z-test and explicitly disclose low-sample or non-significant results.",
            })}
            exportFileName="selected-campaign-rate-comparison.csv"
            exportPrivacy="confidential"
          />
        </div>
      ) : null}
    </div>
  );
}

function CampaignPicker({
  candidates,
  selected,
  maxSelected,
  onToggle,
}: {
  candidates: Campaign[];
  selected: string[];
  maxSelected: number;
  onToggle: (id: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        marginBottom: 10,
      }}
      role="group"
      aria-label="Campaigns included in comparison"
    >
      {selected.length >= maxSelected ? (
        <span
          id="campaign-compare-selection-limit"
          className="muted"
          style={{ fontSize: 11 }}
        >
          Comparison limit reached; remove a selected campaign before adding
          another.
        </span>
      ) : null}
      {candidates.slice(0, 20).map((campaign) => {
        const id = campaignKey(campaign);
        const selectedForComparison = selected.includes(id);
        const disabled =
          !selectedForComparison && selected.length >= maxSelected;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              if (disabled) return;
              onToggle(id);
            }}
            aria-disabled={disabled || undefined}
            aria-describedby={
              disabled ? "campaign-compare-selection-limit" : undefined
            }
            aria-label={campaignLabel(campaign)}
            aria-pressed={selectedForComparison}
            style={{
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 999,
              border: "1px solid",
              borderColor: selectedForComparison
                ? "var(--pw-accent)"
                : "var(--pw-border)",
              background: selectedForComparison
                ? "color-mix(in srgb, var(--pw-accent) 14%, transparent)"
                : "var(--pw-bg-elev)",
              color: selectedForComparison
                ? "var(--pw-fg)"
                : "var(--pw-fg-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.5 : 1,
              maxWidth: 200,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {selectedForComparison ? "✓ " : ""}
            {campaignLabel(campaign)}
          </button>
        );
      })}
    </div>
  );
}

function CompareRowView({
  row,
  name,
  winners,
  losers,
  confidence,
  allRows,
}: {
  row: CompareRow;
  name: string;
  winners: Map<string, string>;
  losers: Map<string, string>;
  confidence: Map<string, ConfidenceLabel>;
  allRows: CompareRow[];
}): ReactElement {
  return (
    <>
      <div
        style={{
          color: "var(--pw-fg)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={name}
      >
        {name}
      </div>
      <div
        className="tabular muted"
        style={{ textAlign: "right", fontSize: 11 }}
      >
        {row.total_recipients.toLocaleString()}
      </div>
      {RATE_COLS.map((c) => {
        const v = Number(row[c.key]);
        const max =
          Math.max(...allRows.map((r) => ratePct(Number(r[c.key]))), 0.0001) ||
          0.0001;
        const pct = (ratePct(v) / max) * 100;
        const isWinner = winners.get(String(c.key)) === row.campaign_id;
        const isLoser = losers.get(String(c.key)) === row.campaign_id;
        // D09-analytics-dashboard#9: only crown a "best" when the winner is
        // significantly better than the runner-up (≥95%). Below that — or on a
        // low-sample column (< 100 recipients either side) — the lead is noise,
        // so we drop the pill rather than assert a winner.
        const conf = confidence.get(String(c.key));
        const showBest = isWinner && (conf === "95" || conf === "99");
        const barColor = c.invert
          ? isWinner
            ? "var(--pw-accent)"
            : isLoser
              ? "var(--pw-danger)"
              : "color-mix(in srgb, var(--pw-fg-muted) 60%, transparent)"
          : isWinner
            ? "var(--pw-accent)"
            : isLoser
              ? "var(--pw-danger)"
              : "color-mix(in srgb, var(--pw-accent) 50%, transparent)";
        return (
          <div
            key={String(c.key)}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--pw-fg)",
                fontVariantNumeric: "tabular-nums",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {fmtRate(v)}
              {showBest ? (
                <span
                  title={`Significantly better than the runner-up (${conf}% confidence, two-proportion z-test)`}
                  style={{
                    fontSize: 9,
                    color: "var(--pw-accent)",
                    background:
                      "color-mix(in srgb, var(--pw-accent) 14%, transparent)",
                    padding: "0 5px",
                    borderRadius: 999,
                  }}
                >
                  best · {conf}%
                </span>
              ) : null}
            </div>
            <div
              aria-hidden="true"
              style={{
                height: 4,
                background: "var(--pw-bg-elev-2)",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max(2, pct)}%`,
                  height: "100%",
                  background: barColor,
                  backgroundImage:
                    "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                }}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
