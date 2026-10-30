/**
 * The alt-text save patches the saved row into the library cache; it does not
 * re-read the library.
 *
 * WHY THIS IS A TEST OF THE CACHE, OVER THE REAL TANSTACK QUERY. Invalidating
 * an ACTIVE infinite query re-requests every page the reader has loaded, one
 * after another, because page N+1's cursor comes from page N. For an upload or
 * a delete that is the price of staying correct: the page boundaries move, and
 * an asset `before` cursor 400s on a row that is no longer live. Alt text moves
 * nothing. The list is filtered, searched and sorted on columns other than
 * `alt_text`, and the PATCH answers the refreshed row, version included. So a
 * save needs no request at all, and the row under the operator's sheet must
 * carry the NEW version, or their next write from the grid would 412.
 *
 * The global react-query mock never runs `onSuccess`, so this file swaps in the
 * real library by relative path. `jest.requireActual("@tanstack/react-query")`
 * would go through the moduleNameMapper and hand back the mock again (see
 * commerce-connection-invalidation.native.test.tsx).
 *
 * The two controls keep the harness honest: a null answer (nothing to patch
 * with) and a delete must both still re-read every page. Without them, a probe
 * that simply could not see refetches would pass the first test.
 *
 * A READ ALREADY IN FLIGHT is the one place a patch alone is wrong. It took its
 * pages before the write (a next-page load even rebuilds from the very pages it
 * started with), so when it lands it writes the old row back over the patch.
 * The save must cancel and restart it, as the blanket invalidation always did.
 * The three race cases below make page reads take the server's rows at CALL
 * time, so a read started before the write answers from before it.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import React from "react";

import {
  assetLibraryQueryKey,
  useAssetDetail,
  useAssetLibrary,
  useDeleteAsset,
  useUpdateAssetAltText,
  type AssetLibraryFilters,
} from "@/hooks/useAssets";
import type { AssetPage, MobileAsset } from "@/lib/assetLibrary";
import { assetLibraryQueryRootKey } from "@/lib/detailSeedKeys";

// Both mocks are hoisted above the imports; the transport stubs read the
// `mock*` functions lazily, at call time.
jest.mock("@tanstack/react-query", () =>
  jest.requireActual("../node_modules/@tanstack/react-query"),
);

const mockFetchAssetPage = jest.fn();
const mockFetchAssetDetail = jest.fn();
const mockUpdateAssetAltText = jest.fn();
const mockDeleteAsset = jest.fn();
jest.mock("@/api/assets", () => ({
  fetchAssetPage: (...args: unknown[]) => mockFetchAssetPage(...args),
  fetchAssetDetail: (...args: unknown[]) => mockFetchAssetDetail(...args),
  updateAssetAltText: (...args: unknown[]) => mockUpdateAssetAltText(...args),
  deleteAsset: (...args: unknown[]) => mockDeleteAsset(...args),
  fetchAssetFolders: jest.fn(async () => []),
  fetchAssetTags: jest.fn(async () => []),
  uploadAsset: jest.fn(async () => null),
}));

const rq = jest.requireActual(
  "../node_modules/@tanstack/react-query",
) as typeof import("@tanstack/react-query");

/** The tenant the routes config's open online gate answers. */
const TENANT = "11111111-1111-4111-8111-111111111111";
const FILTERS: AssetLibraryFilters = {
  query: "",
  filter: "all",
  folderId: null,
  tag: null,
  sort: "newest",
};
const PAGE = 30;
const PAGES = 5;
const EDITED_ID = "a140"; // on page 5
const FIRST_PAGE_ID = "a10"; // on page 1, which a refetch reads first
const ALT = "A rocket over the launch banner";

/**
 * What the server has changed since the fixtures were drawn. Every read takes
 * the rows as they are when it is CALLED, so a read started before a write
 * answers from before it, however late it lands.
 */
const serverEdits = new Map<string, Partial<MobileAsset>>();

function asset(n: number): MobileAsset {
  const id = `a${n}`;
  return {
    id,
    filename: `image-${n}.png`,
    mime: "image/png",
    bytes: 1024,
    width: 640,
    height: 480,
    url: `https://cdn.postwave.test/a${n}.png`,
    createdAt: "2026-09-01T00:00:00Z",
    altText: "",
    referencesCount: 0,
    lastUsedAt: null,
    folderId: null,
    version: 3,
    ...serverEdits.get(id),
  };
}

