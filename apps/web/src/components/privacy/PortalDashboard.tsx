// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { safeCsvCell } from "@/lib/csv-safe";
import { downloadTextFile } from "@/lib/download";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import type { PrivacyPortal } from "@/lib/privacy-portal-api";
import { cn } from "@/lib/utils";

/**
 * Privacy-portal KPI strip with hints, DSAR-by-type and suppression-reason
 * charts, and — for each — a data-table disclosure with a CSV export
 * (desktop components/privacy/PortalDashboard.tsx + AccessibleChartData).
 *
 * Pure projection of the already-verified GET /api/v1/privacy/portal
 * snapshot; nothing here fetches. Every CSV cell (titles, provenance, row
 * labels, values) goes through `safeCsvCell`, because request types and
 * suppression reasons are tenant-controlled strings that must not become
 * spreadsheet formulas when the file is opened.
 */

const PROVENANCE_SOURCE = "GET /api/v1/privacy/portal";
const CSV_MIME = "text/csv;charset=utf-8";

export interface PortalChartColumn {
  key: string;
  label: string;
}

export interface PortalChartRow {
  key: string;
  label: string;
  values: Record<string, string | number | null>;
}

export interface PortalChartProvenance {
  source: string;
  scope: string;
  asOf: string | null;
}

/** CSV for one chart: provenance header block, blank line, then the table. */
export function portalChartCsv(input: {
  title: string;
  rowHeaderLabel: string;
  columns: readonly PortalChartColumn[];
  rows: readonly PortalChartRow[];
  provenance: PortalChartProvenance;
  exportedAt: string;
}): string {
  const matrix: Array<Array<string | number | null>> = [
    ["Chart", input.title],
    ["Source", input.provenance.source],
    ["Scope", input.provenance.scope],
    ["Data as of", input.provenance.asOf ?? "Not supplied"],
    ["Exported at", input.exportedAt],
    [],
    [input.rowHeaderLabel, ...input.columns.map((column) => column.label)],
    ...input.rows.map((row) => [
      row.label,
      ...input.columns.map((column) => row.values[column.key] ?? null),
    ]),
  ];
  return matrix
    .map((cells) => cells.map((cell) => safeCsvCell(cell)).join(","))
    .join("\r\n");
}

