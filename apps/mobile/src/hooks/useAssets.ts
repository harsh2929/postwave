/**
 * hooks/useAssets.ts — the asset library read, its two facet reads, the single
 * read behind the detail sheet, and the two verbs.
 *
 * THE GATE. Every query uses `useOnlineQueryGate` with
 * `enabled: gate.enabled && Boolean(gate.tenantId)`, the app-wide contract
 * enforced by hooks/online-query-gating.test.ts. A disabled TanStack query
 * reports `data: undefined, isLoading: false, isError: false`, so without the
 * gate term this screen would render "No images yet" — a confident claim about
 * a workspace's library — for a request that was never made.
 *
 * WHY THE LIBRARY IS AN INFINITE QUERY AND THE FACETS ARE NOT. `List` pages on
 * a `before` cursor and reports the next one in `nextCursor`, so the grid
 * genuinely appends. `ListFolders` and `ListTenantTagsWithCounts` are single
 * grouped reads capped server-side at 500 / 200 rows respectively — they do not
 * page, and (importantly) they are NOT narrowed by the active filters, so the
 * chip rails stay stable while you filter. Keeping them as their own queries is
 * what lets a rail survive a filter that empties the grid: you can still back
 * out of the selection that emptied it.
 *
 * BOTH VERBS ARE ONLINE-ONLY, AND NOT BY A NEW DECISION. The offline queue's
 * policy already says so, twice over (lib/offlineQueueSafety.ts):
 * `/^DELETE /` is in ONLINE_ONLY_PATTERNS, which wins over everything, and
 * `POST /api/v1/assets` is absent from SAFE_MUTATION_PATTERNS so it fails the
 * allowlist. Neither uses OFFLINE_MUTATION_KEYS.entityWrite, so
 * lib/offlineMutations never sees them. There is also a hard physical reason
 * for the upload: the paused-mutation journal is persisted through
 * lib/secureQueryPersister into the Keychain in 1.8 KB chunks with a 72 KB
 * ceiling — a 10 MiB image is ~13.4 MiB of base64, about 190× the entire
 * budget for everything the app has queued. The screen therefore HIDES the
 * upload affordance offline rather than offering a button that would fail.
 *
 * WHAT THE INVALIDATIONS ARE FOR. An upload adds a row AND shifts `counts.all`
 * / `counts.recent`; a delete removes one and can shift four of the five
 * counts. Both are refetched rather than patched, because `counts` describes
 * the whole tenant set and cannot be recomputed client-side from one page, and
 * because the page boundaries move (a `before` cursor must be a live row).
 * Refetching an active infinite query re-reads every loaded page in series,
 * and for these two writes that is the price of staying correct.
 *
 * The alt-text save is the exception: it PATCHES the row in place instead.
 * Alt text moves no row, no filter and no count (the list filters, searches
 * and sorts on other columns), and the response is the refreshed row, version
 * included, so there is nothing a re-read could learn. Only a library read
 * already in flight when the answer lands is restarted, because it read from
 * before the write (see useUpdateAssetAltText).
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  deleteAsset,
  fetchAssetDetail,
  fetchAssetFolders,
  fetchAssetPage,
  fetchAssetTags,
  updateAssetAltText,
  uploadAsset,
  type AssetUploadInput,
} from "@/api/assets";
import { assetLibraryQueryRootKey } from "@/lib/detailSeedKeys";
import { rewriteQueriesKeepingFreshness } from "@/lib/infiniteQueryRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  AssetDetail,
  AssetFolder,
  AssetPage,
  AssetTagCount,
  MobileAsset,
} from "@/lib/assetLibrary";

const LIBRARY_KEY = "assets";
const FOLDERS_KEY = "asset-folders";
const TAGS_KEY = "asset-tags";
const DETAIL_KEY = "asset";

/**
 * A media library changes when someone uploads on a laptop, not on the
 * timescale of a send. Two minutes keeps a tab-switch instant without showing
 * an image that a teammate deleted this morning.
 */
const LIBRARY_STALE_MS = 2 * 60_000;

/** Folders and tags change even more rarely than the assets inside them. */
const FACET_STALE_MS = 5 * 60_000;

export interface AssetLibraryFilters {
  query: string;
  filter: string;
  folderId: string | null;
  tag: string | null;
  /** One of ASSET_SORTS (lib/assetLibrary). "newest" is the server default. */
  sort: string;
}

export function assetLibraryQueryKey(
  tenantId: string | null | undefined,
  filters: AssetLibraryFilters,
): readonly unknown[] {
  return [
    ...assetLibraryQueryRootKey(tenantId),
    filters.query,
    filters.filter,
    filters.folderId ?? "any",
    filters.tag ?? "any",
    filters.sort,
  ];
}

export function useAssetLibrary(filters: AssetLibraryFilters) {
  const gate = useOnlineQueryGate();
  const query = filters.query.trim();
  return useInfiniteQuery({
    queryKey: assetLibraryQueryKey(gate.tenantId, { ...filters, query }),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: LIBRARY_STALE_MS,
    // The first page sends no cursor at all; `before` is only ever an id the
    // server handed back, because `ListPageWithCounts` 400s on a cursor that
    // is not a live row in this tenant.
    initialPageParam: null as string | null,
    getNextPageParam: (last: AssetPage) => last.nextCursor,
    queryFn: ({ pageParam }): Promise<AssetPage> =>
      fetchAssetPage({
        query,
        filter: filters.filter,
        folderId: filters.folderId,
        tag: filters.tag,
        sort: filters.sort,
        before: typeof pageParam === "string" ? pageParam : null,
      }),
  });
}

export function useAssetFolders() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [FOLDERS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: FACET_STALE_MS,
    queryFn: (): Promise<AssetFolder[]> => fetchAssetFolders(),
  });
}

