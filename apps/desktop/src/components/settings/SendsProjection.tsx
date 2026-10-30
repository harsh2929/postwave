import { type ReactElement } from "react";

import { type PlanSendsProjection } from "../../lib/api-client";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

function finiteOrZero(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function fmtCount(n: number | null | undefined): string {
  return new Intl.NumberFormat("en-US").format(finiteOrZero(n));
}

function isUnlimited(limit: number | null | undefined): boolean {
  return !(typeof limit === "number" && Number.isFinite(limit) && limit > 0);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString();
}

/**
 * An explicitly labelled estimate based only on server-provided usage.
 * Insufficient signal is disclosed instead of producing a fabricated trend.
 */
export function SendsProjection({
  projection,
}: {
  projection: PlanSendsProjection;
}): ReactElement {
  const current = finiteOrZero(projection.current);
  const limit = finiteOrZero(projection.limit);
  const unlimited = isUnlimited(projection.limit);
  const avgPerDay = finiteOrZero(projection.avg_per_day);
  const projectedEnd = finiteOrZero(projection.projected_end_of_period);
  const periodEnd = fmtDate(projection.period_end);
  const exceedDate = fmtDate(projection.projected_exceed_date);
  const onTrack =
    Boolean(projection.on_track_to_exceed) && exceedDate.length > 0;
  const canProject = avgPerDay > 0 && finiteOrZero(projection.days_elapsed) > 0;
  const utilization = !unlimited && limit > 0 ? (current / limit) * 100 : null;
  const barPercent = Math.max(0, Math.min(100, utilization ?? 0));
  const atOrOverLimit = utilization != null && utilization >= 100;
  const risk = onTrack || atOrOverLimit;

  return (
    <div
      className="card"
      style={{
        padding: 12,
        borderColor: risk ? "var(--pw-danger)" : "var(--pw-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Monthly sends</span>
        <span
          className="badge"
          style={{ fontSize: 10 }}
          title="A projection from your usage so far this period — not a charge."
        >
          Estimate
        </span>
        {atOrOverLimit ? (
          <span className="badge danger" style={{ fontSize: 10 }}>
            {utilization != null && utilization > 100
              ? "Over limit"
              : "At limit"}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="muted tabular" style={{ fontSize: 12 }}>
          {unlimited
            ? `${fmtCount(current)} sent · unlimited`
            : `${fmtCount(current)} of ${fmtCount(limit)} this period · ${utilization?.toFixed(1)}%`}
        </span>
      </div>

      {!unlimited && limit > 0 ? (
        <div
          role="progressbar"
          aria-valuenow={Math.round(barPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Monthly sends used this period"
          aria-valuetext={`${fmtCount(current)} of ${fmtCount(limit)} sends · ${utilization?.toFixed(1)}% used`}
          style={{
            height: 8,
            borderRadius: 4,
            background:
              "color-mix(in srgb, var(--pw-fg-muted) 12%, transparent)",
            overflow: "hidden",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              width: `${barPercent.toFixed(1)}%`,
              height: "100%",
              background: risk ? "var(--pw-danger)" : "var(--pw-accent)",
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
            }}
          />
        </div>
      ) : null}

      {canProject ? (
        <div className="muted" style={{ fontSize: 12 }}>
          At roughly <strong>{fmtCount(Math.round(avgPerDay))}</strong>/day,
          you&apos;re projected to reach about{" "}
          <strong>{fmtCount(Math.round(projectedEnd))}</strong> sends
          {periodEnd ? <> by {periodEnd}</> : null}. This is an estimate based
          on your usage so far this period.
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Not enough usage yet to project where this period will land.
          We&apos;ll show an estimate once there&apos;s a few days of sends to
          extrapolate from.
        </div>
      )}

      {onTrack ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: "var(--pw-danger)",
            fontWeight: 600,
          }}
        >
          Heads up: at this pace you&apos;re on track to hit your sends cap
          around {exceedDate}. Nothing will be charged by surprise — this is an
          estimate so you can plan ahead.
        </div>
      ) : null}
      {atOrOverLimit && !onTrack ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: "var(--pw-danger)",
            fontWeight: 600,
          }}
        >
          Current usage has reached the configured sends cap.
        </div>
      ) : null}
      <AccessibleChartData
        title="Monthly sends usage and projection"
        summary={
          canProject
            ? `${fmtCount(current)} sends used in the current period; the server projects ${fmtCount(Math.round(projectedEnd))} by period end at approximately ${fmtCount(Math.round(avgPerDay))} sends per day.`
            : `${fmtCount(current)} sends used in the current period; insufficient elapsed usage exists for a projection.`
        }
        rowHeaderLabel="Measure"
        columns={[
          { key: "value", label: "Value" },
          { key: "unit", label: "Unit" },
          { key: "detail", label: "Detail" },
        ]}
        rows={[
          projectionRow(
            "current",
            "Current usage",
            current,
            "sends",
            "Current billing period",
          ),
          projectionRow(
            "limit",
            "Plan limit",
            unlimited ? "Unlimited" : limit,
            unlimited ? "status" : "sends",
            "Current billing period",
          ),
          projectionRow(
            "utilization",
            "Utilization",
            utilization == null ? "Not applicable" : utilization,
            utilization == null ? "status" : "percent",
            "Exact utilization; the supplemental bar clamps at 100%",
          ),
          projectionRow(
            "average",
            "Average per day",
            avgPerDay,
            "sends per day",
            canProject
              ? "Server-provided estimate basis"
              : "Insufficient signal",
          ),
          projectionRow(
            "projected",
            "Projected period-end usage",
            canProject ? projectedEnd : "Unavailable",
            canProject ? "sends" : "status",
            "Server-provided estimate",
          ),
          projectionRow(
            "period-end",
            "Period end",
            projection.period_end || "Not supplied",
            "timestamp",
            "Billing-period boundary",
          ),
          projectionRow(
            "projected-exceed",
            "Projected cap-reach date",
            projection.projected_exceed_date || "Not projected",
            "timestamp",
            onTrack
              ? "On track to exceed"
              : "Not currently projected to exceed",
          ),
        ]}
        provenance={dux025Provenance("planSendsProjection", {
          scope: `Current workspace · billing period ending ${projection.period_end || "not supplied"}`,
          asOf: projection.as_of || null,
        })}
        exportFileName="monthly-sends-usage-projection.csv"
        exportPrivacy="confidential"
      />
    </div>
  );
}

function projectionRow(
  key: string,
  label: string,
  value: string | number,
  unit: string,
  detail: string,
) {
  return {
    key,
    label,
    values: {
      value: typeof value === "number" ? value.toLocaleString() : value,
      unit,
      detail,
    },
    exportValues: { value, unit, detail },
  };
}
