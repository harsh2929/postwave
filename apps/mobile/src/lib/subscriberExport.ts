/**
 * subscriberExport — "send me the people I'm looking at", from the phone.
 *
 * Desktop exports the APPLIED subscriber view through
 * `GET /api/v1/subscribers/export.csv` (SUB-107/108). Mobile could only run
 * whole-tenant data exports, so the person on a call who has just narrowed
 * the list to "unsubscribed people matching acme" could not hand that set to
 * anyone. This module builds the same server-side export request from the
 * list's own settled state and re-emits the response for the share sheet.
 *
 * WHY THE SERVER'S CSV IS RE-EMITTED RATHER THAN FORWARDED: same reason as
 * lib/suppressionExport.ts — the server quotes per RFC4180 but does not
 * neutralise leading `=` `+` `-` `@`, and subscriber names and custom fields
 * are attacker-writable (signup forms), so a forwarded export pastes chosen
 * formulas into a spreadsheet. `csvField` neutralises every cell.
 *
 * WHY IT IS CAPPED: a share sheet is not a file — `expo-file-system` is not a
 * dependency, the payload travels as text, and iOS mangles very large ones.
 * The cap is stated in the title and the caller's toast, so a slice is never
 * mistaken for the audience.
 *
 * Import-free beyond csvShare, so every rule is node-unit-testable.
 */
import { csvField, parseCsvRows } from "@/lib/csvShare";

/** Rows requested and rows kept. See module doc for why this is small. */
export const SUBSCRIBER_EXPORT_MAX_ROWS = 500;

export interface SubscriberExportView {
  /** Settled free-text query ("" when none). */
  query: string;
  /** ENGINE status filter, or undefined for all. */
  engineStatus: string | undefined;
  /** Server sort column + order (from lib/subscriberSort). */
  sort: string;
  order: "asc" | "desc";
  includeArchived: boolean;
}

/**
 * The export request for the applied view. Everything the list sent, the
 * export sends — a download that silently dropped the filter would export a
 * different audience than the one on screen.
 */
export function subscribersExportPath(
  view: SubscriberExportView,
  limit = SUBSCRIBER_EXPORT_MAX_ROWS,
): string {
  const bounded = Math.max(
    1,
    Math.min(SUBSCRIBER_EXPORT_MAX_ROWS, Math.trunc(limit) || 0),
  );
  const params = new URLSearchParams();
  params.set("limit", String(bounded));
  const q = view.query.trim();
  if (q) params.set("q", q);
  if (view.engineStatus) params.set("status", view.engineStatus);
  if (view.sort) {
    params.set("sort", view.sort);
    params.set("order", view.order);
  }
  if (view.includeArchived) params.set("include_archived", "true");
  return `/api/v1/subscribers/export.csv?${params.toString()}`;
}

/**
 * Why an export may not run RIGHT NOW, or null when it may. Mirrors desktop's
 * settle guard: exporting while the debounced query or a refetch is still in
 * flight would freeze a view the operator is not looking at.
 */
export function subscriberExportBlockedReason(input: {
  draftQuery: string;
  settledQuery: string;
  loading: boolean;
  gated: boolean;
  online: boolean;
}): string | null {
  if (input.gated) {
    return "Reconnect this session before exporting subscriber data.";
  }
  if (!input.online) {
    return "You're offline. The export asks the server for the full matching set.";
  }
  if (input.loading || input.draftQuery.trim() !== input.settledQuery.trim()) {
    return "Wait for the subscriber view to finish updating, then export.";
  }
  return null;
}

export interface SubscriberExportResult {
  /** The text handed to the share sheet. */
  body: string;
  /** Share-sheet subject line, carrying the scope and any truncation. */
  title: string;
  /** Data rows written (header excluded). */
  included: number;
  truncated: boolean;
}

/** Human scope fragment for titles and receipts. */
export function subscriberExportScope(view: {
  query: string;
  statusNoun: string;
  includeArchived: boolean;
}): string {
  const parts: string[] = [];
  const q = view.query.trim();
  if (q) parts.push(`matching “${q}”`);
  parts.push(view.statusNoun);
  if (view.includeArchived) parts.push("including archived");
  return parts.join(" · ");
}

/**
 * Turn the server's streamed CSV into a bounded, injection-safe payload.
 *
 * `serverTotal` is the list's own count of the applied view, used ONLY to
 * decide honesty about truncation — pass undefined when unknown and the
 * at-the-cap heuristic still applies (a response that exactly fills the
 * request cannot prove it was complete).
 */
export function subscriberExportCsv(
  raw: string,
  options: {
    scope: string;
    serverTotal?: number | undefined;
    cap?: number;
  },
): SubscriberExportResult {
  const cap = Math.max(0, Math.trunc(options.cap ?? SUBSCRIBER_EXPORT_MAX_ROWS));
  const parsed = parseCsvRows(raw ?? "").filter(
    (row) => row.length > 1 || (row[0] ?? "").trim() !== "",
  );
  const header =
    parsed.length > 0 &&
    (parsed[0]?.[0] ?? "").trim().toLowerCase() === "email"
      ? parsed[0]!
      : null;
  const data = header ? parsed.slice(1) : parsed;
  const kept = data.slice(0, cap);
  const total =
    typeof options.serverTotal === "number" &&
    Number.isFinite(options.serverTotal) &&
    options.serverTotal > 0
      ? Math.trunc(options.serverTotal)
      : 0;
  const truncated =
    data.length > kept.length ||
    total > kept.length ||
    (cap > 0 && data.length >= cap);

  const lines: string[] = [];
  const emit = (row: readonly string[]) =>
    lines.push(row.map((cell) => csvField(cell)).join(","));
  emit(
    header ?? [
      "email",
      "name",
      "status",
      "tags",
      "custom_fields_json",
      "merge_fields_json",
      "engagement_score",
      "rating",
      "churn_score",
      "created_at",
    ],
  );
  for (const row of kept) emit(row);

  const countClause = truncated
    ? `first ${kept.length}${total > 0 ? ` of ${total}` : ""}`
    : `${kept.length}`;
  return {
    body: lines.join("\n"),
    title: `Subscribers (${countClause}) — ${options.scope}`,
    included: kept.length,
    truncated,
  };
}

/** The receipt spoken after the share sheet closes. */
export function subscriberExportNotice(
  result: SubscriberExportResult,
): string {
  if (result.included === 0) {
    return "No subscribers match this view, so there was nothing to export.";
  }
  return result.truncated
    ? `Exported the first ${result.included} matching subscribers. The view has more — use the web admin for a complete file.`
    : `Exported ${result.included} subscribers — the complete matching set.`;
}
