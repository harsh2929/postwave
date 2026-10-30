import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  firstPageOnly,
  flattenSubscriberPages,
  invalidateKeys,
  optimisticPatchQueries,
  projectTimelineStatus,
  rollbackPatchedQueries,
  subscriberRowPatch,
  type OptimisticPatchContext,
} from "./subscriberQueryCache";

describe("firstPageOnly", () => {
  it("drops every page after the first, and its pageParam with it", () => {
    // Without this, pull-to-refresh on a list 20 pages deep issues 20
    // sequential requests: TanStack refetches every loaded page.
    expect(
      firstPageOnly({
        pages: [{ n: 1 }, { n: 2 }, { n: 3 }],
        pageParams: [1, 2, 3],
      }),
    ).toEqual({ pages: [{ n: 1 }], pageParams: [1] });
  });

  it("returns the SAME object when there is nothing to trim", () => {
    const data = { pages: [{ n: 1 }], pageParams: [1] };
    expect(firstPageOnly(data)).toBe(data);
  });

  it("passes an empty cache through untouched", () => {
    const empty = { pages: [], pageParams: [] };
    expect(firstPageOnly(empty)).toBe(empty);
    expect(firstPageOnly(undefined)).toBeUndefined();
  });

  it("does not mutate the cached arrays", () => {
    const data = { pages: [{ n: 1 }, { n: 2 }], pageParams: [1, 2] };
    firstPageOnly(data);
    expect(data.pages).toHaveLength(2);
    expect(data.pageParams).toHaveLength(2);
  });
});

/** Minimal QueryClient stand-in — only the four methods these helpers use. */
function fakeClient(entries: [readonly unknown[], unknown][]) {
  const store = new Map(entries.map(([k, v]) => [JSON.stringify(k), v]));
  const cancelled: unknown[] = [];
  const invalidated: unknown[] = [];
  return {
    client: {
      cancelQueries: vi.fn(async (f: { queryKey: unknown }) => {
        cancelled.push(f.queryKey);
      }),
      getQueriesData: vi.fn(() =>
        [...store.entries()].map(([k, v]) => [JSON.parse(k), v]),
      ),
      setQueriesData: vi.fn((_f: unknown, updater: (v: unknown) => unknown) => {
        for (const [k, v] of store) store.set(k, updater(v));
      }),
      setQueryData: vi.fn((k: unknown, v: unknown) => {
        store.set(JSON.stringify(k), v);
      }),
      invalidateQueries: vi.fn(async (f: { queryKey: unknown }) => {
        invalidated.push(f.queryKey);
      }),
    },
    store,
    cancelled,
    invalidated,
  };
}

describe("optimisticPatchQueries", () => {
  it("cancels in-flight fetches before projecting, so a slow response can't clobber it", async () => {
    const { client, cancelled } = fakeClient([
      [["sub", "t", "s"], { email: "a@b.c", tags: [] }],
    ]);
    await optimisticPatchQueries(
      client as never,
      ["sub", "t", "s"],
      { tags: ["a"] },
    );
    expect(cancelled).toEqual([["sub", "t", "s"]]);
  });

  it("merges the patch into every matching entry", async () => {
    const { client, store } = fakeClient([
      [["sub", "t", "s"], { email: "a@b.c", tags: [], status: "enabled" }],
    ]);
    await optimisticPatchQueries(
      client as never,
      ["sub", "t", "s"],
      { tags: ["vip"] },
    );
    expect([...store.values()][0]).toEqual({
      email: "a@b.c",
      tags: ["vip"],
      status: "enabled",
    });
  });

  it("leaves an unpopulated entry alone rather than inventing a record", async () => {
    const { client, store } = fakeClient([[["sub", "t", "s"], undefined]]);
    await optimisticPatchQueries(client as never, ["sub", "t", "s"], {
      tags: ["vip"],
    });
    expect([...store.values()][0]).toBeUndefined();
  });

  it("returns a snapshot that rollback restores verbatim", async () => {
    const before = { email: "a@b.c", tags: ["keep"] };
    const { client, store } = fakeClient([[["sub", "t", "s"], before]]);
    const ctx = await optimisticPatchQueries(
      client as never,
      ["sub", "t", "s"],
      { tags: [] },
    );
    expect([...store.values()][0]).toEqual({ email: "a@b.c", tags: [] });
    rollbackPatchedQueries(client as never, ctx);
    expect([...store.values()][0]).toBe(before);
  });
});

