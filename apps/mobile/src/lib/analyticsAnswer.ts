/**
 * lib/analyticsAnswer.ts — the shape of an answer from
 * `POST /api/v1/analytics/nlq`, and the rules for rendering one on a phone.
 *
 * WHAT THE SERVER ACTUALLY DOES, because the UI must not overstate it. The
 * model is given the question and a registry of whitelisted, pre-authored SQL
 * templates, and its ONLY output is a template id plus two clamped integers
 * (window days, row limit) — see apps/api/internal/nql/analytics_nlq.go. The
 * SQL is a literal in that registry, executed under tenant RLS; a hallucinated
 * template id is rejected with `invalid_template` and never runs. The prose in
 * `summary_text` is produced by `summarizeAnalyticsRows`, a Go switch — it is
 * NOT model output, and row values are never sent to the model.
 *
 * That distinction is the whole disclosure: "AI picked which saved report to
 * run" is true, "AI wrote this answer" is not. Calling the summary an AI
 * answer would be a bigger lie than saying nothing.
 *
 * The rendering rules, which is why this file is pure and separate from the
 * transport:
 *
 *  - AN ANSWER WITH NO ROWS IS STILL AN ANSWER. "No data matched this query in
 *    the last 30 days" is the finding, not a failure, and must not render as
 *    an error or an empty card.
 *  - A PHONE CANNOT SHOW A WIDE TABLE. Every template returns either a ranked
 *    (name, count) shape or a single aggregate row, so the display picks ONE
 *    label column and ONE numeric column and renders a comparison; the rest of
 *    the columns are still reachable as key/value detail.
 *  - ABSENCE IS NOT ZERO. A null cell stays null and the renderer prints an
 *    em-dash; it is never coerced to 0, which would invent a measurement.
 */

/** `answer_kind` from the handler: a ranked table or a single aggregate row. */
export type AnalyticsAnswerKind = "table" | "summary";

export interface AnalyticsAnswerCell {
  column: string;
  /** Display-ready string, already em-dashed when absent. */
  text: string;
  /** The numeric value when the cell holds one, else null. */
  value: number | null;
}

export interface AnalyticsAnswerRow {
  id: string;
  /** Best human label for the row (a campaign name, a date, a currency). */
  label: string;
  /** The primary measure, when the row has one. */
  value: number | null;
  cells: AnalyticsAnswerCell[];
}

export interface AnalyticsAnswer {
  question: string;
  kind: AnalyticsAnswerKind;
  /** Registry id of the saved query that ran, e.g. `top_campaigns_by_opens`. */
  template: string;
  windowDays: number;
  limit: number;
  columns: string[];
  rows: AnalyticsAnswerRow[];
  /** Server-authored, deterministic. Not model prose. */
  summaryText: string;
  /** Column chosen as the label axis, or null when no text column exists. */
  labelColumn: string | null;
  /** Column chosen as the measure, or null when no numeric column exists. */
  valueColumn: string | null;
}

export class AnalyticsAnswerUnreadableError extends Error {
  override readonly name = "AnalyticsAnswerUnreadableError";

  constructor() {
    super("The answer could not be read.");
  }
}

const EMDASH = "—";

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // pgx renders numeric/bigint columns as JSON numbers, but a wide numeric can
  // arrive as a string. A string that is entirely a number is a measurement;
  // a campaign name that happens to be "2026" is not, so only columns already
  // chosen as the measure go through this.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return EMDASH;
  if (typeof value === "string") return value.trim() || EMDASH;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : EMDASH;
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return EMDASH;
}