/** The server's row for each listed row, as the server holds it now. */
function serverRowsFor(listed: MobileAsset[]): MobileAsset[] {
  return listed.map((row) => asset(Number(row.id.slice(1))));
}

/** `before` is the last id of the previous page, exactly as the server pages. */
function page(before: string | null): AssetPage {
  const start = before === null ? 0 : Number(before.slice(1));
  const items = Array.from({ length: PAGE }, (_, i) => asset(start + i + 1));
  return {
    items,
    counts: {
      all: PAGE * PAGES,
      recent: 0,
      inUse: 0,
      unused: PAGE * PAGES,
      large: 0,
    },
    nextCursor: start + PAGE < PAGE * PAGES ? `a${start + PAGE}` : null,
  };
}

function rows(data: unknown): MobileAsset[] {
  const pages = (data as { pages?: AssetPage[] } | undefined)?.pages ?? [];
  return pages.flatMap((p) => p.items);
}

/** Let any refetch the mutation started run to completion. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

let nowSpy: { mockRestore: () => void } | null = null;
const clients: InstanceType<typeof rq.QueryClient>[] = [];

/**
 * The library with `loaded` of its five pages read, and the detail sheet open
 * over a140. `queries` overrides the client's query defaults (the paused case
 * needs a retry to pause on).
 */
