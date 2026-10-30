/**
 * report-builder-helpers — pure logic for the KLV-12 metric report builder
 * (ReportBuilderSection). Kept side-effect-free and unit-tested so the React
 * surface stays thin: column derivation, RFC-4180-ish CSV serialization, the
 * picker grouping, the selectable-dimension intersection, and the
 * server-enforced caps mirrored client-side.
 *
 * Backend rules these mirror (verified): a report supports AT MOST 10 metrics
 * and AT MOST 5 dimensions. The server validates both; we cap in the UI too so
 * a user can't assemble an invalid request.
 */

import type {
  ReportMetricDefinition,
  ReportRequest,
} from "../../lib/api-client";

/** Server-enforced caps, mirrored in the UI so the builder can't overshoot. */
export const MAX_METRICS = 10;
export const MAX_DIMENSIONS = 5;

/** Whether another metric can be added given how many are already selected. */
export function canAddMetric(count: number): boolean {
  return count < MAX_METRICS;
}

/** Whether another dimension can be added given how many are already selected. */
export function canAddDimension(count: number): boolean {
  return count < MAX_DIMENSIONS;
}

/**
 * The column name a metric spec contributes to a row: the alias when set,
 * otherwise the metric key. Mirrors how the backend keys metric columns.
 */
function metricColumnKey(spec: { key: string; alias?: string }): string {
  const alias = (spec.alias ?? "").trim();
  return alias || spec.key;
}

/**
 * Ordered column keys for the preview/run table: dimensions first (in request
 * order), then each metric's alias-or-key. Tolerant of an empty request and
 * empty rows; de-duplicates while preserving first-seen order. Any extra keys
 * present in the row maps but not in the request are appended last so nothing
 * the server returned is silently hidden.
 */
export function deriveColumns(
  request: Pick<ReportRequest, "metrics" | "dimensions"> | null | undefined,
  rows: Array<Record<string, unknown>> | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (k: string): void => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };

  const dims = Array.isArray(request?.dimensions) ? request.dimensions : [];
  for (const d of dims) {
    if (typeof d === "string") push(d);
  }

  const metrics = Array.isArray(request?.metrics) ? request.metrics : [];
  for (const m of metrics) {
    if (m && typeof m.key === "string") push(metricColumnKey(m));
  }

  // Defensive: surface any keys the server returned that the request didn't
  // anticipate (e.g. server-added columns), appended in first-seen order.
  const safeRows = Array.isArray(rows) ? rows : [];
  for (const row of safeRows) {
    if (!row || typeof row !== "object") continue;
    for (const k of Object.keys(row)) push(k);
  }

  return out;
}

/**
 * Coerce an unknown cell value to a display string. Numbers/strings/booleans
 * render directly; null/undefined become an em dash; objects/arrays become
 * compact JSON (falling back to the em dash if not serializable).
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

/**
 * The raw value of a cell for CSV purposes — like {@link cellToString} but
 * empty (not an em dash) for null/undefined so a CSV blank stays blank.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return neutralizeSpreadsheetCell(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return neutralizeSpreadsheetCell(JSON.stringify(value));
  } catch {
    return "";
  }
}

const CSV_FORMULA_PREFIX =
  /^[\p{White_Space}\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@]/u;
const CSV_HIDDEN_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

function visibleUnicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
    : `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

/**
 * Force formula-shaped tenant text to remain text in spreadsheet clients.
 * Detection happens before hidden controls are made visible so a BOM, bidi
 * mark, C0/C1 control, tab, CR, or leading whitespace cannot conceal a
 * formula marker.
 */
export function neutralizeSpreadsheetCell(value: string): string {
  const formulaLike = CSV_FORMULA_PREFIX.test(value);
  const visible = value.replace(CSV_HIDDEN_CONTROL, visibleUnicodeEscape);
  return formulaLike ? `'${visible}` : visible;
}

/** Quote a single CSV field per RFC-4180 if it contains a comma, quote, CR or
 *  LF; quotes inside are escaped by doubling. */
