/**
 * Semantic heatmap with a roving-keyboard grid.
 *
 * Colour is supplemental: every cell exposes its exact formatted value in a
 * real table. One cell is in the tab order; Arrow keys move within the grid,
 * Home/End move across a row, and Enter/Space activates an optional drilldown.
 */

import { type KeyboardEvent, type ReactElement, useRef, useState } from "react";

import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface HeatmapRow {
  label: string;
  /** Cohort size displayed alongside the label. */
  size?: number;
  /** One value per column. Use NaN/null for "no data" cells. */
  values: (number | null)[];
}

export interface HeatmapProps extends RequiredChartSupportProps {
  rows: HeatmapRow[];
  columns: string[];
  formatCell?: (v: number) => string;
  vMax?: number;
  metricLabel: string;
  valueLabel: string;
  summary?: string;
  rowHeaderLabel?: string;
  onSelectCell?: (rowIndex: number, columnIndex: number, value: number) => void;
}

function defaultFmtCell(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

export function heatmapKeyboardTarget(
  row: number,
  column: number,
  key: string,
  rowCount: number,
  columnCount: number,
): { row: number; column: number } | null {
  let nextRow = row;
  let nextColumn = column;
  if (key === "ArrowLeft") nextColumn -= 1;
  else if (key === "ArrowRight") nextColumn += 1;
  else if (key === "ArrowUp") nextRow -= 1;
  else if (key === "ArrowDown") nextRow += 1;
  else if (key === "Home") nextColumn = 0;
  else if (key === "End") nextColumn = columnCount - 1;
  else return null;
  if (
    nextRow < 0 ||
    nextRow >= rowCount ||
    nextColumn < 0 ||
    nextColumn >= columnCount
  ) {
    return null;
  }
  return { row: nextRow, column: nextColumn };
}

export function Heatmap({
  rows,
  columns,
  formatCell = defaultFmtCell,
  metricLabel,
  valueLabel,
  summary,
  rowHeaderLabel = "Cohort",
  vMax: suppliedMax,
  onSelectCell,
  provenance,
  exportFileName,
  exportPrivacy,
  allowExport,
}: HeatmapProps): ReactElement {
  const [active, setActive] = useState({ row: 0, column: 0 });
  const [hover, setHover] = useState<{ row: number; column: number } | null>(
    null,
  );
  const tableRef = useRef<HTMLTableElement | null>(null);

  let vMax = suppliedMax ?? 0;
  if (suppliedMax == null) {
    for (const row of rows) {
      for (const value of row.values) {
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > vMax
        ) {
          vMax = value;
        }
      }
    }
  }
  if (vMax <= 0) vMax = 1;
  const hasRowSizes = rows.some((row) => row.size != null);

  if (rows.length === 0 || columns.length === 0) {
    return (
      <div className="pw-chart-empty" role="status">
        No data available for {metricLabel.toLowerCase()}.
      </div>
    );
  }

  const focusCell = (row: number, column: number): void => {
    setActive({ row, column });
    window.requestAnimationFrame(() => {
      tableRef.current
        ?.querySelector<HTMLElement>(`[data-heatmap-cell="${row}:${column}"]`)
        ?.focus();
    });
  };

  const handleCellKey = (
    event: KeyboardEvent<HTMLTableCellElement>,
    row: number,
    column: number,
    value: number | null,
  ): void => {
    const target = heatmapKeyboardTarget(
      row,
      column,
      event.key,
      rows.length,
      columns.length,
    );
    if (target) {
      event.preventDefault();
      focusCell(target.row, target.column);
      return;
    }
    if (
      onSelectCell &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      onSelectCell(row, column, value);
    }
  };

  return (
    <div className="pw-data-visual" style={{ overflowX: "auto" }}>
      {summary ? <p className="visually-hidden">{summary}</p> : null}
      <table
        ref={tableRef}
        role="grid"
        aria-label={metricLabel}
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
        style={{
          width: "100%",
          minWidth: 140 + columns.length * 48,
          borderCollapse: "separate",
          borderSpacing: 2,
        }}
      >
        <caption className="visually-hidden">
          {metricLabel}. Use Arrow keys to inspect cells
          {onSelectCell ? "; press Enter or Space to open a cell" : ""}.
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              style={{
                width: 140,
                padding: "6px 8px",
                color: "var(--pw-fg-subtle)",
                fontSize: 11,
                fontWeight: 500,
                textAlign: "left",
              }}
            >
              {rowHeaderLabel}
            </th>
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                style={{
                  padding: "6px 4px",
                  color: "var(--pw-fg-subtle)",
                  fontSize: 11,
                  fontWeight: 500,
                  textAlign: "center",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row.label}-${rowIndex}`}>
              <th
                scope="row"
                style={{
                  padding: "4px 8px",
                  color: "var(--pw-fg)",
                  fontSize: 12,
                  fontWeight: 500,
                  textAlign: "left",
                }}
              >
                <span>{row.label}</span>
                {row.size != null ? (
                  <span
                    className="muted tabular"
                    style={{ float: "right", marginLeft: 6, fontSize: 11 }}
                  >
                    {row.size.toLocaleString()}
                  </span>
                ) : null}
              </th>
              {columns.map((column, columnIndex) => {
                const value = row.values[columnIndex] ?? null;
                const isNumber =
                  typeof value === "number" && Number.isFinite(value);
                const ratio = isNumber
                  ? Math.max(0, Math.min(1, value / vMax))
                  : 0;
                const formatted = isNumber ? formatCell(value) : "No data";
                const highlighted =
                  hover?.row === rowIndex && hover.column === columnIndex;
                return (
                  <td
                    key={`${column}-${columnIndex}`}
                    role="gridcell"
                    data-heatmap-cell={`${rowIndex}:${columnIndex}`}
                    tabIndex={
                      active.row === rowIndex && active.column === columnIndex
                        ? 0
                        : -1
                    }
                    aria-label={`${row.label}, ${column}: ${formatted}`}
                    onFocus={() => {
                      setActive({ row: rowIndex, column: columnIndex });
                      setHover({ row: rowIndex, column: columnIndex });
                    }}
                    onBlur={() => setHover(null)}
                    onMouseEnter={() =>
                      setHover({ row: rowIndex, column: columnIndex })
                    }
                    onMouseLeave={() => setHover(null)}
                    onKeyDown={(event) =>
                      handleCellKey(event, rowIndex, columnIndex, value)
                    }
                    onClick={
                      onSelectCell && isNumber
                        ? () => onSelectCell(rowIndex, columnIndex, value)
                        : undefined
                    }
                    style={{
                      height: 28,
                      minWidth: 48,
                      borderRadius: 4,
                      outline: highlighted
                        ? "2px solid var(--pw-accent)"
                        : "1px solid transparent",
                      outlineOffset: -2,
                      background: isNumber
                        ? `color-mix(in srgb, var(--pw-accent) ${(ratio * 80 + 4).toFixed(1)}%, var(--pw-bg))`
                        : "var(--pw-bg-elev-2)",
                      color:
                        ratio > 0.55 ? "var(--pw-accent-fg)" : "var(--pw-fg)",
                      cursor: onSelectCell && isNumber ? "pointer" : "default",
                      fontSize: 11,
                      fontVariantNumeric: "tabular-nums",
                      textAlign: "center",
                    }}
                  >
                    {isNumber ? formatted : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <AccessibleChartData
        title={metricLabel}
        summary={
          summary ??
          `${rows.length} rows by ${columns.length} columns. Use the visible table to inspect exact values.`
        }
        rowHeaderLabel={rowHeaderLabel}
        columns={[
          ...(hasRowSizes ? [{ key: "row-size", label: "Cohort size" }] : []),
          ...columns.map((column, index) => ({
            key: String(index),
            label: `${column} · ${valueLabel}`,
          })),
        ]}
        rows={rows.map((row, rowIndex) => ({
          key: `${rowIndex}-${row.label}`,
          label: row.label,
          values: Object.fromEntries([
            ...(hasRowSizes
              ? [
                  [
                    "row-size",
                    row.size == null
                      ? "Not available"
                      : row.size.toLocaleString(),
                  ] as const,
                ]
              : []),
            ...columns.map((_, columnIndex) => {
              const value = row.values[columnIndex];
              return [
                String(columnIndex),
                typeof value === "number" && Number.isFinite(value)
                  ? formatCell(value)
                  : "No data",
              ] as const;
            }),
          ]),
          exportValues: Object.fromEntries([
            ...(hasRowSizes ? [["row-size", row.size ?? ""] as const] : []),
            ...columns.map((_, columnIndex) => {
              const value = row.values[columnIndex];
              return [
                String(columnIndex),
                typeof value === "number" && Number.isFinite(value)
                  ? formatCell(value)
                  : "",
              ] as const;
            }),
          ]),
        }))}
        provenance={provenance}
        exportFileName={exportFileName}
        exportPrivacy={exportPrivacy}
        {...(allowExport != null ? { allowExport } : {})}
        includeTable={false}
      />
    </div>
  );
}