export function useAssetTags() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [TAGS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: FACET_STALE_MS,
    queryFn: (): Promise<AssetTagCount[]> => fetchAssetTags(),
  });
}

/**
 * The detail read. `staleTime: 0` because it is opened immediately before a
 * decision to delete, and because its `usage` array is the only recomputed —
 * rather than periodically refreshed — answer to "would this break a live
 * draft".
 */
export function useAssetDetail(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [DETAIL_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<AssetDetail> => fetchAssetDetail(id!),
  });
}

export function useUploadAsset() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<MobileAsset | null, Error, AssetUploadInput>({
    mutationFn: (input) => uploadAsset(input),
    onSuccess: () => {
      // Every page of the grid is now short by one row, and `counts.all` /
      // `counts.recent` have both moved.
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY, gate.tenantId] });
    },
  });
}

/**
 * `data` with `row` swapped in for the first item carrying its id, in every
 * page that holds one (ids are unique within a server page), or `undefined`
 * when `data` is not a library envelope holding that id, so the caller leaves
 * that cache entry unwritten. Only a page holding the row gets a new `items`
 * array; every other page keeps its reference.
 */
function withAssetRow(data: unknown, row: MobileAsset): unknown {
  const pages: unknown = (data as { pages?: unknown } | null | undefined)
    ?.pages;
  if (!Array.isArray(pages)) return undefined;
  let found = false;
  const next = pages.map((page: unknown) => {
    const items: unknown = (page as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return page;
    const at = items.findIndex(
      (item: unknown) => (item as { id?: unknown } | null)?.id === row.id,
    );
    if (at < 0) return page;
    found = true;
    const patched: unknown[] = items.map((item: unknown, i) =>
      i === at ? row : item,
    );
    return { ...(page as object), items: patched };
  });
  return found ? { ...(data as object), pages: next } : undefined;
}

/**
 * The alt-text edit. Online-only (never queued — see api/assets.ts), and NOT
 * optimistic: unlike a favourite star, the field's whole value is that it is
 * TRUE of the stored row, and a rollback would silently revert a sentence the
 * operator watched themselves save.
 *
 * The response is the refreshed row, so success PATCHES it into every cached
 * library variant that holds it (tiles read `altText` for their accessibility
 * label) rather than invalidating the library. Alt text moves no row, filter
 * or count, so a re-read would request every loaded page in series (five on a
 * 150-image library) to learn nothing. The patch keeps each entry's age and
 * carries the row's NEW version, which the next alt-text or delete from the
 * grid row sends as its `expected_version`; a tile left on the old number
 * would 412.
 *
 * Two cases still re-read. An unparseable answer (null) has nothing to patch
 * with, so the whole library is invalidated as before. And a library read
 * already in flight when the answer lands, whether fetching or paused on a
 * retry (`isFetching()` counts only the first), took its pages before the
 * write: a refetch re-read the row's page early, and a next-page load rebuilds
 * from the very pages it started with. Either would write the old row and
 * version back over the patch, so each such entry is invalidated, which
 * cancels and restarts it. The detail read behind the sheet is always
 * invalidated.
 *
 * `expectedVersion` is the row's optimistic-concurrency token and the server
 * refuses the write without it (428 `expected_version_required`). It is
 * REQUIRED here even though the transport types it optional, so a caller
 * cannot reach the doomed path by forgetting an argument.
 */
export function useUpdateAssetAltText() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<
    MobileAsset | null,
    Error,
    { id: string; altText: string; expectedVersion: number }
  >(
    {
      mutationFn: ({ id, altText, expectedVersion }) =>
        updateAssetAltText(id, altText, expectedVersion),
      onSuccess: (row, variables) => {
        if (row) {
          const libraryRoot = assetLibraryQueryRootKey(gate.tenantId);
          rewriteQueriesKeepingFreshness(qc, libraryRoot, (data) =>
            withAssetRow(data, row),
          );
          // A read still in flight (fetching, or paused on a retry) took its
          // pages before the write and would land them over the patch.
          // Invalidating it cancels and restarts it.
          void qc.invalidateQueries({
            queryKey: libraryRoot,
            predicate: (query) => query.state.fetchStatus !== "idle",
          });
        } else {
          void qc.invalidateQueries({
            queryKey: [LIBRARY_KEY, gate.tenantId],
          });
        }
        void qc.invalidateQueries({
          queryKey: [DETAIL_KEY, gate.tenantId, variables.id],
        });
      },
    },
  );
}

export interface AssetDeleteInput {
  id: string;
  /**
   * The row's optimistic-concurrency version, read off the asset — never
   * guessed. `DELETE /assets/{id}` reads it from the BODY and answers 428
   * `expected_version_required` without a positive one (handlers.go:554), so
   * mobile's old `?force=true`-and-no-body delete could not once have worked.
   * REQUIRED here even though the transport types it optional, so a caller
   * cannot reach the doomed path by forgetting an argument; the screen
   * withholds the affordance when the row carries no version.
   */
  expectedVersion: number;
  /** True only after an explicit typed-phrase confirm over live referrers. */
  force: boolean;
}

export function useDeleteAsset() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, AssetDeleteInput>({
    mutationFn: ({ id, expectedVersion, force }) =>
      deleteAsset(id, expectedVersion, force),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY, gate.tenantId] });
      // The folder rail carries per-folder asset counts, so a delete moves it.
      void qc.invalidateQueries({ queryKey: [FOLDERS_KEY, gate.tenantId] });
      void qc.invalidateQueries({
        queryKey: [DETAIL_KEY, gate.tenantId, variables.id],
      });
    },
  });
}