function quoteField(field: string): string {
  if (/[",\r\n\t]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Serialize rows to an RFC-4180-ish CSV string: a header row of the column
 * keys, then one row per data row, CRLF-separated. Fields containing a comma,
 * double-quote, CR or LF are wrapped in double-quotes with internal quotes
 * doubled. Missing keys render as empty fields. Honest: serializes exactly the
 * columns asked for, in order, from exactly the rows given.
 */
export function rowsToCsv(
  columns: string[] | null | undefined,
  rows: Array<Record<string, unknown>> | null | undefined,
): string {
  const cols = Array.isArray(columns) ? columns.filter((c) => c != null) : [];
  const safeRows = Array.isArray(rows) ? rows : [];

  const lines: string[] = [];
  lines.push(
    cols.map((c) => quoteField(neutralizeSpreadsheetCell(String(c)))).join(","),
  );
  for (const row of safeRows) {
    const safeRow = row && typeof row === "object" ? row : {};
    lines.push(cols.map((c) => quoteField(csvCell(safeRow[c]))).join(","));
  }
  // Records are CRLF-TERMINATED (not just separated) per the RFC-4180
  // convention Excel / strict parsers expect — include the trailing CRLF.
  return cols.length === 0 && safeRows.length === 0
    ? ""
    : lines.join("\r\n") + "\r\n";
}

/** One product-area group for the metric picker. */
export interface MetricAreaGroup {
  area: string;
  metrics: ReportMetricDefinition[];
}

/**
 * Group metric definitions by product_area for the picker, sorted by area
 * name, and metrics sorted by label within each area. Tolerant of a missing /
 * non-array input. Metrics with a blank product_area land in a "general" group.
 */
export function metricsByArea(
  defs: ReportMetricDefinition[] | null | undefined,
): MetricAreaGroup[] {
  const safe = Array.isArray(defs) ? defs : [];
  const byArea = new Map<string, ReportMetricDefinition[]>();
  for (const d of safe) {
    if (!d || typeof d.key !== "string") continue;
    const area = (d.product_area ?? "").trim() || "general";
    const bucket = byArea.get(area);
    if (bucket) bucket.push(d);
    else byArea.set(area, [d]);
  }

  return Array.from(byArea.entries())
    .map(([area, metrics]) => ({
      area,
      metrics: metrics
        .slice()
        .sort((a, b) => (a.label ?? a.key).localeCompare(b.label ?? b.key)),
    }))
    .sort((a, b) => a.area.localeCompare(b.area));
}

/** Dimensions the current report executor can actually group by. An empty
 * dimension selection (an ungrouped report) is also executable. */
export const REPORT_EXECUTABLE_DIMENSIONS: readonly string[] = ["day"];

export function isReportDimensionExecutable(dimension: string): boolean {
  return (REPORT_EXECUTABLE_DIMENSIONS as readonly string[]).includes(
    dimension,
  );
}

/**
 * Dimensions every selected metric supports, restricted to dimensions the
 * current executor implements. A union advertised combinations that one or
 * more selected metrics could not calculate and allowed country/device
 * choices that the backend silently ignored.
 */
export function selectableDimensions(
  selectedMetricDefs: ReportMetricDefinition[] | null | undefined,
): string[] {
  const safe = Array.isArray(selectedMetricDefs) ? selectedMetricDefs : [];
  if (safe.length === 0) return [];
  const supportedByAll = safe
    .map(
      (definition) =>
        new Set(
          (Array.isArray(definition?.dimensions)
            ? definition.dimensions
            : []
          ).filter(
            (dimension): dimension is string =>
              typeof dimension === "string" && dimension.length > 0,
          ),
        ),
    )
    .reduce((intersection, dimensions) => {
      for (const dimension of intersection) {
        if (!dimensions.has(dimension)) intersection.delete(dimension);
      }
      return intersection;
    });
  return Array.from(supportedByAll)
    .filter(isReportDimensionExecutable)
    .sort((a, b) => a.localeCompare(b));
}

/** True when a metric's runtime_status means it returns real data. */
export function isSupported(def: { runtime_status?: string }): boolean {
  return (def?.runtime_status ?? "").toLowerCase() === "supported";
}

/** True when a run/preview status is terminal (no more polling needed). */
export function isTerminalRunStatus(
  status: string | null | undefined,
): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s === "completed" || s === "failed" || s === "canceled" || s === "cancelled"
  );
}

/** Extract `rows` from a ReportRun.result map, defensively (it's untyped). */
export function runResultRows(
  result: Record<string, unknown> | null | undefined,
): Array<Record<string, unknown>> {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is Record<string, unknown> => r != null && typeof r === "object",
  );
}
