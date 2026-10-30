/**
 * The guard for lib/infiniteQueryRefresh.
 *
 * The op-count assertions run against a REAL QueryClient + a real
 * InfiniteQueryObserver rather than a fake, because the thing being guarded is
 * TanStack's own behaviour ("refetch re-requests every loaded page"), not our
 * model of it. Counting queryFn invocations asserts the SHAPE — how many round
 * trips the gesture costs — which is what regresses, rather than wall-clock,
 * which flakes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";

import {
  collapseInfiniteQueriesToFirstPage,
  firstPageOf,
  isMultiPageInfiniteData,
  refreshFirstPageOnly,
} from "./infiniteQueryRefresh";

describe("isMultiPageInfiniteData", () => {
  it("is false for a single-page infinite entry (already one request)", () => {
    expect(isMultiPageInfiniteData({ pages: [[1]], pageParams: [1] })).toBe(
      false,
    );
  });

  it("is true only once a second page is loaded", () => {
    expect(
      isMultiPageInfiniteData({ pages: [[1], [2]], pageParams: [1, 2] }),
    ).toBe(true);
  });

  it("is false for a plain (non-infinite) cache entry caught by the prefix", () => {
    expect(isMultiPageInfiniteData({ rows: [1, 2, 3] })).toBe(false);
    expect(isMultiPageInfiniteData([1, 2, 3])).toBe(false);
    expect(isMultiPageInfiniteData(undefined)).toBe(false);
    expect(isMultiPageInfiniteData(null)).toBe(false);
  });

  it("is false when `pages` is present but not an array", () => {
    // A restored/garbled entry must not throw inside TanStack's own updater.
    expect(isMultiPageInfiniteData({ pages: 3, pageParams: [1] })).toBe(false);
  });
});

describe("firstPageOf", () => {
  it("returns the SAME reference when there is nothing to trim", () => {
    const single = { pages: [[1]], pageParams: [1] };
    expect(firstPageOf(single)).toBe(single);
    const plain = { rows: [1] };
    expect(firstPageOf(plain)).toBe(plain);
  });

  it("keeps page 1 and its param, and drops the rest", () => {
    const out = firstPageOf({ pages: [["a"], ["b"], ["c"]], pageParams: [1, 2, 3] });
    expect(out).toEqual({ pages: [["a"]], pageParams: [1] });
  });
});

describe("collapseInfiniteQueriesToFirstPage", () => {
  it("reports how many entries it collapsed, so a drifted prefix is visible", () => {
    const client = new QueryClient();
    client.setQueryData(["campaigns", "t1", "paged", ""], {
      pages: [["a"], ["b"], ["c"]],
      pageParams: [1, 2, 3],
    });
    client.setQueryData(["campaigns", "t1"], [{ id: "x" }]);
    expect(
      collapseInfiniteQueriesToFirstPage(client, ["campaigns", "t1"]),
    ).toBe(1);
    expect(
      client.getQueryData(["campaigns", "t1", "paged", ""]),
    ).toEqual({ pages: [["a"]], pageParams: [1] });
    // The plain list entry under the same prefix is untouched.
    expect(client.getQueryData(["campaigns", "t1"])).toEqual([{ id: "x" }]);
    client.clear();
  });

  it("returns 0 — not a throw — when the prefix matches nothing", () => {
    const client = new QueryClient();
    expect(collapseInfiniteQueriesToFirstPage(client, ["nope"])).toBe(0);
    client.clear();
  });

  // PERF-2. The collapse used to write through `setQueriesData`, and TanStack
  // treats ANY value an updater returns — the same reference included — as a
  // fresh manual write: `dataUpdatedAt` re-stamped to now, the error cleared,
  // the invalidation cleared. The plain `["campaigns", t]` list sits exactly on
  // the prefix, so every pull on Campaigns declared it fresh. `getQueryData`
  // cannot see any of that, so these read the entry's STATE and count what the
  // next mount requests.
  it("leaves an entry it does not collapse exactly as it was: age, invalidation, error", async () => {
    const client = appLikeClient();
    const listKey = ["campaigns", "t1"];
    const summaryKey = ["campaigns", "t1", "summary"];
    const listAt = Date.now() - 90_000;
    client.setQueryData(listKey, [{ id: "x" }], { updatedAt: listAt });
    // A delete elsewhere marked it stale without refetching it (off screen).
    await client.invalidateQueries({
      queryKey: listKey,
      exact: true,
      refetchType: "none",
    });
    // A sibling whose last refresh failed keeps its rows AND its error banner.
    client.setQueryData(summaryKey, { total: 3 });
    await client
      .fetchQuery({
        queryKey: summaryKey,
        staleTime: 0,
        queryFn: () => Promise.reject(new Error("503")),
      })
      .catch(() => undefined);
    client.setQueryData(["campaigns", "t1", "paged", ""], {
      pages: [["a"], ["b"]],
      pageParams: [1, 2],
    });
    const list = entryFor(client, listKey);
    const summary = entryFor(client, summaryKey);
    const writesBefore = list.state.dataUpdateCount;

    expect(collapseInfiniteQueriesToFirstPage(client, listKey)).toBe(1);

    expect({
      dataUpdatedAt: list.state.dataUpdatedAt,
      isInvalidated: list.state.isInvalidated,
      dataUpdateCount: list.state.dataUpdateCount,
    }).toEqual({
      dataUpdatedAt: listAt,
      isInvalidated: true,
      dataUpdateCount: writesBefore,
    });
    expect(summary.state.status).toBe("error");
    expect(summary.state.error?.message).toBe("503");
    client.clear();
  });

  it("a list first mounted after the pull sees its real age, and refetches", async () => {
    const client = appLikeClient();
    const listKey = ["campaigns", "t1"];
    client.setQueryData(listKey, [{ id: "old" }], {
      updatedAt: Date.now() - 90_000,
    });
    client.setQueryData(["campaigns", "t1", "paged", ""], {
      pages: [["a"], ["b"]],
      pageParams: [1, 2],
    });
    collapseInfiniteQueriesToFirstPage(client, listKey);

    const requests: string[] = [];
    const observer = new QueryObserver(client, {
      queryKey: listKey,
      queryFn: async () => {
        requests.push("list");
        return [{ id: "new" }];
      },
    });
    const unsubscribe = await mount(observer);
    expect(requests).toEqual(["list"]);
    expect(observer.getCurrentResult().data).toEqual([{ id: "new" }]);
    unsubscribe();
    client.clear();
  });

  it("an invalidated variant off screen is collapsed, stays invalidated, and re-opens for one page", async () => {
    const client = appLikeClient();
    const searchKey = ["campaigns", "t1", "paged", "spring"];
    // Young enough to be fresh by the clock: only the invalidation makes it
    // stale, so only the invalidation can make re-opening it request anything.
    const searchAt = Date.now() - 10_000;
    client.setQueryData(
      searchKey,
      { pages: [["deleted-row"], ["b"], ["c"]], pageParams: [1, 2, 3] },
      { updatedAt: searchAt },
    );
    await client.invalidateQueries({
      queryKey: searchKey,
      exact: true,
      refetchType: "none",
    });

    expect(
      collapseInfiniteQueriesToFirstPage(client, ["campaigns", "t1"]),
    ).toBe(1);

    const search = entryFor(client, searchKey);
    expect(search.state.data).toEqual({
      pages: [["deleted-row"]],
      pageParams: [1],
    });
    expect({
      dataUpdatedAt: search.state.dataUpdatedAt,
      isInvalidated: search.state.isInvalidated,
    }).toEqual({ dataUpdatedAt: searchAt, isInvalidated: true });

    const requests: number[] = [];
    const observer = new InfiniteQueryObserver(client, {
      queryKey: searchKey,
      initialPageParam: 1,
      getNextPageParam: (_last: unknown, all: unknown[]) => all.length + 1,
      queryFn: async ({ pageParam }: { pageParam: unknown }) => {
        requests.push(Number(pageParam));
        return [`fresh-${String(pageParam)}`];
      },
    });
    const unsubscribe = await mount(observer);
    expect(requests).toEqual([1]);
    expect(observer.getCurrentResult().data?.pages).toEqual([["fresh-1"]]);
    unsubscribe();
    client.clear();
  });
});

/**
 * Fresh for 30 s, as lib/queryClient configures the app. That window is what
 * turns "was the entry re-stamped?" into "does the next mount request at all".
 */
function appLikeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 30_000 } },
  });
}

/** The live cache entry for `key`: its STATE, which getQueryData hides. */
function entryFor(client: QueryClient, key: readonly unknown[]) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  if (!query) throw new Error(`no cache entry for ${JSON.stringify(key)}`);
  return query;
}

/**
 * Subscribe the way a screen mounting does, then let any mount fetch settle.
 * A mount fetch starts synchronously inside `subscribe`, so "idle" afterwards
 * means either it finished or it never started, and the request log says which.
 */
async function mount(observer: {
  subscribe(listener: () => void): () => void;
  getCurrentResult(): { fetchStatus: string };
}) {
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().fetchStatus).toBe("idle"),
  );
  return unsubscribe;
}

/**
 * Build a real 3-page infinite query and count the requests a refresh costs.
 * `requests` is reset after the seed so only the gesture is measured.
 */
async function seedThreePages() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, gcTime: 5 * 60_000 } },
  });
  const requests: number[] = [];
  const key = ["campaigns", "t1", "paged", "", "u1", "admin", "network"];
  const observer = new InfiniteQueryObserver(client, {
    queryKey: key,
    initialPageParam: 1,
    getNextPageParam: (_last: unknown, all: unknown[]) => all.length + 1,
    queryFn: async ({ pageParam }: { pageParam: unknown }) => {
      requests.push(Number(pageParam));
      return [{ id: `p${String(pageParam)}` }];
    },
    networkMode: "always",
  });
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch();
  await observer.fetchNextPage();
  await observer.fetchNextPage();
  expect(observer.getCurrentResult().data?.pages).toHaveLength(3);
  requests.length = 0;
  return { client, observer, requests, key, unsubscribe };
}