async function mountWithPages(
  loaded: number,
  queries: { retry?: number; retryDelay?: number } = {},
) {
  mockFetchAssetPage.mockImplementation(async (input: unknown) =>
    page((input as { before?: string | null }).before ?? null),
  );
  mockFetchAssetDetail.mockImplementation(async (id: unknown) => ({
    asset: asset(Number(String(id).slice(1))),
    usage: [],
  }));
  // No garbage-collection timers: a 5-minute gc timer on an unobserved entry
  // would hold the jest process open long after the suite has finished.
  const client = new rq.QueryClient({
    defaultOptions: {
      queries: { retry: 0, gcTime: Infinity, ...queries },
      mutations: { retry: 0, gcTime: Infinity },
    },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(rq.QueryClientProvider, { client }, children);
  const { result } = await renderHook(
    () => ({
      library: useAssetLibrary(FILTERS),
      detail: useAssetDetail(EDITED_ID),
      altText: useUpdateAssetAltText(),
      remove: useDeleteAsset(),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(result.current.library.data?.pages).toHaveLength(1),
  );
  await waitFor(() =>
    expect(result.current.detail.data?.asset?.id).toBe(EDITED_ID),
  );
  for (let i = 1; i < loaded; i += 1) {
    await act(async () => {
      await result.current.library.fetchNextPage();
    });
  }
  await waitFor(() =>
    expect(rows(result.current.library.data)).toHaveLength(PAGE * loaded),
  );
  expect(result.current.library.hasNextPage).toBe(loaded < PAGES);
  mockFetchAssetPage.mockClear();
  mockFetchAssetDetail.mockClear();
  return { client, result, key: assetLibraryQueryKey(TENANT, FILTERS) };
}

/** The library scrolled to its end, with the detail sheet open over a140. */
function mountWithFivePages() {
  return mountWithPages(PAGES);
}

/** The PATCH as the server runs it: the row moves on, and the answer IS it. */
function patchOnServer(id: string, altText: string) {
  mockUpdateAssetAltText.mockImplementation(async () => {
    const n = Number(id.slice(1));
    serverEdits.set(id, { altText, version: (asset(n).version ?? 0) + 1 });
    return asset(n);
  });
}

/**
 * From now on a page read takes the server's rows when it is called, but
 * answers only once the returned `release` runs: a read on a slow network.
 */
function holdPageReads(): () => void {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetchAssetPage.mockImplementation(async (input: unknown) => {
    const read = page((input as { before?: string | null }).before ?? null);
    await gate;
    return read;
  });
  return release;
}

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  rq.focusManager.setFocused(undefined);
  serverEdits.clear();
  for (const client of clients.splice(0)) client.clear();
  mockFetchAssetPage.mockReset();
  mockFetchAssetDetail.mockReset();
  mockUpdateAssetAltText.mockReset();
  mockDeleteAsset.mockReset();
});

describe("asset alt-text save and the library cache", () => {
  it("patches the saved row, version included, without re-reading a single page", async () => {
    const { client, result, key } = await mountWithFivePages();
    const loadedAt = client.getQueryState(key)?.dataUpdatedAt ?? 0;
    expect(loadedAt).toBeGreaterThan(0);
    // Another cached sort that also holds the row, and a filter that does not.
    const oldestKey = assetLibraryQueryKey(TENANT, {
      ...FILTERS,
      sort: "oldest",
    });
    const largeKey = assetLibraryQueryKey(TENANT, {
      ...FILTERS,
      filter: "large",
    });
    const oldest = {
      pages: [{ ...page(null), items: [asset(140), asset(1)] }],
      pageParams: [null],
    };
    const large = {
      pages: [{ ...page(null), items: [asset(7)] }],
      pageParams: [null],
    };
    client.setQueryData(oldestKey, oldest, { updatedAt: loadedAt - 5_000 });
    client.setQueryData(largeKey, large, { updatedAt: loadedAt - 5_000 });
    const pagesBefore = (client.getQueryData(key) as { pages: AssetPage[] })
      .pages;

    // A minute later, well inside the two-minute stale window.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(loadedAt + 60_000);
    mockUpdateAssetAltText.mockImplementation(async () => ({
      ...asset(140),
      altText: "A rocket over the launch banner",
      version: 4,
    }));
    await act(async () => {
      await result.current.altText.mutateAsync({
        id: EDITED_ID,
        altText: "A rocket over the launch banner",
        expectedVersion: 3,
      });
    });
    await settle();

    expect(mockUpdateAssetAltText).toHaveBeenCalledWith(
      EDITED_ID,
      "A rocket over the launch banner",
      3,
    );
    expect(mockFetchAssetPage).toHaveBeenCalledTimes(0);
    // The one read the save does cost: the detail behind the open sheet.
    expect(mockFetchAssetDetail.mock.calls).toEqual([[EDITED_ID]]);

    const listed = rows(result.current.library.data);
    expect(listed).toHaveLength(PAGE * PAGES);
    const edited = listed.find((row) => row.id === EDITED_ID);
    expect(edited).toMatchObject({
      altText: "A rocket over the launch banner",
      version: 4,
    });
    // Every other row is exactly what the server last said, and the four pages
    // that do not hold the row are the very same objects (their tiles do not
    // re-render).
    expect(
      listed.filter((row) => row.altText !== "").map((row) => row.id),
    ).toEqual([EDITED_ID]);
    const pagesAfter = (client.getQueryData(key) as { pages: AssetPage[] })
      .pages;
    expect(pagesAfter).toHaveLength(PAGES);
    pagesAfter.slice(0, 4).forEach((p, i) => expect(p).toBe(pagesBefore[i]));
    expect(pagesAfter[4]).not.toBe(pagesBefore[4]);
    // Neither re-stamped fresh nor marked for a refetch.
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(loadedAt);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);

    // The other sort holding the row carries the new version too, at its own age.
    expect(
      rows(client.getQueryData(oldestKey)).find((row) => row.id === EDITED_ID),
    ).toMatchObject({
      altText: "A rocket over the launch banner",
      version: 4,
    });
    expect(client.getQueryState(oldestKey)?.dataUpdatedAt).toBe(
      loadedAt - 5_000,
    );
    // A variant without the row is not written at all.
    expect(client.getQueryData(largeKey)).toBe(large);
    expect(client.getQueryState(largeKey)?.dataUpdatedAt).toBe(
      loadedAt - 5_000,
    );
    expect(client.getQueryState(largeKey)?.dataUpdateCount).toBe(1);
  });

  it("control: an unreadable answer has nothing to patch with, so every page is re-read", async () => {
    const { result } = await mountWithFivePages();
    mockUpdateAssetAltText.mockImplementation(async () => null);
    await act(async () => {
      await result.current.altText.mutateAsync({
        id: EDITED_ID,
        altText: "A rocket over the launch banner",
        expectedVersion: 3,
      });
    });
    await waitFor(() =>
      expect(mockFetchAssetPage).toHaveBeenCalledTimes(PAGES),
    );
    await settle();
    expect(mockFetchAssetPage).toHaveBeenCalledTimes(PAGES);
    expect(rows(result.current.library.data)).toHaveLength(PAGE * PAGES);
  });

  it("control: a delete still re-reads every loaded page, because the boundaries moved", async () => {
    const { result } = await mountWithFivePages();
    mockDeleteAsset.mockImplementation(async () => undefined);
    await act(async () => {
      await result.current.remove.mutateAsync({
        id: EDITED_ID,
        expectedVersion: 3,
        force: false,
      });
    });
    await waitFor(() =>
      expect(mockFetchAssetPage).toHaveBeenCalledTimes(PAGES),
    );
    await settle();
    expect(mockDeleteAsset).toHaveBeenCalledWith(EDITED_ID, 3, false);
    expect(mockFetchAssetPage).toHaveBeenCalledTimes(PAGES);
  });

  it("restarts a library refetch already in flight, so the row ends on the answer's version", async () => {
    const { client, result, key } = await mountWithFivePages();
    // A focus or reconnect refetch has read page 1, with a10 at version 3, and
    // is still waiting on the network when the save's answer arrives.
    const release = holdPageReads();
    let refetching: Promise<unknown> = Promise.resolve();
    // Started, not awaited: the read stays held until `release()`.
    await act(async () => {
      refetching = result.current.library.refetch();
    });
    await waitFor(() => expect(mockFetchAssetPage).toHaveBeenCalledTimes(1));
    patchOnServer(FIRST_PAGE_ID, ALT);
    await act(async () => {
      await result.current.altText.mutateAsync({
        id: FIRST_PAGE_ID,
        altText: ALT,
        expectedVersion: 3,
      });
    });
    release();
    await act(async () => {
      await refetching.catch(() => undefined);
    });
    await settle();

    const listed = rows(client.getQueryData(key));
    expect(listed).toHaveLength(PAGE * PAGES);
    expect(listed.find((row) => row.id === FIRST_PAGE_ID)).toMatchObject({
      altText: ALT,
      version: 4,
    });
    expect(listed).toEqual(serverRowsFor(listed));
  });

  it("restarts a next-page load already in flight, which would land the pages it started from", async () => {
    const { client, result, key } = await mountWithPages(PAGES - 1);
    const release = holdPageReads();
    let loadingMore: Promise<unknown> = Promise.resolve();
    await act(async () => {
      loadingMore = result.current.library.fetchNextPage();
    });
    await waitFor(() => expect(mockFetchAssetPage).toHaveBeenCalledTimes(1));
    patchOnServer(FIRST_PAGE_ID, ALT);
    await act(async () => {
      await result.current.altText.mutateAsync({
        id: FIRST_PAGE_ID,
        altText: ALT,
        expectedVersion: 3,
      });
    });
    release();
    await act(async () => {
      await loadingMore.catch(() => undefined);
    });
    await settle();

    const listed = rows(client.getQueryData(key));
    expect(listed.find((row) => row.id === FIRST_PAGE_ID)).toMatchObject({
      altText: ALT,
      version: 4,
    });
    expect(listed).toEqual(serverRowsFor(listed));
  });

  it("restarts a next-page load PAUSED on a retry, which isFetching() does not count", async () => {
    const { client, result, key } = await mountWithPages(PAGES - 1, {
      retry: 1,
      retryDelay: 0,
    });
    // The app is in the background: page 5's read fails, and its retry waits
    // for the foreground, still holding the four pages it started from.
    rq.focusManager.setFocused(false);
    let failedOnce = false;
    mockFetchAssetPage.mockImplementation(async (input: unknown) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("network lost");
      }
      return page((input as { before?: string | null }).before ?? null);
    });
    await act(async () => {
      void result.current.library.fetchNextPage();
    });
    await waitFor(() =>
      expect(client.getQueryState(key)?.fetchStatus).toBe("paused"),
    );
    expect(
      client.isFetching({ queryKey: assetLibraryQueryRootKey(TENANT) }),
    ).toBe(0);

    patchOnServer(FIRST_PAGE_ID, ALT);
    await act(async () => {
      await result.current.altText.mutateAsync({
        id: FIRST_PAGE_ID,
        altText: ALT,
        expectedVersion: 3,
      });
    });
    await act(async () => {
      rq.focusManager.setFocused(true);
    });
    await settle();

    const listed = rows(client.getQueryData(key));
    expect(listed.find((row) => row.id === FIRST_PAGE_ID)).toMatchObject({
      altText: ALT,
      version: 4,
    });
    expect(listed).toEqual(serverRowsFor(listed));
  });
});
