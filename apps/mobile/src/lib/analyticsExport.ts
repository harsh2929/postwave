/**
 * analyticsExport — "send me these numbers", from the Analytics screen.
 *
 * DASHBOARD#40. Mobile could share a SENTENCE about a metric (the dashboard's
 * snapshot text, MetricActionsSheet's "Share this number") and nothing else:
 * no dataset left this app. The claim in the finding that mobile "has no
 * export path at all" is no longer true in general — suppressions, discounts
 * and DMARC each stream a server CSV through `csvShare` — but it was still
 * exactly true of the reporting screen, which is where a reader is most likely
 * to want the rows.
 *
 * WHY THIS BUILDS THE CSV LOCALLY INSTEAD OF FETCHING ONE. The two server-side
 * CSV endpoints the desktop's ExportMenu uses are
 * `GET /api/v1/campaigns/{id}/report.csv` and
 * `GET /api/v1/reporting/runs/{id}/export.csv` — one per CAMPAIGN, one per
 * saved REPORT RUN. Neither of them is what this screen shows: the Analytics
 * screen is a set of workspace-wide series over a chosen window, and there is
 * no endpoint that emits that as CSV. Re-fetching a campaign report to export
 * an audience-growth curve would export different numbers from the ones on
 * screen, which is worse than exporting nothing.
 *
 * So the export is exactly what the reader is looking at, assembled from the
 * data already in the query cache. That has a consequence and the caller SAYS
 * it out loud: a section that failed to load, or that the reader's scopes do
 * not cover, contributes no rows — and its absence is recorded in the file as
 * a comment line rather than left to look like a section with no data.
 *
 * ABSENCE IS NOT ZERO: an unreported measurement is written as an EMPTY cell,
 * never as `0`. A spreadsheet averaging a column of injected zeroes produces a
 * confidently wrong answer.
 *
 * Injection safety, RFC4180 quoting and the row cap all come from `csvShare`,
 * which is the only import here — so every rule in this module is testable in
 * the node vitest run (house rule 6).
 */
import { csvField } from "@/lib/csvShare";

/**
 * Rows kept for the share sheet. A share sheet is not a file: `expo-file-system`
 * is not a dependency, so the payload travels as TEXT and iOS mangles very
 * large ones. Well above any window this screen offers (90 daily points), and
 * stated in the notice whenever it bites.
 */
export const ANALYTICS_EXPORT_MAX_ROWS = 600;

export interface AnalyticsExportSeries {
  /** Section name, used as the `section` column value. */
  section: string;
  /** Column headers AFTER `section` — e.g. ["date", "subscribers"]. */
  columns: readonly string[];
  /** One entry per row. `null` renders as an EMPTY cell, never as 0. */
  rows: readonly (readonly (string | number | null)[])[];
}

export interface AnalyticsExportInput {
  /** Reporting window label, e.g. "Last 30 days". */
  rangeLabel: string;
  /** ISO time the export was taken. */
  takenAt: string;
  series: readonly AnalyticsExportSeries[];
  /**
   * Sections that could not contribute — because they errored, were gated by
   * scope, or were never loaded. Named so the file cannot be mistaken for a
   * complete picture.
   */
  unavailable?: readonly string[];
}

export interface AnalyticsExport {
  body: string;
  title: string;
  /** Data rows written, header and comment lines excluded. */
  included: number;
  /** Rows dropped by the cap. The caller must say so out loud. */
  truncated: boolean;
  /** Sections that contributed nothing. */
  unavailable: readonly string[];
}

/**
 * One flat table rather than N tables: a share sheet delivers a single blob,
 * and a reader pasting it into Sheets gets something sortable and filterable
 * instead of a document they have to split by hand. Every row therefore
 * carries its own `section`, and the widest section decides the column count.
 */
export function buildAnalyticsCsv(
  input: AnalyticsExportInput,
): AnalyticsExport {
  const usable = input.series.filter((series) => series.rows.length > 0);
  const width = usable.reduce(
    (max, series) => Math.max(max, series.columns.length),
    0,
  );
  const lines: string[] = [];
  // Comment lines, not data: the window and the take-time are the two facts
  // that make the numbers re-checkable a week later, and a bare CSV loses both.
  lines.push(`# Moosewave analytics · ${input.rangeLabel}`);
  lines.push(`# Exported ${input.takenAt}`);

  const unavailable = [
    ...(input.unavailable ?? []),
    ...input.series
      .filter((series) => series.rows.length === 0)
      .map((series) => series.section),
  ].filter((name, index, all) => all.indexOf(name) === index);
  if (unavailable.length > 0) {
    lines.push(`# Not included: ${unavailable.join(", ")}`);
  }

  if (width === 0) {
    return {
      body: lines.join("\n"),
      title: `Moosewave analytics — ${input.rangeLabel}`,
      included: 0,
      truncated: false,
      unavailable,
    };
  }

  // A generic header, because the sections do not share column meanings. Each
  // section's own headers are written as its first row so nothing is guessed.
  lines.push(
    ["section", ...Array.from({ length: width }, (_, i) => `field_${i + 1}`)]
      .map(csvField)
      .join(","),
  );

  let included = 0;
  let truncated = false;
  for (const series of usable) {
    if (included >= ANALYTICS_EXPORT_MAX_ROWS) {
      truncated = true;
      break;
    }
    lines.push(
      [series.section, ...pad([...series.columns], width)]
        .map(csvField)
        .join(","),
    );
    for (const row of series.rows) {
      if (included >= ANALYTICS_EXPORT_MAX_ROWS) {
        truncated = true;
        break;
      }
      lines.push(
        [series.section, ...pad(row.map(cell), width)].map(csvField).join(","),
      );
      included += 1;
    }
  }

  return {
    body: lines.join("\n"),
    title: `Moosewave analytics — ${input.rangeLabel}`,
    included,
    truncated,
    unavailable,
  };
}

/** `null` becomes an EMPTY cell. Never `0` — see the module header. */
function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return value;
}

function pad(values: readonly (string | number)[], width: number): string[] {
  const out = values.map((value) => String(value));
  while (out.length < width) out.push("");
  return out.slice(0, width);
}

/**
 * The sentence the toast says. Three facts, none of them safe to omit: how
 * many rows went, whether the set was capped, and which sections are missing —
 * a reader who does not know a section is absent will read its absence as a
 * zero.
 */
export function analyticsExportNotice(result: AnalyticsExport): string {
  if (result.included === 0) {
    return result.unavailable.length > 0
      ? `Nothing to export — ${result.unavailable.join(", ")} could not be read.`
      : "Nothing to export yet.";
  }
  const parts = [
    `Shared ${result.included} row${result.included === 1 ? "" : "s"}.`,
  ];
  if (result.truncated) {
    parts.push(
      `Capped at ${ANALYTICS_EXPORT_MAX_ROWS}; the rest need the web export.`,
    );
  }
  if (result.unavailable.length > 0) {
    parts.push(`Not included: ${result.unavailable.join(", ")}.`);
  }
  return parts.join(" ");
}
