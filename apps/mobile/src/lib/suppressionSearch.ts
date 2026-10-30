/**
 * suppressionSearch — the shared vocabulary behind the suppression
 * surfaces (list, detail, add form, SMS list).
 *
 * This is a port of `apps/desktop/src/components/suppressions/suppression-search.ts`
 * so both clients bucket the same stored reason into the same chip. Mobile
 * previously hand-rolled a five-entry substring matcher which silently dropped
 * `spam_trap` entirely (it matched neither the bounce nor the complaint arm)
 * and folded soft bounces in with hard bounces — erasing the distinction that
 * decides whether you retry or purge.
 *
 * Server reality (apps/api/internal/suppressions/handlers.go List, "A20"):
 *   GET /api/v1/deliverability/suppressions?page=&size=&email=&q=
 *     - `email` is an EXACT citext match (case-insensitive)
 *     - `q` is a case-insensitive email PREFIX filter
 *     - `total` reflects the FILTERED count
 *
 * `classifySearchQuery` decides which of those a raw search box value can use:
 *   - "exact"  — parses as a full email → `email=`
 *   - "prefix" — >= 3 chars → `q=` (shorter prefixes scan-storm the index and
 *                match a large fraction of the table anyway)
 *   - "client" — 1-2 chars: too short for the server, filter the loaded page
 *   - "none"   — empty query
 */
import { num } from "@/lib/format";


/** Same shape the add-suppression form validates against. */
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimum length before a prefix search is worth a round trip. */
export const SERVER_SEARCH_MIN_PREFIX = 3;

export type SearchMode = "none" | "client" | "prefix" | "exact";

export interface ClassifiedQuery {
  mode: SearchMode;
  /** Trimmed, lowercased value to send (or filter with). */
  value: string;
}

export function classifySearchQuery(raw: string): ClassifiedQuery {
  const value = raw.trim().toLowerCase();
  if (!value) return { mode: "none", value: "" };
  if (FULL_EMAIL_RE.test(value)) return { mode: "exact", value };
  if (value.length >= SERVER_SEARCH_MIN_PREFIX) return { mode: "prefix", value };
  return { mode: "client", value };
}

/** Query-string fragment for the classified search, "" when not server-side. */
export function searchQueryParams(classified: ClassifiedQuery): string {
  if (classified.mode === "exact") {
    return `&email=${encodeURIComponent(classified.value)}`;
  }
  if (classified.mode === "prefix") {
    return `&q=${encodeURIComponent(classified.value)}`;
  }
  return "";
}

/** True when the loaded page still needs a client-side narrowing pass. */
export function needsClientFilter(classified: ClassifiedQuery): boolean {
  return classified.mode === "client";
}

export type SuppressionFilter =
  | "all"
  | "hard_bounce"
  | "soft_bounce"
  | "complaint"
  | "spamtrap"
  | "delivery_issue"
  | "manual"
  | "unsubscribe";

/**
 * Chip → stored reason values. The legacy table stores free-form values
 * ("complaint", "manual", "unsubscribe"); the converged X1 store uses the
 * canonical enum ("spam_complaint", "manual_unsubscribe", …). Server-side
 * search returns X1 rows, so the chips must match both families.
 */
export const FILTER_REASON_ALIASES: Readonly<
  Record<Exclude<SuppressionFilter, "all">, readonly string[]>
> = {
  hard_bounce: ["hard_bounce", "hardbounce", "bounce"],
  soft_bounce: ["soft_bounce", "soft_bounce_threshold"],
  complaint: ["complaint", "spam_complaint"],
  spamtrap: ["spamtrap", "spam_trap"],
  delivery_issue: [
    "role_account",
    "role_address",
    "dns_failure",
    "invalid_address",
    "invalid_email",
    "list_unsub_header",
    "blocklist_auto",
  ],
  // `dsar_deletion` is a canonical reason (suppressions/channel.go) that used
  // to match NO chip on either client, so an erasure-request row could only
  // ever be seen under "All". It is not a bounce and not a marketing
  // unsubscribe; the nearest true bucket is the operator-placed hold.
  manual: ["manual", "list_manual", "admin", "blocklisted", "dsar_deletion"],
  unsubscribe: ["unsubscribe", "unsubscribed", "manual_unsubscribe", "global_unsubscribe"],
};

export function reasonMatchesFilter(
  reason: string | undefined,
  filter: SuppressionFilter,
): boolean {
  if (filter === "all") return true;
  const r = (reason ?? "").trim().toLowerCase();
  return FILTER_REASON_ALIASES[filter].includes(r);
}

export interface SuppressionFilterDef {
  key: SuppressionFilter;
  /** Chip text — short enough to keep the row on one line. */
  label: string;
  /** Spoken label; the short chip text is ambiguous out of context. */
  accessibilityLabel: string;
}

