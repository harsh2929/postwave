/**
 * SuppressionsStatStrip — 4 KPIs that summarise the tenant's
 * suppression list.
 *
 *   • Total      — the SERVER's total for the current scope when the
 *                  parent passes one (authoritative); falls back to
 *                  the loaded-row count otherwise
 *   • Bounces    — hard_bounce + spam_trap (the deliverability-critical bucket)
 *   • Complaints — most damaging signal: ISPs penalise senders fast
 *   • New · 7d   — addresses added in the last 7 days (growth velocity)
 *
 * Bounces / Complaints / New·7d and the reason-mix bar derive from the
 * rows actually loaded (the server caps `per_page`); when the server
 * total exceeds the loaded sample the Total card discloses that the
 * derived KPIs cover only the first N loaded rows.
 *
 * The Total card includes an inline reason-mix bar so the user can
 * eyeball the distribution (hard_bounce vs spam_trap vs complaint vs
 * unsubscribe vs manual) without a separate chart.
 */

import { type ReactElement, useMemo } from "react";

import type { SuppressionRow } from "../../lib/api-client";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

interface Props {
  rows: SuppressionRow[];
  /**
   * Server-reported total for the current scope. Null/undefined when
   * the response carried no total (older builds) — the strip then
   * falls back to `rows.length`.
   */
  total?: number | null;
  /**
   * D05-consent-suppressions#16: human label of the active reason filter
   * (e.g. "Bounces"), or undefined/"" when no reason filter is active.
   *
   * When a reason chip is active the parent passes the reason-SCOPED
   * sample, which makes the ratio-based tones fire purely because of the
   * filter — e.g. the Bounces chip drives Bounces/Total to ~100% and the
   * red "investigate" flag lights up for a filter, not the data. When
   * this is set the strip suppresses those ratio-based danger tones/hints
   * and discloses that Total is scoped to the filter.
   */
  reasonScope?: string;
}

interface Counts {
  total: number;
  hardBounce: number;
  spamTrap: number;
  complaint: number;
  unsubscribe: number;
  manual: number;
  other: number;
  added7d: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function buildCounts(rows: SuppressionRow[]): Counts {
  const c: Counts = {
    total: rows.length,
    hardBounce: 0,
    spamTrap: 0,
    complaint: 0,
    unsubscribe: 0,
    manual: 0,
    other: 0,
    added7d: 0,
  };
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const r of rows) {
    const reason = (r.reason ?? "").toLowerCase();
    if (reason === "hard_bounce") c.hardBounce++;
    // D05-consent-suppressions#15: email_suppressions (the strip's data
    // source) canonicalizes trap rows to "spamtrap" via
    // subscribers/handlers.go normalizeSuppressionReason; "spam_trap" is
    // only the X1 enum alias. Match both so traps aren't silently binned
    // into "other".
    else if (reason === "spamtrap" || reason === "spam_trap") c.spamTrap++;
    else if (reason === "complaint" || reason === "spam_complaint")
      c.complaint++;
    else if (reason === "unsubscribe" || reason === "manual_unsubscribe")
      c.unsubscribe++;
    else if (reason === "manual" || reason === "imported") c.manual++;
    else c.other++;

    if (r.created_at) {
      const t = new Date(r.created_at).getTime();
      if (!Number.isNaN(t) && t >= cutoff) c.added7d++;
    }
  }
  return c;
}

