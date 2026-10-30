/**
 * AuditHeatmap — hour-of-day × day-of-week density of audit events.
 *
 * audit-2026 session-replay-deeplink (UX, P1) — one of four view modes
 * the Audit page exposes alongside List, Timeline, Calendar.
 *
 * Reuses the existing chart Heatmap primitive (cohort retention) by
 * mapping audit rows into the same {rows, columns, values} shape. A
 * cell click drills the parent into "list mode filtered to that hour"
 * — but at this layer we only emit the onSelect callback; the page is
 * responsible for translating the (dow, hour) tuple into a date range.
 */

import { type ReactElement, useMemo } from "react";

import type { AuditRow } from "../../lib/api-client";
import { Heatmap, type HeatmapRow } from "../charts/Heatmap";
import { computeHeatmapData } from "./auditViewModeHelpers";

export { computeHeatmapData };

interface Props {
  rows: AuditRow[];
  /** Fires with the (dow, hour) tuple when an operator clicks a cell. */
  onSelectCell?: (dow: number, hour: number, count: number) => void;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) =>
  h.toString().padStart(2, "0"),
);

export function AuditHeatmap({ rows, onSelectCell }: Props): ReactElement {
  const { values, vMax, total } = useMemo(
    () => computeHeatmapData(rows),
    [rows],
  );

  const heatmapRows: HeatmapRow[] = useMemo(
    () =>
      values.map((row, dow) => ({
        label: DAY_LABELS[dow],
        size: row.reduce((a, b) => a + b, 0),
        values: row.map((v) => (v === 0 ? null : v)),
      })),
    [values],
  );

  const peak = useMemo(() => {
    let best = { dow: 0, hour: 0, count: 0 };
    values.forEach((row, dow) => {
      row.forEach((count, hour) => {
        if (count > best.count) best = { dow, hour, count };
      });
    });
    return best;
  }, [values]);
  const asOf = useMemo(
    () =>
      rows.reduce<string | undefined>(
        (latest, row) => (!latest || row.at > latest ? row.at : latest),
        undefined,
      ),
    [rows],
  );

  if (total === 0) {
    return (
      <div
        className="list-empty"
        data-testid="audit-heatmap-empty"
        style={{ padding: 24 }}
      >
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>No events in the current filter</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            Widen the date range or clear a filter to populate the heatmap.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="audit-heatmap">
      <Heatmap
        rows={heatmapRows}
        columns={HOUR_LABELS}
        vMax={vMax || 1}
        metricLabel="Audit events by UTC day and hour"
        valueLabel="Events"
        rowHeaderLabel="UTC day"
        summary={`${total.toLocaleString()} events. Peak: ${DAY_LABELS[peak.dow]} at ${HOUR_LABELS[peak.hour]}:00 UTC with ${peak.count.toLocaleString()} events.`}
        provenance={{
          source: "Moosewave audit-event query",
          asOf: asOf ?? null,
          scope: "Current audit filters · UTC day and hour",
          note: "Only events loaded by the current query are represented.",
        }}
        exportFileName="audit-events-by-utc-day-and-hour.csv"
        exportPrivacy="confidential"
        formatCell={(v) => String(v | 0)}
        onSelectCell={
          onSelectCell
            ? (dow, hour, count) => onSelectCell(dow, hour, count)
            : undefined
        }
      />
    </div>
  );
}
