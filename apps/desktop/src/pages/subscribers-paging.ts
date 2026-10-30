/**
 * subscribers-paging — pure logic for the server-driven Subscribers list.
 *
 * The Subscribers page used to fetch one large page (per_page 500) and do
 * ALL search / status-filter / sort / pagination client-side. That breaks
 * at 5M rows. These helpers describe the OFFSET numbered-pager model the
 * page now drives off the server:
 *
 *   - SERVER_SORTS / isServerSort: which columns the backend can sort by.
 *     Anything else is a CLIENT sort of the current page only (and the
 *     page labels it as such).
 *   - buildListParams: page state → api.listSubscribers() opts. Maps the
 *     UI status bucket to the engine vocabulary the server's `status`
 *     filter accepts, and clamps perPage to the server max (200).
 *   - parseListResponse: SubscribersResponse → an honest
 *     {rows, total, page, perPage}. Reads rows from items|data|results,
 *     and — critically — only trusts a positive `total`; on the cursor
 *     path the server returns total:0 (we don't use cursor mode here, but
 *     the guard keeps the caller honest if it ever leaks through).
 *   - pagerView: total/page/perPage → {totalPages, page (clamped), label}
 *     for an honest "Page X of Y · N of TOTAL" footer.
 *
 * Pure + dependency-light so it's unit-testable without a DOM.
 */

import type { SubscribersResponse, Subscriber } from "../lib/api-client";

/** The server's max per_page (api-client/backed). Requests above this are
 * clamped server-side; we clamp here too so the pager math matches what
 * actually comes back. */
export const MAX_PER_PAGE = 200;

/** Columns the backend `sort` param understands. Any other column is a
 * client-only sort of the rows on the current page. */
export const SERVER_SORTS = [
  "updated_at",
  "created_at",
  "email",
  "status",
  "engagement",
  // SUB-004 — first-class name columns. The backend normalizeSort routes
  // these to the (tenant_id, first_name, last_name) compound index.
  "first_name",
  "last_name",
  // SUB-038 — churn-risk + Mailchimp-parity contact rating. The backend
  // normalizeSort maps "churn"→churn_score (mig 0180 index) and
  // "rating"→rating (mig 0226 index).
  "churn",
  "rating",
] as const;
export type ServerSort = (typeof SERVER_SORTS)[number];

export type SortOrder = "asc" | "desc";

/** Default sort the page boots with (matches the server default + the
 * only sort the keyset-cursor path honours, were we to use it). */
export const DEFAULT_SORT: ServerSort = "updated_at";
export const DEFAULT_ORDER: SortOrder = "desc";

export function isServerSort(s: string): s is ServerSort {
  return (SERVER_SORTS as readonly string[]).includes(s);
}

/** UI status bucket → engine `status` value the server filter accepts.
 * `all` (or empty) clears the filter. Injected rather than imported so
 * this module stays free of the status-helper's React-adjacent deps and
 * the mapping is exercised directly in tests. */
export type StatusToEngine = (uiStatus: string) => string | null;

export interface ListParamsInput {
  /** Free-text search; trimmed. Empty → omitted (server returns all). */
  query: string;
  /** UI status bucket or "all". */
  status: string;
  sort: string;
  order: SortOrder;
  /** 1-based page. */
  page: number;
  perPage: number;
  /** Maps a UI status bucket to the engine value. */
  statusToEngine: StatusToEngine;
  /** SUB-009 — include soft-deleted (archived) rows. Default false. */
  includeArchived?: boolean;
}

export interface ListParams {
  query?: string;
  status?: string;
  sort?: string;
  order?: SortOrder;
  page: number;
  perPage: number;
  /** SUB-009 — forwarded as ?include_archived=true when set. */
  includeArchived?: boolean;
}

/**
 * Build the api.listSubscribers() opts from page state. Only server-
 * supported sorts are forwarded; an unsupported column falls back to the
 * default sort server-side (the page sorts the returned page locally for
 * those columns and says so).
 */
export function buildListParams(input: ListParamsInput): ListParams {
  const perPage = clampPerPage(input.perPage);
  const page = Math.max(1, Math.floor(input.page) || 1);
  const out: ListParams = { page, perPage };

  const q = (input.query ?? "").trim();
  if (q) out.query = q;

  const status = (input.status ?? "").toLowerCase();
  if (status && status !== "all") {
    const engine = input.statusToEngine(status);
    if (engine) out.status = engine;
  }

  // Forward sort only when the server supports it; otherwise let the
  // server use its default (updated_at desc) and let the caller sort the
  // returned page locally.
  if (isServerSort(input.sort)) {
    out.sort = input.sort;
    out.order = input.order;
  }

  // SUB-009 — only set the flag when truthy so the default request stays
  // identical (the server hides archived rows unless asked).
  if (input.includeArchived) out.includeArchived = true;

  return out;
}

