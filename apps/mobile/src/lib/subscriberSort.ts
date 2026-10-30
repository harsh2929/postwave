/**
 * subscriberSort — the sort vocabulary for the subscribers list.
 *
 * The list was permanently pinned to the server default (updated_at desc)
 * even though `GET /api/v1/subscribers` has accepted `sort` + `order` all
 * along (apps/api/internal/subscribers/repo_helpers.go normalizeSort), each
 * backed by a real index. "Who joined most recently?" and "who is most at
 * risk?" were desktop-only questions.
 *
 * Every option below is in the server's allow-list. Anything else is
 * silently coerced to updated_at server-side, so the client must not invent
 * columns — an unknown key here would look like it worked and quietly
 * return default order.
 *
 * Pure and RN-free so the mapping is unit-testable.
 */

export type SubscriberSortOrder = "asc" | "desc";

export interface SubscriberSortOption {
  /** Stable preference key, persisted by useListPreferences. */
  key: string;
  label: string;
  /** Value for `?sort=` — must be in normalizeSort's allow-list. */
  sort: string;
  order: SubscriberSortOrder;
}

/**
 * Ordered for a phone: the two questions people actually open this screen
 * with come first, then the alphabetical/lifecycle ones.
 */
export const SUBSCRIBER_SORTS: readonly SubscriberSortOption[] = [
  { key: "updated", label: "Recently updated", sort: "updated_at", order: "desc" },
  { key: "joined", label: "Newest first", sort: "joined", order: "desc" },
  { key: "joined_asc", label: "Oldest first", sort: "joined", order: "asc" },
  { key: "email", label: "Email A–Z", sort: "email", order: "asc" },
  { key: "name", label: "Name A–Z", sort: "first_name", order: "asc" },
  {
    key: "engagement",
    label: "Most engaged",
    sort: "engagement",
    order: "desc",
  },
  { key: "churn", label: "Highest churn risk", sort: "churn", order: "desc" },
  { key: "rating", label: "Highest rated", sort: "rating", order: "desc" },
];

export const DEFAULT_SUBSCRIBER_SORT = SUBSCRIBER_SORTS[0]!;

/**
 * Resolve a stored preference. A key written by an older build (or a
 * hand-edited store) must never leave the screen sorting by a column the
 * server will reject or silently ignore.
 */
export function subscriberSortByKey(key: string): SubscriberSortOption {
  return (
    SUBSCRIBER_SORTS.find((s) => s.key === key) ?? DEFAULT_SUBSCRIBER_SORT
  );
}

/** What the trigger button shows, and what VoiceOver says for it. */
export function subscriberSortAccessibilityLabel(key: string): string {
  return `Sort order: ${subscriberSortByKey(key).label}. Opens the sort options`;
}

/**
 * The query-key segment that distinguishes one ordering from another. Two
 * orderings are two different result sequences, so they must not share an
 * infinite-query cache entry — pages from different sorts would interleave.
 */
export function subscriberSortToken(
  sort: { sort: string; order: string } | undefined,
): string {
  return sort ? `${sort.sort}:${sort.order}` : "default";
}
