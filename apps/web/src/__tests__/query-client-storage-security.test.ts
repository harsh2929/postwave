import { afterEach, describe, expect, it, vi } from "vitest";

const idb = vi.hoisted(() => ({
  store: { name: "legacy-query-store" },
  createStore: vi.fn(),
  del: vi.fn(async () => undefined),
}));

vi.mock("idb-keyval", () => ({
  createStore: idb.createStore,
  del: idb.del,
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("web query-cache storage boundary", () => {
  it("keeps customer query snapshots in memory and only deletes legacy IDB", async () => {
    const localStorage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        setItem: (key: string, value: string) => localStorage.set(key, value),
        removeItem: (key: string) => localStorage.delete(key),
      },
    });
    idb.createStore.mockReturnValue(idb.store);

    const { idbPersister, purgeLegacyQueryCache } = await import(
      "../lib/query-client"
    );
    const client = {
      timestamp: Date.now(),
      buster: "test:user-a:tenant-a",
      clientState: {
        mutations: [],
        queries: [
          {
            dehydratedAt: Date.now(),
            state: {
              data: { email: "private-person@example.com" },
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: "success" as const,
              fetchStatus: "idle" as const,
            },
            queryKey: ["subscriber", "sub_1"],
            queryHash: '["subscriber","sub_1"]',
          },
        ],
      },
    };

    await idbPersister.persistClient(client);

    expect(await idbPersister.restoreClient()).toEqual(client);
    expect(localStorage.size).toBe(0);
    expect(idb.del).not.toHaveBeenCalled();

    await purgeLegacyQueryCache();
    expect(idb.del).toHaveBeenCalledWith("tanstack-query-cache", idb.store);
  });
});