/** `campaign_name` → `Campaign name`. Column ids are snake_case from Postgres. */
export function humanizeColumn(column: string): string {
  const spaced = column.replace(/_/gu, " ").trim();
  if (!spaced) return column;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Columns whose values identify a row rather than measure it. `*_id` is
 * excluded outright: a UUID is never the label a human wants, and every
 * template that returns one also returns the name beside it.
 */
function isLabelColumn(column: string, value: unknown): boolean {
  if (/_id$/u.test(column) || column === "id") return false;
  return typeof value === "string" && value.trim() !== "";
}

function pickColumns(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): { labelColumn: string | null; valueColumn: string | null } {
  const first = rows[0];
  if (!first) return { labelColumn: null, valueColumn: null };
  const labelColumn =
    columns.find((column) => isLabelColumn(column, first[column])) ?? null;
  // The LAST numeric column, not the first: templates put identifiers first
  // and the measure last (`campaign_id, campaign_name, unique_opens`).
  const numeric = columns.filter(
    (column) => typeof first[column] === "number" && Number.isFinite(first[column]),
  );
  return {
    labelColumn,
    valueColumn: numeric.length > 0 ? (numeric[numeric.length - 1] ?? null) : null,
  };
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

export function parseAnalyticsAnswer(raw: unknown): AnalyticsAnswer {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AnalyticsAnswerUnreadableError();
  }
  const body = raw as Record<string, unknown>;

  const summaryText =
    typeof body.summary_text === "string" ? body.summary_text.trim() : "";
  // The summary is the answer. Rows without it would render as a bare table
  // with no statement of what was asked or found.
  if (!summaryText) throw new AnalyticsAnswerUnreadableError();

  const columns = Array.isArray(body.columns)
    ? body.columns.filter((c): c is string => typeof c === "string")
    : [];

  const rawRows = Array.isArray(body.rows)
    ? body.rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      )
    : [];

  const { labelColumn, valueColumn } = pickColumns(columns, rawRows);

  const rows: AnalyticsAnswerRow[] = rawRows.map((row, index) => ({
    id: String(row[`${labelColumn ?? ""}`] ?? index),
    label: labelColumn ? cellText(row[labelColumn]) : `Row ${index + 1}`,
    value: valueColumn ? finiteOrNull(row[valueColumn]) : null,
    cells: columns.map((column) => ({
      column,
      text: cellText(row[column]),
      value: finiteOrNull(row[column]),
    })),
  }));

  const params =
    typeof body.params === "object" && body.params !== null
      ? (body.params as Record<string, unknown>)
      : {};

  return {
    question: typeof body.question === "string" ? body.question : "",
    kind: body.answer_kind === "summary" ? "summary" : "table",
    template: typeof body.template === "string" ? body.template : "",
    // The handler clamps these; 0 means "the server did not say", which the
    // renderer prints as an unqualified window rather than as "0 days".
    windowDays: intOrNull(params.window_days) ?? 0,
    limit: intOrNull(params.limit) ?? 0,
    columns,
    rows,
    summaryText,
    labelColumn,
    valueColumn,
  };
}

/**
 * Failure copy. Every one of these is a real, documented outcome of the
 * handler, and each says something different to the reader — collapsing them
 * into "something went wrong" would tell an operator whose workspace has no
 * model key configured to keep retrying.
 */
export function analyticsAskErrorMessage(
  status: number,
  code: string | undefined,
  message: string | undefined,
): string {
  if (status === 503 || code === "nlq_unavailable") {
    return "Ask is not switched on for this workspace. An administrator has to configure the analytics assistant on the API server.";
  }
  if (status === 429 || code === "cost_cap_exceeded") {
    return "This workspace has used its daily question budget. It resets at midnight UTC.";
  }
  if (code === "invalid_template") {
    return "That question does not map onto a saved report. Try naming a metric — opens, clicks, unsubscribes, revenue, bounces or subscriber growth.";
  }
  if (status === 400 || code === "empty_question" || code === "question_too_long") {
    return "That question could not be read. Keep it to a sentence about one metric.";
  }
  if (status === 401 || status === 403) {
    return "You do not have permission to run analytics queries in this workspace.";
  }
  // A server sentence beats our generic copy; a transport string does not.
  return message && message.length < 200 && /\s/u.test(message)
    ? message
    : "The question could not be answered. Try again in a moment.";
}