export function SuppressionsStatStrip({
  rows,
  total,
  reasonScope,
}: Props): ReactElement {
  const c = useMemo(() => buildCounts(rows), [rows]);
  const bouncesTotal = c.hardBounce + c.spamTrap;
  /** Server total beats the loaded-sample count when available. */
  const displayTotal = total ?? c.total;
  /** True when the loaded rows are a sample of a larger server list. */
  const partial = total != null && total > c.total;
  // D05-consent-suppressions#16: with a reason chip active, `rows` (and
  // `total`) are reason-scoped, so any ratio the strip computes over that
  // sample reflects the FILTER, not the list health. Suppress the
  // ratio-based danger tones/hints (Bounces %, New·7d velocity) and label
  // the scoped Total honestly. Count-based signals (any complaint present)
  // stay, since they're true regardless of scope.
  const scoped = Boolean(reasonScope && reasonScope.trim());
  const totalHint = scoped
    ? partial
      ? `Filtered to “${reasonScope}” · first ${c.total.toLocaleString()} loaded`
      : `Filtered to “${reasonScope}”`
    : partial
      ? `Breakdown below covers the first ${c.total.toLocaleString()} loaded`
      : `${c.manual.toLocaleString()} manual · ${c.other.toLocaleString()} other`;
  const bouncesHigh =
    !scoped && bouncesTotal > 0 && c.total > 0 && bouncesTotal / c.total > 0.1;
  const growingFast = !scoped && c.added7d > c.total * 0.1;
  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <StatCard
        label="Total"
        value={displayTotal.toLocaleString()}
        hint={totalHint}
      >
        <ReasonMixChart
          counts={c}
          partial={partial}
          hasAuthoritativeTotal={total != null}
          reasonScope={reasonScope}
        />
      </StatCard>
      <StatCard
        label="Bounces"
        value={bouncesTotal.toLocaleString()}
        hint={`${c.hardBounce.toLocaleString()} hard · ${c.spamTrap.toLocaleString()} spam trap`}
        negative={bouncesHigh}
      />
      <StatCard
        label="Complaints"
        value={c.complaint.toLocaleString()}
        hint={
          c.complaint > 0
            ? "Each complaint hurts sender reputation"
            : "Clean — no spam reports"
        }
        negative={c.complaint > 0}
      />
      <StatCard
        label="New · 7d"
        value={c.added7d.toLocaleString()}
        hint={
          c.added7d === 0
            ? "No additions this week"
            : growingFast
              ? "Growing fast — investigate"
              : scoped
                ? "In the last 7 days"
                : "Within normal range"
        }
        negative={growingFast}
      />
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  hint: string;
  positive?: boolean;
  negative?: boolean;
  children?: React.ReactNode;
}

function StatCard({
  label,
  value,
  hint,
  positive,
  negative,
  children,
}: StatCardProps): ReactElement {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value tabular"
        style={{
          color: positive
            ? "var(--pw-accent)"
            : negative
              ? "var(--pw-danger)"
              : "var(--pw-fg)",
        }}
      >
        {value}
      </div>
      <div className="stat-delta subtle">{hint}</div>
      {children}
    </div>
  );
}

function ReasonMixChart({
  counts,
  partial,
  hasAuthoritativeTotal,
  reasonScope,
}: {
  counts: Counts;
  partial: boolean;
  hasAuthoritativeTotal: boolean;
  reasonScope?: string;
}): ReactElement {
  const activeScope = reasonScope?.trim() || "All reasons";
  return (
    <div style={{ marginTop: 6 }}>
      <CategoricalDistributionChart
        title="Suppression reason distribution"
        valueLabel="Loaded suppressions"
        height={8}
        segments={[
          {
            key: "hard-bounce",
            label: "Hard bounce",
            value: counts.hardBounce,
            color: "var(--pw-danger)",
          },
          {
            key: "spam-trap",
            label: "Spam trap",
            value: counts.spamTrap,
            color:
              "color-mix(in srgb, var(--pw-danger) 78%, var(--pw-warning))",
          },
          {
            key: "complaint",
            label: "Complaint",
            value: counts.complaint,
            color:
              "color-mix(in srgb, var(--pw-danger) 64%, var(--pw-warning))",
          },
          {
            key: "unsubscribe",
            label: "Unsubscribe",
            value: counts.unsubscribe,
            color: "var(--pw-warning)",
          },
          {
            key: "manual",
            label: "Manual",
            value: counts.manual,
            color: "color-mix(in srgb, var(--pw-fg-muted) 60%, transparent)",
          },
          {
            key: "other",
            label: "Other",
            value: counts.other,
            color: "var(--pw-bg-elev-2)",
          },
        ]}
        provenance={dux025Provenance("suppressionReasonMix", {
          scope: `Current workspace · ${activeScope} · ${counts.total.toLocaleString()} loaded rows`,
          note: partial
            ? "A larger server total exists; percentages intentionally use only the rows represented here."
            : hasAuthoritativeTotal
              ? "The server total does not exceed the represented rows."
              : "No authoritative server total was supplied; the table and export cover loaded rows only and do not claim completeness.",
        })}
        exportFileName="loaded-suppression-reason-distribution.csv"
        exportPrivacy="confidential"
      />
    </div>
  );
}
