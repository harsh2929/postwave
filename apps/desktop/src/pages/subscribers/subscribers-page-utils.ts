import type { Subscriber } from "../../lib/api-client";
import type { SubscriberFilter } from "../../components/subscribers/SubscribersBrowsePanel";
import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  isServerSort,
  type ServerSort,
} from "../subscribers-paging";
import { SUBSCRIBER_COLUMN_CATALOG } from "../subscribers-view-columns";

export const SUBSCRIBERS_PER_PAGE = 50;
export const SUBSCRIBER_RELOAD_DEBOUNCE_MS = 2_500;
export const MAX_SUBSCRIBER_SAVED_QUERY_CHARS = 256;
const UNSAFE_SAVED_QUERY =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SAVED_SEGMENT_STATUSES = new Set([
  "all",
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
]);
const SAVED_SEGMENT_SORT_COLUMNS = new Set([
  DEFAULT_SORT,
  "email",
  "status",
  "joined",
  "engagement",
  "rating",
  "churn_score",
  "first_name",
  "last_name",
  "full_name",
  "display_name",
]);
const SAVED_SEGMENT_COLUMN_KEYS = new Set(
  SUBSCRIBER_COLUMN_CATALOG.map((column) => column.key),
);

/** Resolve directory column ids to the server's full-result sort contract. */
export function resolveSubscribersExportSort(
  sortColumn: string,
): ServerSort | null {
  if (isServerSort(sortColumn)) return sortColumn;
  if (sortColumn === "joined") return "created_at";
  if (sortColumn === "churn_score") return "churn";
  return null;
}

