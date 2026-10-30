/**
 * subscriberListSnapshot — the cold-offline projection of the subscribers
 * LIST.
 *
 * The asymmetry this fixes: `useSubscriber` (the detail) has always been
 * offline-capable through `loadOfflineCapableSnapshot` + the secure vault, so
 * a previously-opened profile survives a flight. But the LIST that leads to
 * those profiles was a plain gated query, and `shouldPersistQuery` returns
 * false for it — so offline there was no list, and therefore no route to the
 * snapshots that did exist. A cache nobody can reach is not a cache.
 *
 * THREE RULES, all of which are about not lying:
 *
 *  1. ONLY THE DEFAULT VIEW IS SNAPSHOTTED — no search term, no status
 *     filter, page 1, default order. A snapshot keyed by "the last thing you
 *     looked at" would answer a *different* question than the one the chips
 *     currently say is active. Everything else stays online-only and says so.
 *
 *  2. IT IS MINIMISED, NOT MIRRORED. Only the fields the row renders are
 *     kept. The vault's per-key ceiling is 24KB and a raw page of 25
 *     subscribers (custom fields, merge fields, consent columns, activity
 *     summaries) blows straight past it — a snapshot that silently fails to
 *     write is worse than none. Minimising is also the right privacy call for
 *     a device projection.
 *
 *  3. IT IS PAGE ONE AND ONLY PAGE ONE. `hasMore` is carried so the offline
 *     screen can say "this is the first page, saved <when>" rather than
 *     presenting 25 rows as the workspace.
 *
 * Import-free so all of it is unit-testable.
 */

/** The row fields the list actually renders. Everything else is dropped. */
export interface SnapshotRow {
  id?: string;
  email: string;
  status?: string;
  tags?: string[];
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  engagement_score?: number | null;
  churn_score?: number | null;
  rating?: number | null;
}

export interface SubscriberListSnapshot {
  items: SnapshotRow[];
  /** The server's total for the unfiltered list, when it sent one. */
  total?: number;
  /** Epoch ms the projection was captured. Drives the staleness line. */
  capturedAt: number;
  /** True when the server said more pages exist beyond this one. */
  hasMore: boolean;
}

/** Rows kept in one snapshot — one page, matching the query's per_page. */
export const SNAPSHOT_MAX_ROWS = 25;
/** Tags kept per row — the row renders at most three. */
const SNAPSHOT_MAX_TAGS = 3;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * True when this query is the one view a snapshot can honestly answer.
 * `sortToken` is compared against the default rather than parsed: any
 * non-default ordering is a different sequence of rows.
 */
export function isSnapshotableView(input: {
  query: string | undefined;
  status: string | undefined;
  sortToken: string;
  defaultSortToken: string;
  page: number;
}): boolean {
  return (
    !(input.query ?? "").trim() &&
    !input.status &&
    input.sortToken === input.defaultSortToken &&
    input.page === 1
  );
}

/**
 * Reduce a live page to the projection. Returns null when the payload is not
 * a page at all — writing an empty snapshot over a good one would turn a
 * transient bad response into a permanently empty offline list.
 */
export function projectSubscriberListSnapshot(
  page: unknown,
  now: number,
): SubscriberListSnapshot | null {
  if (!page || typeof page !== "object") return null;
  const raw = page as { items?: unknown; total?: unknown };
  if (!Array.isArray(raw.items)) return null;

  const items: SnapshotRow[] = [];
  for (const entry of raw.items.slice(0, SNAPSHOT_MAX_ROWS)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const email = optionalString(row.email);
    // A row with no address cannot be rendered or routed to.
    if (!email) continue;
    const tags = Array.isArray(row.tags)
      ? row.tags
          .filter((t): t is string => typeof t === "string" && Boolean(t))
          .slice(0, SNAPSHOT_MAX_TAGS)
      : undefined;
    const id = optionalString(row.id) ?? optionalNumberAsString(row.id);
    // exactOptionalPropertyTypes: every optional key is SPREAD in only once a
    // value exists, so an absent measurement is an absent key — never an
    // explicit `undefined`, and never a zero.
    const projected: SnapshotRow = { email };
    if (id) projected.id = id;
    const status = optionalString(row.status);
    if (status) projected.status = status;
    if (tags && tags.length > 0) projected.tags = tags;
    const first = optionalString(row.first_name);
    if (first) projected.first_name = first;
    const last = optionalString(row.last_name);
    if (last) projected.last_name = last;
    const full = optionalString(row.full_name);
    if (full) projected.full_name = full;
    const display = optionalString(row.display_name);
    if (display) projected.display_name = display;
    const engagement = optionalNumber(row.engagement_score);
    if (engagement != null) projected.engagement_score = engagement;
    const churn = optionalNumber(row.churn_score);
    if (churn != null) projected.churn_score = churn;
    const rating = optionalNumber(row.rating);
    if (rating != null) projected.rating = rating;
    items.push(projected);
  }

  const total = optionalNumber(raw.total);
  return {
    items,
    ...(total == null ? {} : { total }),
    capturedAt: now,
    hasMore: total == null ? false : total > items.length,
  };
}

function optionalNumberAsString(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/**
 * Turn a stored snapshot back into the page shape the list consumes. The
 * `total` is deliberately NOT synthesised from `items.length` when the
 * snapshot never carried one — a missing measurement stays missing, and the
 * count line renders "N loaded" instead of claiming a workspace size.
 */
export function snapshotAsPage(snapshot: SubscriberListSnapshot): {
  items: SnapshotRow[];
  total?: number;
  page: number;
} {
  return {
    items: snapshot.items,
    ...(typeof snapshot.total === "number" ? { total: snapshot.total } : {}),
    page: 1,
  };
}

/** The sentence shown when an offline view has no snapshot to fall back on. */
export const SUBSCRIBER_LIST_OFFLINE_MESSAGE =
  "You're offline. Only the unfiltered first page is saved for offline use — searches, filters and other sort orders need a connection.";