export const SUPPRESSION_FILTERS: readonly SuppressionFilterDef[] = [
  { key: "all", label: "All", accessibilityLabel: "Show all suppressions" },
  {
    key: "hard_bounce",
    label: "Hard bounce",
    accessibilityLabel: "Filter to hard bounces",
  },
  {
    key: "soft_bounce",
    label: "Soft bounce",
    accessibilityLabel: "Filter to soft bounces",
  },
  {
    key: "complaint",
    label: "Complaint",
    accessibilityLabel: "Filter to spam complaints",
  },
  {
    key: "spamtrap",
    label: "Spam trap",
    accessibilityLabel: "Filter to spam traps",
  },
  {
    key: "delivery_issue",
    label: "Delivery issue",
    accessibilityLabel: "Filter to delivery issues",
  },
  { key: "manual", label: "Manual", accessibilityLabel: "Filter to manual holds" },
  {
    key: "unsubscribe",
    label: "Unsub",
    accessibilityLabel: "Filter to unsubscribes",
  },
];

export type ReasonTone = "danger" | "warning" | "neutral" | "info";

/**
 * Tone is derived from the SAME alias table as the chips, so the badge colour
 * and the filter can never disagree about what a reason means (they used to:
 * `reasonTone` had its own substring rules).
 */
export function reasonTone(reason: string | undefined): ReasonTone {
  if (reasonMatchesFilter(reason, "hard_bounce")) return "danger";
  if (reasonMatchesFilter(reason, "complaint")) return "danger";
  if (reasonMatchesFilter(reason, "spamtrap")) return "danger";
  if (reasonMatchesFilter(reason, "soft_bounce")) return "warning";
  if (reasonMatchesFilter(reason, "delivery_issue")) return "warning";
  if (reasonMatchesFilter(reason, "manual")) return "info";
  return "neutral";
}

/** `hard_bounce` → `Hard bounce`. Never returns an empty label. */
export function reasonLabel(reason: string | undefined): string {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r) return "unknown";
  const words = r.replace(/[_-]+/g, " ").trim();
  if (!words) return "unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The reasons an operator may pick when adding a suppression by hand.
 * `list_manual` is the server's default for operator adds (handlers.go Add),
 * so it leads.
 */
export const MANUAL_ADD_REASONS = [
  { value: "list_manual", label: "Manual" },
  { value: "complaint", label: "Complaint" },
  { value: "hard_bounce", label: "Hard bounce" },
  { value: "spamtrap", label: "Spam trap" },
] as const;

export type ManualAddReason = (typeof MANUAL_ADD_REASONS)[number]["value"];

/** Loose email check for the add form — the server is still the authority. */
export function isLikelyEmail(value: string): boolean {
  return FULL_EMAIL_RE.test(value.trim().toLowerCase());
}

/**
 * Resolve a stored filter preference back to a real bucket.
 *
 * The reason chip is now REMEMBERED across launches, which introduces a
 * failure the transient version could not have: a key written by an older
 * build (the taxonomy went from five substring buckets to the eight canonical
 * ones) would otherwise leave the screen filtering by a reason no row can
 * carry — an empty list that looks like a clean workspace.
 */
export function suppressionFilterByKey(key: string | undefined): SuppressionFilter {
  const match = SUPPRESSION_FILTERS.find((f) => f.key === key);
  return match ? match.key : "all";
}

/**
 * The sentence that keeps "newest first" honest.
 *
 * Rows are ordered client-side over the LOADED PAGE. When more suppressions
 * exist than the page holds, "newest" means "newest within this page", which
 * is not what the words imply — so say it. When the page IS the whole filtered
 * set, there is nothing to disclose and this returns "".
 *
 * `total` is the server's count for the CURRENT filter, and `shown` is what
 * the screen rendered after any client-side narrowing.
 *
 * `canLoadMore` changes the ADVICE, not the disclosure. While more pages can
 * still be fetched, telling the operator to "search by address to reach the
 * rest" is wrong — there is a button right there. The sentence only falls back
 * to search once paging has genuinely run out (the page cap, or an offline
 * snapshot, both of which leave rows unreachable by tapping).
 */
export function suppressionPageScopeNote(input: {
  shown: number;
  total: number | null | undefined;
  /** True when a reason chip narrowed the page client-side. */
  clientFiltered: boolean;
  /** True when a "Load more" control is on screen and would fetch more. */
  canLoadMore?: boolean;
}): string {
  const { shown, total } = input;
  if (typeof total !== "number" || total <= shown) return "";
  const grouped = num(total);
  const scope = `Showing ${num(shown)} of ${grouped} suppressed addresses, newest first within what's loaded.`;
  if (input.canLoadMore) {
    return input.clientFiltered
      ? `${scope} The reason filter narrows only what's loaded — load more, or search by address.`
      : `${scope} Load more to reach older records.`;
  }
  return input.clientFiltered
    ? `${scope} The reason filter narrows only what's loaded — search by address to reach the rest.`
    : `${scope} Search by address to reach older records.`;
}