describe("MEASURED: pull-to-refresh cost on a 3-page list", () => {
  it("BEFORE — a bare refetch() re-requests every loaded page, in order", async () => {
    const s = await seedThreePages();
    await s.observer.refetch();
    expect(s.requests).toEqual([1, 2, 3]);
    s.unsubscribe();
    s.client.clear();
  });

  it("AFTER — collapsing first costs exactly one request", async () => {
    const s = await seedThreePages();
    await refreshFirstPageOnly(s.client, ["campaigns", "t1"], () =>
      s.observer.refetch(),
    )();
    expect(s.requests).toEqual([1]);
    s.unsubscribe();
    s.client.clear();
  });

  it("AFTER — the list still knows there is more to load", async () => {
    const s = await seedThreePages();
    await refreshFirstPageOnly(s.client, ["campaigns", "t1"], () =>
      s.observer.refetch(),
    )();
    const result = s.observer.getCurrentResult();
    expect(result.data?.pages).toHaveLength(1);
    // TanStack re-derives this from the truncated pages, so "Load more" comes
    // back rather than the list claiming it has reached the end.
    expect(result.hasNextPage).toBe(true);
    s.unsubscribe();
    s.client.clear();
  });

  it("collapse:false pays the full price, for a client-filtered window", async () => {
    const s = await seedThreePages();
    await refreshFirstPageOnly(
      s.client,
      ["campaigns", "t1"],
      () => s.observer.refetch(),
      { collapse: false },
    )();
    expect(s.requests).toEqual([1, 2, 3]);
    expect(s.observer.getCurrentResult().data?.pages).toHaveLength(3);
    s.unsubscribe();
    s.client.clear();
  });

  it("collapsing BEFORE the refetch is load-bearing (the reverse order pays full price)", async () => {
    const s = await seedThreePages();
    await s.observer.refetch();
    collapseInfiniteQueriesToFirstPage(s.client, ["campaigns", "t1"]);
    expect(s.requests).toEqual([1, 2, 3]);
    s.unsubscribe();
    s.client.clear();
  });
});
