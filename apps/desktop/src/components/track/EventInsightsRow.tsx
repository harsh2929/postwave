/**
 * EventInsightsRow — three at-a-glance cards above the catalog.
 * Refined Product Events PR 1.
 *
 *   1. Activity     — total events + sparkline.
 *   2. Subscribers  — unique subscribers firing events in the period.
 *   3. Event names  — distinct event names tracked in the period.
 *
 * Same shape as the audit insights row; reuses the visual idiom so
 * an operator who learned one tab knows the other.
 */

import type { ReactElement } from "react";

import type { ProductEventStatsResponse } from "../../lib/api-client";
import { Sparkline as CompactSparkline } from "../charts/Sparkline";
import { safeAbsoluteTime } from "./track-maturity";

interface Props {
  stats: ProductEventStatsResponse | null;
  loading: boolean;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

export function EventInsightsRow({ stats, loading }: Props): ReactElement {
  if (!stats && loading) {
    return (
      <div
        className="track-insights-row"
        role="status"
        aria-label="Loading product-event activity summary"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="track-insight-card" aria-hidden="true">
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
  /* Defensive: a partial /track/stats response can omit `daily`. Treat
   * missing as empty so `.length` and `.map` never throw. */
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const peak = daily.length ? Math.max(0, ...daily.map((d) => d.count)) : 0;
  const periodDays = stats.periodDays;
  return (
    <div
      className="track-insights-row"
      role="group"
      aria-label="Event activity"
    >
      <div className="track-insight-card">
        <div className="muted" style={{ fontSize: 11 }}>
          Activity
        </div>
        <div
          className="tabular"
          style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}
        >
          {fmtInt(stats.totalEvents ?? 0)}{" "}
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            event{(stats.totalEvents ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          across {periodDays} UTC calendar day{periodDays === 1 ? "" : "s"}
          {daily.length < periodDays ? (
            <>
              {" "}
              · activity recorded on {daily.length} day
              {daily.length === 1 ? "" : "s"}
            </>
          ) : null}
          {peak > 0 ? <> · peak {fmtInt(peak)}</> : null}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          UTC calendar snapshot · independently verified{" "}
          <time dateTime={stats.asOf}>{safeAbsoluteTime(stats.asOf)}</time>
        </div>
        <div style={{ marginTop: 8 }}>
          <CompactSparkline
            values={daily.map((point) => point.count)}
            labels={daily.map((point) => point.date)}
            width={220}
            height={36}
            fill={false}
            color="var(--pw-info)"
            className="track-sparkline"
            valueLabel="events"
            ariaLabel={`Product-event activity across ${periodDays} UTC calendar day${periodDays === 1 ? "" : "s"}; ${daily.length} recorded daily bucket${daily.length === 1 ? "" : "s"}`}
          />
        </div>
      </div>
      <div className="track-insight-card">
        <div className="muted" style={{ fontSize: 11 }}>
          Subscribers
        </div>
        <div
          className="tabular"
          style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}
        >
          {fmtInt(stats.uniqueSubscribers ?? 0)}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          unique subscribers firing events in this window
        </div>
      </div>
      <div className="track-insight-card">
        <div className="muted" style={{ fontSize: 11 }}>
          Event names
        </div>
        <div
          className="tabular"
          style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}
        >
          {fmtInt(stats.uniqueEventNames ?? 0)}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          distinct{" "}
          {(stats.uniqueEventNames ?? 0) === 1 ? "event_name" : "event_names"}{" "}
          tracked over {periodDays}d
        </div>
      </div>
    </div>
  );
}