export function subscriberKey(subscriber: Subscriber): string {
  return String(subscriber.id ?? subscriber.email ?? "");
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
 * Encode one spreadsheet-safe CSV cell.
 *
 * Formula detection runs against the original text so leading tabs, line
 * breaks, C0/C1 controls, zero-width characters, bidi controls, and a BOM
 * cannot hide an =, +, -, or @ prefix. Hidden controls are then rendered as
 * visible Unicode escapes (tab/CR/LF remain real data), and dangerous cells
 * are forced to text with a leading apostrophe before RFC 4180 quoting.
 */
export function encodeSubscribersCsvCell(value: unknown): string {
  const original = value == null ? "" : String(value);
  const formulaLike = CSV_FORMULA_PREFIX.test(original);
  const visible = original.replace(CSV_HIDDEN_CONTROL, visibleUnicodeEscape);
  const text = formulaLike ? `'${visible}` : visible;
  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildSubscribersCsv(rows: Subscriber[]): string {
  const lines = [
    ["email", "status", "created_at", "joined_at", "tags"].join(","),
  ];
  for (const row of rows) {
    lines.push(
      [
        encodeSubscribersCsvCell(row.email),
        encodeSubscribersCsvCell(row.status),
        encodeSubscribersCsvCell(row.created_at),
        encodeSubscribersCsvCell(row.joined_at),
        encodeSubscribersCsvCell((row.tags ?? []).join("|")),
      ].join(","),
    );
  }
  return lines.join("\n");
}

export function getSubscribersSubtitle(input: {
  rows: Subscriber[] | null;
  filter: SubscriberFilter;
  query: string;
  serverTotal: number | null;
  matchTotal: number | null;
  pageRowCount: number;
}): string {
  if (!input.rows) return "Loading subscribers…";
  const isUnfiltered = input.filter === "all" && !input.query.trim();
  if (isUnfiltered) {
    const total = input.serverTotal ?? input.matchTotal ?? input.pageRowCount;
    const noun = total === 1 ? "contact" : "contacts";
    return `${total.toLocaleString()} ${noun} in this workspace.`;
  }
  const matched = input.matchTotal ?? input.pageRowCount;
  const noun = matched === 1 ? "contact" : "contacts";
  return `${matched.toLocaleString()} ${noun} matching this view.`;
}

export function isSubscribersLiveEligible(input: {
  filter: SubscriberFilter;
  debouncedQuery: string;
  page: number;
  sortColumn: string;
  sortOrder: string;
  showArchived: boolean;
}): boolean {
  return (
    input.filter === "all" &&
    !input.debouncedQuery.trim() &&
    input.page === 1 &&
    input.sortColumn === DEFAULT_SORT &&
    input.sortOrder === DEFAULT_ORDER &&
    !input.showArchived
  );
}

export function mergeBufferedSubscribers(
  buffered: Subscriber[],
  existing: Subscriber[] | null,
): Subscriber[] {
  const base = existing ?? [];
  const seen = new Set(base.map(subscriberKey));
  const fresh = buffered.filter((row) => !seen.has(subscriberKey(row)));
  return [...fresh, ...base];
}

export function savedSegmentSnapshot(predicate: unknown): {
  status: unknown;
  query: string | undefined;
  version: number | undefined;
  authoritative: boolean;
  resourceScope: string | undefined;
  workspaceScope: string | undefined;
  showArchived: boolean | undefined;
  sortColumn: string | undefined;
  sortOrder: "asc" | "desc" | undefined;
  columns: string[] | undefined;
} | null {
  if (!predicate || typeof predicate !== "object") return null;
  const value = predicate as {
    status?: unknown;
    q?: unknown;
    filters?: { status?: unknown; q?: unknown } | null;
    snapshot?: {
      status?: unknown;
      q?: unknown;
      applied_query?: unknown;
      version?: unknown;
      resource_scope?: unknown;
      workspace_scope?: unknown;
      show_archived?: unknown;
      include_archived?: unknown;
      sort_column?: unknown;
      sort_order?: unknown;
      sort?: { column?: unknown; order?: unknown } | null;
      columns?: unknown;
      reset?: { page?: unknown; selection?: unknown } | null;
    } | null;
  };
  const flat =
    value.status !== undefined || value.q !== undefined ? value : null;
  const declaredSnapshotVersion = value.snapshot?.version;
  const requiresAuthoritativeSnapshot =
    typeof declaredSnapshotVersion === "number" &&
    Number.isSafeInteger(declaredSnapshotVersion) &&
    declaredSnapshotVersion >= 3;
  // Once a record declares the authoritative v3+ contract, never fall back to
  // its compatibility `filters` object. A damaged/future snapshot must be
  // rejected by the caller instead of silently restoring only status/query.
  const snapshot = requiresAuthoritativeSnapshot
    ? value.snapshot
    : [value.snapshot, value.filters, flat].find(
        (candidate) =>
          candidate &&
          (candidate.status !== undefined || candidate.q !== undefined),
      );
  if (!snapshot) return null;
  const enriched = snapshot as NonNullable<typeof value.snapshot>;
  const columns = Array.isArray(enriched.columns)
    ? enriched.columns.filter(
        (column): column is string => typeof column === "string",
      )
    : undefined;
  const version =
    typeof enriched.version === "number" &&
    Number.isSafeInteger(enriched.version) &&
    enriched.version > 0
      ? enriched.version
      : undefined;
  const queryValue = enriched.applied_query ?? snapshot.q;
  const query =
    typeof queryValue === "string" &&
    queryValue.length <= MAX_SUBSCRIBER_SAVED_QUERY_CHARS &&
    queryValue === queryValue.trim() &&
    !UNSAFE_SAVED_QUERY.test(queryValue)
      ? queryValue
      : queryValue === undefined
        ? ""
        : undefined;
  const showArchivedValue = enriched.include_archived ?? enriched.show_archived;
  const sortColumnValue = enriched.sort?.column ?? enriched.sort_column;
  const sortOrderValue = enriched.sort?.order ?? enriched.sort_order;
  const resourceScope =
    typeof enriched.resource_scope === "string"
      ? enriched.resource_scope
      : undefined;
  const workspaceScope =
    typeof enriched.workspace_scope === "string"
      ? enriched.workspace_scope
      : undefined;
  const authoritativeColumns =
    Array.isArray(enriched.columns) &&
    enriched.columns.length > 0 &&
    enriched.columns.length <= SAVED_SEGMENT_COLUMN_KEYS.size &&
    enriched.columns.every(
      (column) =>
        typeof column === "string" && SAVED_SEGMENT_COLUMN_KEYS.has(column),
    ) &&
    new Set(enriched.columns).size === enriched.columns.length &&
    enriched.columns.includes("email");
  return {
    status: snapshot.status,
    query,
    version,
    authoritative:
      version === 3 &&
      resourceScope === "subscriber_directory" &&
      workspaceScope === "current" &&
      typeof snapshot.status === "string" &&
      SAVED_SEGMENT_STATUSES.has(snapshot.status) &&
      query !== undefined &&
      typeof enriched.applied_query === "string" &&
      typeof showArchivedValue === "boolean" &&
      typeof sortColumnValue === "string" &&
      SAVED_SEGMENT_SORT_COLUMNS.has(sortColumnValue) &&
      (sortOrderValue === "asc" || sortOrderValue === "desc") &&
      authoritativeColumns &&
      enriched.reset?.page === 1 &&
      enriched.reset.selection === "clear",
    resourceScope,
    workspaceScope,
    showArchived:
      typeof showArchivedValue === "boolean" ? showArchivedValue : undefined,
    sortColumn:
      typeof sortColumnValue === "string" ? sortColumnValue : undefined,
    sortOrder:
      sortOrderValue === "asc" || sortOrderValue === "desc"
        ? sortOrderValue
        : undefined,
    columns,
  };
}
