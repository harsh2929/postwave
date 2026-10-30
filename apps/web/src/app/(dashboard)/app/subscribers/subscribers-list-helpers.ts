// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared, pure helpers for the subscribers LIST surface (status → badge
// variant, the status-filter <-> API-param mapping, sortable-column config,
// and an unambiguous date formatter). Mirrors the campaigns cluster's
// `campaign-list-helpers.ts` so status color and filter semantics live in one
// tested place instead of being inlined per-cell.

import type { BadgeProps } from "@/components/ui/badge";
import type { SubscriberStatus } from "@/lib/subscribers-api";

export type SubscriberBadgeVariant = NonNullable<BadgeProps["variant"]>;

/** Semantic badge variant for a subscriber lifecycle status. */
export function subscriberStatusVariant(
  status: SubscriberStatus,
): SubscriberBadgeVariant {
  switch (status) {
    case "enabled":
      return "success";
    case "blocklisted":
      return "destructive";
    case "unconfirmed":
      return "secondary";
    default:
      return "outline";
  }
}

/** Humanize an underscored enum value ("double_optin" -> "double optin"). */
export function labelize(value: string): string {
  return value.replace(/_/g, " ");
}

/* ---- Status filter (drives the clickable stat cards + segmented control) --- */

// Desktop exposes the fourth engine state (`disabled`) as its own chip; the
// page's URL schema is built from this list, so adding it here is what lets
// `?status=disabled` reach GET /api/v1/subscribers?status=disabled.
export type SubscriberStatusFilter =
  | "all"
  | "enabled"
  | "suppressed"
  | "disabled"
  | "pending";

export const SUBSCRIBER_STATUS_FILTERS: readonly SubscriberStatusFilter[] = [
  "all",
  "enabled",
  "suppressed",
  "disabled",
  "pending",
];

/** Map a UI filter to the backend `?status=` value (undefined = no filter). */
export function statusFilterToParam(
  filter: SubscriberStatusFilter,
): SubscriberStatus | undefined {
  switch (filter) {
    case "enabled":
      return "enabled";
    case "suppressed":
      return "blocklisted";
    case "disabled":
      return "disabled";
    case "pending":
      return "unconfirmed";
    default:
      return undefined;
  }
}

export function statusFilterLabel(filter: SubscriberStatusFilter): string {
  switch (filter) {
    case "all":
      return "All";
    case "enabled":
      return "Enabled";
    case "suppressed":
      return "Suppressed";
    case "disabled":
      return "Disabled";
    case "pending":
      return "Pending";
  }
}

/* ---- Sortable columns ----------------------------------------------------- */

// Every key here is one the list endpoint's `normalizeSort` accepts
// (apps/api/internal/subscribers/repo_helpers.go); anything else silently
// falls back to `updated_at` server-side, so a page-only sort must never be
// added to this list.
export type SubscriberSortKey =
  | "email"
  | "status"
  | "updated_at"
  | "created_at"
  | "engagement"
  | "rating"
  | "churn"
  | "first_name"
  | "last_name";
export type SortOrder = "asc" | "desc";

export const SUBSCRIBER_SORT_KEYS: readonly SubscriberSortKey[] = [
  "email",
  "status",
  "updated_at",
  "created_at",
  "engagement",
  "rating",
  "churn",
  "first_name",
  "last_name",
];

/** Next sort state when a column header is clicked (toggles order, or switches
 *  column and starts descending). Pure so it can be unit-tested. */
export function nextSort(
  current: { sort: SubscriberSortKey; order: SortOrder },
  clicked: SubscriberSortKey,
): { sort: SubscriberSortKey; order: SortOrder } {
  if (current.sort === clicked) {
    return { sort: clicked, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { sort: clicked, order: "desc" };
}

/* ---- Dates ---------------------------------------------------------------- */

// Both formatters run twice per table row (50 rows/page), so on every keystroke
// in the search box they used to construct ~100 Intl.DateTimeFormat objects —
// the expensive half of `toLocaleDateString`/`toLocaleString`. Constructing the
// formatter once at module scope and reusing `.format()` keeps the per-render
// cost to the formatting itself. Lazily created so a locale-less/ICU-less
// runtime still only pays on first use, and so the module stays import-safe.
let listDateFormat: Intl.DateTimeFormat | null = null;
let absoluteDateFormat: Intl.DateTimeFormat | null = null;

function listDateFormatter(): Intl.DateTimeFormat {
  listDateFormat ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return listDateFormat;
}

function absoluteDateFormatter(): Intl.DateTimeFormat {
  // These options are exactly what `Date.prototype.toLocaleString()` defaults
  // to, so the rendered tooltip is byte-identical to the previous call.
  absoluteDateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return absoluteDateFormat;
}

/** Unambiguous "May 1, 2026" label matching the detail page's `fmtDate`. */
export function formatListDate(value?: string): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : listDateFormatter().format(d);
}

/** Full locale date+time for the `title` tooltip; "" when unparseable. */
export function formatAbsoluteDate(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : absoluteDateFormatter().format(d);
}

/* ---- Bulk id collection --------------------------------------------------- */

/**
 * How many list pages the "select all matching" id sweep keeps in flight.
 *
 * The sweep used to be strictly serial: 50 round-trips, one after another, to
 * turn a 10k-row filter into 10k UUIDs. Six is a deliberate ceiling — it is the
 * browser's own per-origin HTTP/1.1 connection limit, so a wider window would
 * only queue in the socket pool while making the server's job spikier.
 */
export const BULK_ID_FETCH_CONCURRENCY = 6;

/**
 * Collect ids page by page, `concurrency` pages at a time.
 *
 * Order is preserved (page 1's ids come first) and the two stop conditions of
 * the serial version are kept exactly: the sweep ends at `cap` ids, and it ends
 * at the first short page — a page returning fewer than `per` rows means the
 * result set is exhausted, so pages after it are discarded even if they were
 * fetched in the same wave.
 *
 * Pure apart from `fetchPage`, so the pagination arithmetic is testable without
 * a network.
 */
export async function collectIdsPaged(
  fetchPage: (page: number) => Promise<{ ids: string[]; count: number }>,
  opts: { total: number; per: number; cap: number; concurrency?: number },
): Promise<string[]> {
  const { total, per, cap } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? BULK_ID_FETCH_CONCURRENCY);
  const pages = Math.min(Math.ceil(total / per) || 1, Math.ceil(cap / per));
  const ids: string[] = [];

  for (let start = 1; start <= pages; start += concurrency) {
    const wave: number[] = [];
    for (let p = start; p < start + concurrency && p <= pages; p++) wave.push(p);
    const results = await Promise.all(wave.map((p) => fetchPage(p)));
    for (const res of results) {
      for (const id of res.ids) {
        ids.push(id);
        if (ids.length >= cap) return ids;
      }
      // Short page: the filter is exhausted. Anything fetched after it in this
      // wave is beyond the end of the result set.
      if (res.count < per) return ids;
    }
  }
  return ids;
}