export function clampPerPage(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(MAX_PER_PAGE, Math.floor(n));
}

export interface ParsedList {
  rows: Subscriber[];
  /** Honest total: a non-negative count from the offset response, or null
   * when the server didn't report a usable total (cursor path → total 0,
   * or absent). */
  total: number | null;
  page: number;
  perPage: number;
}

/**
 * Read rows + paging metadata out of a SubscribersResponse. Rows come from
 * items|data|results (in that order). `total` is only trusted when it's a
 * finite number > 0 — the cursor path reports total:0, which would lie to
 * the pager — but a genuinely empty result (no rows) is reported as 0.
 */
export function parseListResponse(
  payload: SubscribersResponse | null | undefined,
  reqPage: number,
  reqPerPage: number,
): ParsedList {
  const rows = unwrapRows(payload);
  const rawTotal = payload?.total;
  let total: number | null;
  if (
    typeof rawTotal === "number" &&
    Number.isFinite(rawTotal) &&
    rawTotal > 0
  ) {
    total = rawTotal;
  } else if (rows.length === 0 && (rawTotal === 0 || rawTotal == null)) {
    // Genuinely empty page on page 1 ⇒ honest 0. On a deeper page an
    // empty slice with no total just means "past the end" — leave null so
    // the caller doesn't render "0 of 0" over a known non-empty set.
    total = reqPage <= 1 ? 0 : null;
  } else {
    // We got rows but no usable total (cursor path / sparse backend). We
    // can't honestly claim a grand total.
    total = null;
  }
  const page =
    typeof payload?.page === "number" && payload.page > 0
      ? payload.page
      : Math.max(1, reqPage);
  const perPage =
    typeof payload?.per_page === "number" && payload.per_page > 0
      ? payload.per_page
      : clampPerPage(reqPerPage);
  return { rows, total, page, perPage };
}

export function unwrapRows(
  payload: SubscribersResponse | null | undefined,
): Subscriber[] {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export interface PagerView {
  /** 1-based, clamped into [1, totalPages]. */
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Honest footer label, e.g. "Page 2 of 40 · 50 of 1,984". */
  label: string;
  /** True when we know a real total from the server. */
  hasTotal: boolean;
}

/**
 * Compute the pager view for an honest footer. `loadedCount` is the number
 * of rows actually on screen for this page. When `total` is null we can't
 * compute totalPages, so we degrade to a "Page N · M loaded" label and
 * keep Next enabled while the last page came back full.
 */
export function pagerView(
  page: number,
  total: number | null,
  perPage: number,
  loadedCount: number,
): PagerView {
  const pp = clampPerPage(perPage);
  if (total != null) {
    const totalPages = Math.max(1, Math.ceil(total / pp));
    const clamped = Math.min(Math.max(1, page), totalPages);
    const label =
      total === 0
        ? "No subscribers"
        : `Page ${clamped.toLocaleString()} of ${totalPages.toLocaleString()} · ${loadedCount.toLocaleString()} of ${total.toLocaleString()}`;
    return {
      page: clamped,
      totalPages,
      hasPrev: clamped > 1,
      hasNext: clamped < totalPages,
      label,
      hasTotal: true,
    };
  }
  // No usable total: degrade honestly. Next stays available while the page
  // came back full (a short page means we hit the end).
  const clamped = Math.max(1, page);
  const hasNext = loadedCount >= pp;
  return {
    page: clamped,
    totalPages: clamped + (hasNext ? 1 : 0),
    hasPrev: clamped > 1,
    hasNext,
    label:
      loadedCount === 0
        ? "No subscribers"
        : `Page ${clamped.toLocaleString()} · ${loadedCount.toLocaleString()} loaded`,
    hasTotal: false,
  };
}

/**
 * Client-only fallback sort for columns the server can't sort. Sorts the
 * CURRENT page's rows in place-safe fashion (returns a new array). Only
 * called for unsupported columns; supported columns are sorted server-side.
 */
export function clientSortPage(
  rows: Subscriber[],
  column: string,
  order: SortOrder,
): Subscriber[] {
  const dir = order === "asc" ? 1 : -1;
  const get = (r: Subscriber): string | number => {
    const v = (r as unknown as Record<string, unknown>)[column];
    if (typeof v === "number") return v;
    if (v == null) return "";
    return String(v);
  };
  return [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}