function ChartDataDisclosure({
  title,
  summary,
  rowHeaderLabel,
  columns,
  rows,
  provenance,
  exportFileName,
}: {
  title: string;
  summary: string;
  rowHeaderLabel: string;
  columns: readonly PortalChartColumn[];
  rows: readonly PortalChartRow[];
  provenance: PortalChartProvenance;
  exportFileName: string;
}) {
  const [status, setStatus] = useState("");
  const exportCsv = () => {
    if (rows.length === 0) return;
    try {
      downloadTextFile(
        exportFileName,
        portalChartCsv({
          title,
          rowHeaderLabel,
          columns,
          rows,
          provenance,
          exportedAt: new Date().toISOString(),
        }),
        CSV_MIME,
      );
      setStatus("Chart data export started.");
    } catch {
      setStatus("Moosewave could not export this chart data.");
    }
  };
  return (
    <details className="mt-3 rounded-lg border bg-muted/20 p-3 text-sm">
      <summary
        className="cursor-pointer text-xs font-medium text-muted-foreground"
        aria-label={`View data table for ${title}`}
      >
        View data table
      </summary>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{summary}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="break-all font-mono">{provenance.source}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Scope</dt>
          <dd>{provenance.scope}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Data as of</dt>
          <dd>
            {provenance.asOf
              ? formatWireTimestamp(provenance.asOf, provenance.asOf)
              : "Not supplied by source"}
          </dd>
        </div>
      </dl>
      <div
        className="mt-3 overflow-x-auto"
        role="region"
        aria-label={`${title} data table`}
        tabIndex={0}
      >
        <table className="w-full min-w-[420px] text-left text-xs">
          <caption className="sr-only">{title} data</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {rowHeaderLabel}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="py-1.5 pr-3 text-right font-medium"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="break-words py-1.5 pr-3 font-medium">
                  {row.label}
                </th>
                {columns.map((column) => {
                  const value = row.values[column.key];
                  return (
                    <td
                      key={column.key}
                      className="py-1.5 pr-3 text-right tabular-nums"
                    >
                      {typeof value === "number"
                        ? value.toLocaleString()
                        : (value ?? "—")}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Export ${title} data as CSV`}
          disabled={rows.length === 0}
          onClick={exportCsv}
        >
          <Download aria-hidden />
          Export data CSV
        </Button>
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {status || "Confidential workspace compliance counts."}
        </span>
      </div>
    </details>
  );
}

const DSAR_SERIES = [
  { key: "open", label: "Open", swatch: "bg-primary" },
  { key: "overdue", label: "Overdue", swatch: "bg-destructive" },
  { key: "closed", label: "Closed", swatch: "bg-muted-foreground/30" },
] as const;

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function PortalDashboard({ summary }: { summary: PrivacyPortal }) {
  // A 200 with a partial body must not white-screen the portal, so every
  // collection and count defaults to an honest empty value.
  const dsar = (Array.isArray(summary.dsar_requests) ? summary.dsar_requests : []).map(
    (row) => ({
      request_type: row.request_type || "unknown",
      open: nonNegative(row.open),
      overdue: nonNegative(row.overdue),
      closed: nonNegative(row.closed),
    }),
  );
  const totals = dsar.reduce(
    (acc, row) => ({
      open: acc.open + row.open,
      overdue: acc.overdue + row.overdue,
      closed: acc.closed + row.closed,
    }),
    { open: 0, overdue: 0, closed: 0 },
  );
  const gpc = nonNegative(summary.gpc_signaled_count);
  const doNotSell = nonNegative(summary.do_not_sell_count);
  const pending = nonNegative(summary.double_optin_pending);
  const suppressions = (
    Array.isArray(summary.suppression_breakdown)
      ? summary.suppression_breakdown
      : []
  )
    .slice(0, 4)
    .map((row) => ({ reason: row.reason || "unknown", count: nonNegative(row.count) }));
  const suppressionMax = suppressions.reduce(
    (max, row) => Math.max(max, row.count),
    0,
  );
  const dsarMax = dsar.reduce(
    (max, row) => Math.max(max, row.open + row.overdue + row.closed),
    0,
  );
  const provenance: PortalChartProvenance = {
    source: PROVENANCE_SOURCE,
    scope: "Current workspace privacy summary",
    asOf: summary.generated_at || null,
  };

  const kpis = [
    {
      key: "dsar-open",
      label: "DSAR · open",
      value: totals.open,
      unit: "requests",
      hint: "Privacy requests (access / deletion / portability) not yet completed.",
    },
    {
      key: "dsar-overdue",
      label: "DSAR · overdue",
      value: totals.overdue,
      unit: "requests",
      hint: "Open requests past their statutory due date (GDPR Art.12: 30d; CCPA: 45d).",
      danger: totals.overdue > 0,
    },
    {
      key: "gpc",
      label: "GPC signaled",
      value: gpc,
      unit: "subscribers",
      hint: "Subscribers whose browser sent the Global Privacy Control header.",
    },
    {
      key: "do-not-sell",
      label: "Do-not-sell",
      value: doNotSell,
      unit: "subscribers",
      hint: "Subscribers with the do-not-sell preference enabled (CCPA §1798.135).",
    },
    {
      key: "double-optin",
      label: "Double opt-in · pending",
      value: pending,
      unit: "pending confirmations",
      hint: "Tokens awaiting subscriber confirmation. Expires after 60 days.",
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {kpis.map((kpi) => (
            <div key={kpi.key} className="rounded-xl border bg-card p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {kpi.label}
              </dt>
              <dd
                className={cn(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  kpi.danger && "text-destructive-emphasis",
                )}
              >
                {kpi.value.toLocaleString()}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-muted-foreground">
                {kpi.hint}
              </dd>
            </div>
          ))}
        </dl>
        <ChartDataDisclosure
          title="Privacy-portal summary indicators"
          summary="Workspace privacy indicators covering open and overdue DSAR requests, GPC signals, do-not-sell preferences and pending double opt-in confirmations."
          rowHeaderLabel="Indicator"
          columns={[
            { key: "value", label: "Count" },
            { key: "unit", label: "Unit" },
          ]}
          rows={kpis.map((kpi) => ({
            key: kpi.key,
            label: kpi.label,
            values: { value: kpi.value, unit: kpi.unit },
          }))}
          provenance={provenance}
          exportFileName="privacy-portal-summary-indicators.csv"
        />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="privacy-dsar-by-type"
          className="min-w-0 rounded-xl border p-4"
        >
          <h3 id="privacy-dsar-by-type" className="text-sm font-semibold">
            DSAR by request type
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Open / overdue / closed per request type.
          </p>
          {dsar.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No privacy requests on file.
            </p>
          ) : (
            <>
              <ul
                className="mt-3 flex flex-wrap gap-3 text-xs"
                aria-label="Legend"
              >
                {DSAR_SERIES.map((series) => (
                  <li key={series.key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-2.5 rounded-sm", series.swatch)}
                    />
                    {series.label}
                  </li>
                ))}
              </ul>
              <ul className="mt-3 space-y-3" aria-label="DSAR requests by type">
                {dsar.map((row) => {
                  const total = row.open + row.overdue + row.closed;
                  const width = dsarMax > 0 ? (total / dsarMax) * 100 : 0;
                  return (
                    <li key={row.request_type} className="min-w-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                        <span className="break-words font-medium capitalize">
                          {row.request_type.replace(/_/gu, " ")}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {row.open.toLocaleString()} open ·{" "}
                          <span
                            className={cn(
                              row.overdue > 0 && "text-destructive-emphasis",
                            )}
                          >
                            {row.overdue.toLocaleString()} overdue
                          </span>{" "}
                          · {row.closed.toLocaleString()} closed
                        </span>
                      </div>
                      <div
                        aria-hidden
                        className="mt-1 flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted"
                        style={{ width: `${Math.max(width, total > 0 ? 2 : 0)}%` }}
                      >
                        {DSAR_SERIES.map((series) =>
                          row[series.key] > 0 ? (
                            <span
                              key={series.key}
                              title={`${series.label}: ${row[series.key].toLocaleString()}`}
                              className={cn("h-full", series.swatch)}
                              style={{ flexGrow: row[series.key] }}
                            />
                          ) : null,
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <ChartDataDisclosure
                title="DSAR requests by request type and status"
                summary={`${dsar.length.toLocaleString()} privacy-request types; ${totals.open.toLocaleString()} open, ${totals.overdue.toLocaleString()} overdue and ${totals.closed.toLocaleString()} closed requests in the current workspace summary.`}
                rowHeaderLabel="Request type"
                columns={[
                  { key: "open", label: "Open requests" },
                  { key: "overdue", label: "Overdue requests" },
                  { key: "closed", label: "Closed requests" },
                ]}
                rows={dsar.map((row) => ({
                  key: row.request_type,
                  label: row.request_type,
                  values: {
                    open: row.open,
                    overdue: row.overdue,
                    closed: row.closed,
                  },
                }))}
                provenance={provenance}
                exportFileName="privacy-dsar-requests-by-type.csv"
              />
            </>
          )}
        </section>

        <section
          aria-labelledby="privacy-suppression-reasons"
          className="min-w-0 rounded-xl border p-4"
        >
          <h3 id="privacy-suppression-reasons" className="text-sm font-semibold">
            Suppressions · top reasons
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Why subscribers are currently being filtered out at send time.
          </p>
          {suppressions.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No suppressions recorded.
            </p>
          ) : (
            <>
              <ul
                className="mt-3 space-y-3"
                aria-label="Suppression reasons"
              >
                {suppressions.map((row, index) => {
                  const pct =
                    suppressionMax > 0 ? (row.count / suppressionMax) * 100 : 0;
                  return (
                    // Reasons can be blank or repeat, so the index keeps keys unique.
                    <li key={`${row.reason}:${index}`}>
                      <div className="flex justify-between gap-2 text-xs">
                        <span className="break-words">{row.reason}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {row.count.toLocaleString()}
                        </span>
                      </div>
                      <div
                        aria-hidden
                        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          title={`${row.reason}: ${row.count.toLocaleString()}`}
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <ChartDataDisclosure
                title="Privacy-portal suppression reasons"
                summary={`${suppressions.length.toLocaleString()} leading suppression reasons returned by the privacy summary. Bar widths are relative to the largest displayed reason.`}
                rowHeaderLabel="Suppression reason"
                columns={[
                  { key: "count", label: "Suppressions" },
                  { key: "relative", label: "Relative to displayed maximum (%)" },
                ]}
                rows={suppressions.map((row, index) => ({
                  key: `${row.reason}:${index}`,
                  label: row.reason,
                  values: {
                    count: row.count,
                    relative:
                      suppressionMax > 0
                        ? Number(((row.count / suppressionMax) * 100).toFixed(1))
                        : null,
                  },
                }))}
                provenance={provenance}
                exportFileName="privacy-portal-suppression-reasons.csv"
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
