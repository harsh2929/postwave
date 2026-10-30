import type { SnapshotBacked } from "./deliverabilitySnapshotKeys";

export interface SuppressionRow {
  id: string;
  email: string;
  reason?: string;
  status?: string;
  created_at?: string;
}

export interface SuppressionPage {
  items: SuppressionRow[];
  total: number;
  page: number;
  size: number;
}

/**
 * The server clamps `size` to 200 and defaults it to 50
 * (apps/api/internal/suppressions/store.go ListPagedFiltered).
 */
export const SUPPRESSION_PAGE_SIZE = 50;

/**
 * How far "Load more" walks before it stops offering itself.
 *
 * Paging is LIMIT/OFFSET over a table that can hold hundreds of thousands of
 * rows; a control that promises to reach the end of that by tapping is a
 * promise a phone cannot keep. 20 pages is ~1,000 rows — deep enough to browse
 * a bounce spike — and past it the footer keeps saying what it always said:
 * search by address to reach the rest.
 */
export const SUPPRESSION_MAX_PAGES = 20;

/** One page as the snapshot layer hands it back (value + provenance). */
export type SuppressionPageBacking = SnapshotBacked<SuppressionPage>;

export function normalizeSuppressionPage(value: unknown): SuppressionPage {
  if (Array.isArray(value)) {
    return {
      items: value as SuppressionRow[],
      total: value.length,
      page: 1,
      size: value.length,
    };
  }
  const raw = (value ?? {}) as {
    items?: SuppressionRow[];
    total?: number;
    page?: number;
    size?: number;
  };
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    items,
    total: typeof raw.total === "number" ? raw.total : items.length,
    page: typeof raw.page === "number" && raw.page > 0 ? raw.page : 1,
    size:
      typeof raw.size === "number" && raw.size > 0 ? raw.size : items.length,
  };
}

/**
 * Flatten the pages of the paged list read into the single envelope every
 * consumer already renders.
 *
 * Why dedupe: the server orders by `created_at DESC` over a LIMIT/OFFSET
 * window (apps/api/internal/suppressions/store.go ListPagedFiltered), so a
 * suppression added between two "Load more" taps shifts every later row down
 * by one and the next page repeats the row that straddled the boundary. First
 * occurrence wins, keyed by id and falling back to the address — the converged
 * list can hold legacy rows with no id, which is why `useSuppressionSelection`
 * addresses rows by email too.
 *
 * `total` is the server's count for the CURRENT filter and is taken from the
 * NEWEST page, but never allowed below what we are actually showing: a total
 * smaller than the rendered row count would make `suppressionPageScopeNote`
 * claim there is nothing more to load while rows are still on screen.
 *
 * `fromSnapshot` / `capturedAt` come from the FIRST page because that is the
 * only page the vault can answer — later pages are live-only reads.
 */
export function mergeSuppressionPages(
  pages: readonly SuppressionPageBacking[] | undefined,
): SuppressionPageBacking | undefined {
  if (!pages || pages.length === 0) return undefined;
  const seen = new Set<string>();
  const items: SuppressionRow[] = [];
  for (const page of pages) {
    const rows = Array.isArray(page?.value?.items) ? page.value.items : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const key = (row.id || row.email || "").trim().toLowerCase();
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push(row);
    }
  }
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  const declared =
    typeof last?.value?.total === "number" && Number.isFinite(last.value.total)
      ? last.value.total
      : items.length;
  return {
    value: {
      items,
      total: Math.max(declared, items.length),
      // The merged view is not a page: it starts at the first one and is as
      // long as what has been loaded.
      page: 1,
      size: items.length,
    },
    fromSnapshot: Boolean(first?.fromSnapshot),
    capturedAt: first?.capturedAt ?? null,
  };
}

/**
 * Whether another page exists, and which one — the `getNextPageParam` of the
 * paged list read, kept pure so its three stopping conditions are testable.
 *
 * It stops when:
 *  - the page came from the offline vault. The vault holds ONE projection, of
 *    page 1; offering "Load more" over it would either hand the same rows back
 *    as page 2 or issue a request that cannot succeed.
 *  - the page was SHORT. A page under `SUPPRESSION_PAGE_SIZE` is the end of
 *    the result set. Trusting `total` alone keeps asking the server for pages
 *    it has already run out of when a row is deleted mid-browse.
 *  - `SUPPRESSION_MAX_PAGES` have been loaded, or `total` has been reached.
 */
export function nextSuppressionPageParam(
  lastPage: SuppressionPageBacking | undefined,
  allPages: readonly (SuppressionPageBacking | undefined)[],
): number | undefined {
  if (!lastPage) return undefined;
  if (lastPage.fromSnapshot) return undefined;
  const rows = Array.isArray(lastPage.value?.items)
    ? lastPage.value.items.length
    : 0;
  if (rows < SUPPRESSION_PAGE_SIZE) return undefined;
  if (allPages.length >= SUPPRESSION_MAX_PAGES) return undefined;
  const loaded = allPages.reduce(
    (sum, page) =>
      sum + (Array.isArray(page?.value?.items) ? page.value.items.length : 0),
    0,
  );
  const total =
    typeof lastPage.value?.total === "number" ? lastPage.value.total : 0;
  if (loaded >= total) return undefined;
  return allPages.length + 1;
}
