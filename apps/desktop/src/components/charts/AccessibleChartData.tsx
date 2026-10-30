import { type ReactElement, type ReactNode, useState } from "react";

import type { TransferPrivacy } from "../../lib/file-transfer-types";

export interface AccessibleChartColumn {
  key: string;
  label: string;
}

export interface AccessibleChartRow {
  key: string;
  label: string;
  values: Record<string, ReactNode>;
  /** Primitive values used for CSV when the rendered cell is rich JSX. */
  exportValues?: Record<string, string | number | null | undefined>;
}

export interface AccessibleChartProvenance {
  /** Human-readable system or endpoint family, never a credential-bearing URL. */
  source: string;
  /** Timestamp supplied by the server, when distinct from export time. */
  /** Explicitly null when the source does not expose a freshness timestamp. */
  asOf?: string | null;
  /** Active range/filter/cohort scope represented by these rows. */
  scope?: string;
  /** Short caveat such as sampling, truncation, or timezone. */
  note?: string;
}

export interface AccessibleChartSupportProps {
  provenance?: AccessibleChartProvenance;
  exportFileName?: string;
  exportPrivacy?: TransferPrivacy;
  allowExport?: boolean;
}

/** Dense/standalone visualizations may not fall back to generic provenance. */
export interface RequiredChartSupportProps extends AccessibleChartSupportProps {
  provenance: Omit<AccessibleChartProvenance, "asOf"> & {
    asOf: string | null;
  };
  exportFileName: string;
  exportPrivacy: TransferPrivacy;
}

interface Props extends RequiredChartSupportProps {
  title: string;
  summary: string;
  columns: readonly AccessibleChartColumn[];
  rows: readonly AccessibleChartRow[];
  rowHeaderLabel?: string;
  /** False when the visualization is already a native HTML data table. */
  includeTable?: boolean;
  disclosureLabel?: string;
}

/**
 * Sighted keyboard and screen-reader equivalent for SVG visualizations.
 *
 * The disclosure keeps dense data out of the default visual hierarchy while
 * remaining a native, discoverable keyboard control. The table is deliberately
 * real HTML rather than an ARIA recreation so column/row navigation works in
 * VoiceOver, Narrator, and browser table-navigation modes.
 */
export function AccessibleChartData({
  title,
  summary,
  columns,
  rows,
  rowHeaderLabel = "Category",
  provenance,
  exportFileName,
  exportPrivacy,
  allowExport = true,
  includeTable = true,
  disclosureLabel = includeTable
    ? "View data table"
    : "View data provenance and export",
}: Props): ReactElement {
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");

  const exportCsv = async (): Promise<void> => {
    if (exporting || rows.length === 0) return;
    setExporting(true);
    setExportStatus("");
    try {
      const body = chartRowsToCsv({
        title,
        rowHeaderLabel,
        columns,
        rows,
        provenance,
      });
      const { saveFile } = await import("../../lib/file-transfer");
      const result = await saveFile({
        data: body,
        suggestedName: exportFileName ?? `${safeChartSlug(title)}-data.csv`,
        label: `${title} chart data`,
        privacy: exportPrivacy,
        mimeType: "text/csv;charset=utf-8",
      });
      setExportStatus(
        result.ok
          ? result.status === "cancelled"
            ? "Export cancelled."
            : "Chart data export started."
          : result.message,
      );
    } catch {
      setExportStatus("Moosewave could not export this chart data.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <details className="pw-chart-data" style={{ marginTop: 8 }}>
      <summary
        aria-label={`${disclosureLabel} for ${title}`}
        style={{
          cursor: "pointer",
          color: "var(--pw-fg-muted)",
          fontSize: 12,
          width: "fit-content",
        }}
      >
        {disclosureLabel}
      </summary>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
        {summary}
      </p>
      <dl className="pw-chart-provenance">
        <div>
          <dt>Source</dt>
          <dd>{provenance.source}</dd>
        </div>
        {provenance.scope ? (
          <div>
            <dt>Scope</dt>
            <dd>{provenance.scope}</dd>
          </div>
        ) : null}
        <div>
          <dt>Data as of</dt>
          <dd>{provenance.asOf ?? "Not supplied by source"}</dd>
        </div>
        {provenance.note ? (
          <div>
            <dt>Note</dt>
            <dd>{provenance.note}</dd>
          </div>
        ) : null}
      </dl>
      {includeTable ? (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%" }}>
            <caption className="visually-hidden">{title} data</caption>
            <thead>
              <tr>
                <th scope="col">{rowHeaderLabel}</th>
                {columns.map((column) => (
                  <th key={column.key} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1}>No data available.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {columns.map((column) => (
                      <td key={column.key}>{row.values[column.key] ?? "—"}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {allowExport ? (
        <div className="pw-chart-data-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Export ${title} data as CSV`}
            disabled={exporting || rows.length === 0}
            onClick={() => void exportCsv()}
          >
            {exporting ? "Preparing CSV…" : "Export data CSV"}
          </button>
          <span className="muted" role="status" aria-live="polite">
            {exportStatus}
          </span>
        </div>
      ) : null}
    </details>
  );
}

interface ChartCsvInput {
  title: string;
  rowHeaderLabel: string;
  columns: readonly AccessibleChartColumn[];
  rows: readonly AccessibleChartRow[];
  provenance: AccessibleChartProvenance;
}

export function chartRowsToCsv(input: ChartCsvInput): string {
  const generatedAt = new Date().toISOString();
  const matrix: Array<Array<string | number>> = [
    ["Chart", input.title],
    ["Source", input.provenance.source],
    ["Scope", input.provenance.scope ?? "Current view"],
    ["Data as of", input.provenance.asOf ?? "Not supplied"],
    ["Exported at", generatedAt],
  ];
  if (input.provenance.note) matrix.push(["Note", input.provenance.note]);
  matrix.push(
    [],
    [input.rowHeaderLabel, ...input.columns.map((column) => column.label)],
  );
  for (const row of input.rows) {
    matrix.push([
      row.label,
      ...input.columns.map((column) =>
        csvCell(
          row.exportValues?.[column.key] ??
            chartNodeText(row.values[column.key] ?? "—"),
        ),
      ),
    ]);
  }
  // Every string can originate in tenant-controlled labels or metadata, not
  // just data cells. Neutralize the complete matrix before CSV escaping so a
  // title, source, scope, column, or row label cannot become a spreadsheet
  // formula when the exported file is opened.
  return matrix
    .map((row) => row.map((value) => csvEscape(csvCell(value))).join(","))
    .join("\r\n");
}

function chartNodeText(value: ReactNode): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(chartNodeText).join("");
  return "";
}

function csvCell(value: string | number | null | undefined): string | number {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  // Neutralize spreadsheet formula injection while retaining the visible text.
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeChartSlug(title: string): string {
  const slug = title
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "postwave-chart";
}