describe("rollbackPatchedQueries", () => {
  it("is a no-op for a missing context", () => {
    const { client } = fakeClient([]);
    expect(() => rollbackPatchedQueries(client as never, undefined)).not.toThrow();
    expect(client.setQueryData).not.toHaveBeenCalled();
  });
});

describe("invalidateKeys", () => {
  it("invalidates every prefix it is given", () => {
    const { client, invalidated } = fakeClient([]);
    invalidateKeys(client as never, [
      ["subs", "t"],
      ["sub", "t", "s"],
    ]);
    expect(invalidated).toEqual([
      ["subs", "t"],
      ["sub", "t", "s"],
    ]);
  });

  it("tolerates an empty key set", () => {
    const { client } = fakeClient([]);
    expect(() => invalidateKeys(client as never, [])).not.toThrow();
  });
});

/* ---- the status projection the subscriber row writes depend on ---- */

interface FakeTimelinePage {
  ok: boolean;
  page?: { stats?: { current_status?: string }; events?: string[] } | null;
}

function timeline(status: string): {
  pages: FakeTimelinePage[];
  pageParams: unknown[];
} {
  return {
    pages: [
      { ok: true, page: { stats: { current_status: status }, events: ["e1"] } },
      { ok: true, page: { stats: { current_status: status }, events: ["e2"] } },
    ],
    pageParams: [null, "cursor-1"],
  };
}

describe("projectTimelineStatus", () => {
  it("rewrites only the FIRST page's stats — that is the one the header reads", () => {
    const next = projectTimelineStatus(timeline("enabled"), "blocklisted");
    expect(next?.pages[0]?.page?.stats?.current_status).toBe("blocklisted");
    // Later pages carry their own copy of stats and are never read for the
    // pill; rewriting them would be inventing history.
    expect(next?.pages[1]?.page?.stats?.current_status).toBe("enabled");
    expect(next?.pages[0]?.page?.events).toEqual(["e1"]);
    expect(next?.pageParams).toEqual([null, "cursor-1"]);
  });

  it("returns the same object when the status already matches", () => {
    const data = timeline("enabled");
    expect(projectTimelineStatus(data, "enabled")).toBe(data);
  });

  it("never fabricates a timeline", () => {
    expect(projectTimelineStatus(undefined, "blocklisted")).toBeUndefined();
    const noStats: { pages: FakeTimelinePage[]; pageParams: unknown[] } = {
      pages: [{ ok: false }],
      pageParams: [null],
    };
    expect(projectTimelineStatus(noStats, "blocklisted")).toBe(noStats);
  });

  it("does not mutate the cached pages array", () => {
    const data = timeline("enabled");
    projectTimelineStatus(data, "blocklisted");
    expect(data.pages[0]?.page?.stats?.current_status).toBe("enabled");
  });
});

describe("subscriberRowPatch, driven by a real MutationObserver", () => {
  interface Detail {
    email: string;
    status: string;
    tags: string[];
  }

  function seeded() {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    // The mounted detail query keys on userId/role/mode AFTER the id, which is
    // why the projection addresses ["sub", tenant, id] as a prefix.
    qc.setQueryData(["sub", "t1", "s1", "u1", "admin", "network"], {
      email: "ada@example.com",
      status: "enabled",
      tags: ["vip"],
    } satisfies Detail);
    qc.setQueryData(["sub-timeline", "t1", "s1"], timeline("enabled"));
    return qc;
  }

  const detailOf = (qc: QueryClient) =>
    qc.getQueryData<Detail>(["sub", "t1", "s1", "u1", "admin", "network"]);
  const pillOf = (qc: QueryClient) =>
    qc.getQueryData<{ pages: FakeTimelinePage[] }>([
      "sub-timeline",
      "t1",
      "s1",
    ])?.pages[0]?.page?.stats?.current_status;

  it("moves the status pill, not just the detail row", async () => {
    const qc = seeded();
    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      onMutate: () =>
        subscriberRowPatch<Detail>(qc, "t1", "s1", { status: "blocklisted" }),
      onError: (_err: unknown, _vars: unknown, context: unknown) =>
        rollbackPatchedQueries(qc, context as OptimisticPatchContext),
    });

    await observer.mutate(undefined);

    expect(detailOf(qc)?.status).toBe("blocklisted");
    // The screen derives the pill from the timeline, so this is the assertion
    // that proves the optimism is actually visible.
    expect(pillOf(qc)).toBe("blocklisted");
  });

  it("ROLLS BACK both caches together when the write fails", async () => {
    const qc = seeded();
    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw new Error("PATCH failed");
      },
      onMutate: () =>
        subscriberRowPatch<Detail>(qc, "t1", "s1", { status: "blocklisted" }),
      onError: (_err: unknown, _vars: unknown, context: unknown) =>
        rollbackPatchedQueries(qc, context as OptimisticPatchContext),
    });

    await expect(observer.mutate(undefined)).rejects.toThrow("PATCH failed");

    expect(detailOf(qc)?.status).toBe("enabled");
    expect(pillOf(qc)).toBe("enabled");
  });

  it("leaves the timeline alone for a non-status patch (tags)", async () => {
    const qc = seeded();
    const context = await subscriberRowPatch<Detail>(qc, "t1", "s1", {
      tags: ["vip", "beta"],
    });
    expect(detailOf(qc)?.tags).toEqual(["vip", "beta"]);
    expect(pillOf(qc)).toBe("enabled");
    // Only the detail entry was snapshotted, so a rollback cannot disturb the
    // timeline either.
    expect(context.previous).toHaveLength(1);
  });

  it("is a no-op without a tenant, and rolls back to nothing", async () => {
    const qc = seeded();
    const context = await subscriberRowPatch<Detail>(qc, null, "s1", {
      status: "blocklisted",
    });
    expect(context.previous).toEqual([]);
    expect(detailOf(qc)?.status).toBe("enabled");
  });
});

/**
 * flattenSubscriberPages is the ONLY boundary between the persisted query
 * cache and the subscribers list, which is the busiest screen in the app.
 *
 * The cache is written to disk and rehydrated on launch
 * (lib/secureQueryPersister), and that module's own header records the trap:
 * a restored payload is handed straight to code written as `?? []`, a NULLISH
 * guard that passes a truthy `{}` through. Both loops here used it, so a
 * restored entry whose `pages` — or whose per-page `items` — was an object
 * threw "object is not iterable" inside the screen's render and the route
 * error boundary replaced the Subscribers tab with a blank.
 */
describe("flattenSubscriberPages survives a truthy non-array", () => {
  /** Payloads that pass `?? []` and are not arrays. */
  const HOSTILE: readonly unknown[] = [{}, { items: [] }, "nope", 42, true];

  it("does not throw on a non-array `pages`", () => {
    for (const bad of HOSTILE) {
      expect(
        () => flattenSubscriberPages({ pages: bad } as never),
        `threw on pages = ${JSON.stringify(bad)}`,
      ).not.toThrow();
      expect(flattenSubscriberPages({ pages: bad } as never).rows).toEqual([]);
    }
  });

  it("does not throw on a non-array page `items`", () => {
    for (const bad of HOSTILE) {
      const data = { pages: [{ items: bad, total: 7 }] } as never;
      expect(
        () => flattenSubscriberPages(data),
        `threw on items = ${JSON.stringify(bad)}`,
      ).not.toThrow();
      // The page's own `total` is still read: skipping unreadable ROWS must
      // not also discard the workspace size the same page reported.
      expect(flattenSubscriberPages(data).serverTotal).toBe(7);
    }
  });

  it("still flattens a REAL result — the guard must not swallow good input", () => {
    // A guard that returned [] unconditionally would pass both tests above.
    const { rows, serverTotal } = flattenSubscriberPages<{ id: string }>({
      pages: [
        { items: [{ id: "a" }, { id: "b" }], total: 9 },
        { items: [{ id: "c" }], total: 9 },
      ],
    } as never);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(serverTotal).toBe(9);
  });
});
