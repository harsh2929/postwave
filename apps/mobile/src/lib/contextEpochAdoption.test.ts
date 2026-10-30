import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const { getItem, setItem, removeItem, request } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem, removeItem },
}));
vi.mock("./offlineReplayTelemetry", () => ({ trackOfflineReplay: vi.fn() }));
vi.mock("./offlineMutationFailures", () => ({
  recordOfflineMutationFailure: vi.fn(),
}));
// The real module reaches `getClient` and the auth store, both of which pull in
// react-native. Stubbed to the two facts the scope check compares against.
vi.mock("../api/sdkClient", () => ({
  getClient: () => ({
    baseUrl: "https://api.test",
    tenantId: "t-1",
    client: { request },
  }),
}));
vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      session: { userId: "u-1", effectiveRole: "admin" },
    }),
  },
}));

const {
  assertCurrentAuthScope,
  currentOfflineAuthScope,
  OfflineMutationReplayError,
} = await import("./offlineMutationScope");
const {
  observeContextEpoch,
  onContextEpochChange,
  readContextEpoch,
  resetContextEpoch,
  wireContextEpochCacheReset,
} = await import("./contextEpoch");

/**
 * Mobile's adoption of the context epoch.
 *
 * `assertCurrentAuthScope` already re-proves origin, tenant, principal and role
 * at replay — but every one of those is a fact the CLIENT holds, so the check
 * can only catch what this device can see changing. It cannot see a plan
 * downgrade that removes a feature, or a role change that has not yet reached
 * this device's auth store. The epoch is the server's own verdict, so no
 * agreement between the two sides about how to derive one is required.
 */

beforeEach(() => {
  vi.clearAllMocks();
  resetContextEpoch();
});

describe("mobile observes the epoch", () => {
  it("records the value and reports only a MOVE as a change", () => {
    expect(
      observeContextEpoch("ce1-first"),
      "first sighting counted as a change",
    ).toBe(false);
    expect(readContextEpoch()).toBe("ce1-first");
    expect(observeContextEpoch("ce1-first")).toBe(false);
    expect(observeContextEpoch("ce1-second")).toBe(true);
  });

  it("ignores an absent header rather than treating it as a change", () => {
    observeContextEpoch("ce1-live");
    expect(observeContextEpoch(null)).toBe(false);
    expect(observeContextEpoch("")).toBe(false);
    expect(readContextEpoch(), "a public response wiped the live context").toBe(
      "ce1-live",
    );
  });
});

describe("mobile stamps the epoch on the queued scope", () => {
  it("records it on the scope every screen builds", () => {
    // `currentOfflineAuthScope` is the ONE function screens call to build a
    // scope, which is why the epoch belongs here rather than at N call sites.
    observeContextEpoch("ce1-atqueue");
    expect(currentOfflineAuthScope().contextEpoch).toBe("ce1-atqueue");
  });

  it("omits it when no response has carried one yet", () => {
    // Launched offline. The write must still queue; it simply cannot be judged.
    expect(currentOfflineAuthScope().contextEpoch).toBeUndefined();
  });
});

describe("mobile refuses a write whose context has moved", () => {
  function scopeWith(over: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      baseUrl: "https://api.test",
      tenantId: "t-1",
      principalId: "u-1",
      role: "admin",
      queuedAt: now - 60_000,
      expiresAt: now + 60 * 60_000,
      ...over,
    } as never;
  }

  it("throws context_changed when the epoch moved", () => {
    observeContextEpoch("ce1-now");
    try {
      assertCurrentAuthScope(scopeWith({ contextEpoch: "ce1-when-queued" }));
      throw new Error("the write replayed under a context the caller has left");
    } catch (err) {
      expect(err).toBeInstanceOf(OfflineMutationReplayError);
      expect((err as { code: string }).code).toBe("context_changed");
      // The message is what the person reads. "Something went wrong" would be
      // false — nothing did; their permissions changed while it waited.
      expect((err as Error).message).toMatch(/workspace or permissions/i);
    }
  });

  it("ALLOWS a write whose context has not moved", () => {
    // The mirror failure, and the more damaging one: refusing valid work.
    observeContextEpoch("ce1-stable");
    expect(() =>
      assertCurrentAuthScope(scopeWith({ contextEpoch: "ce1-stable" })),
    ).not.toThrow();
  });

  it("allows a write that predates the field", () => {
    observeContextEpoch("ce1-current");
    expect(() => assertCurrentAuthScope(scopeWith())).not.toThrow();
  });

  it("allows a write when this launch has not yet seen an epoch", () => {
    // Cold start, still offline. Treating "not yet known" as "changed" would
    // refuse the whole queue on every launch.
    expect(() =>
      assertCurrentAuthScope(
        scopeWith({ contextEpoch: "ce1-from-last-session" }),
      ),
    ).not.toThrow();
  });

  it("prefers identity_mismatch when BOTH have changed", () => {
    // The more specific and more actionable answer: "sign back in as that
    // person" beats the vaguer context message.
    observeContextEpoch("ce1-now");
    try {
      assertCurrentAuthScope(
        scopeWith({ principalId: "someone-else", contextEpoch: "ce1-old" }),
      );
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as { code: string }).code).toBe("identity_mismatch");
    }
  });
});

describe("mobile drops a cache built under another context", () => {
  function memStore() {
    const map = new Map<string, string>();
    return {
      getItem: async (k: string) => map.get(k) ?? null,
      setItem: async (k: string, v: string) => void map.set(k, v),
      peek: (k: string) => map.get(k) ?? null,
    };
  }
  const KEY = "postwave.mobile.cache-epoch.v1";
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("does not clear on the first sighting of a launch", async () => {
    let cleared = 0;
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => (cleared += 1) }) },
      memStore(),
    );
    observeContextEpoch("ce1-first");
    await settle();
    expect(cleared, "the cache was wiped on a normal launch").toBe(0);
  });

  it("clears when the epoch moves mid-session", async () => {
    let cleared = 0;
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => (cleared += 1) }) },
      memStore(),
    );
    observeContextEpoch("ce1-first");
    await settle();
    observeContextEpoch("ce1-second");
    await settle();
    expect(cleared).toBe(1);
  });

  it("clears a REHYDRATED cache built before a demotion", async () => {
    // Current v5 writes no query responses. This models a legacy blob or a
    // future persistence-policy regression: provenance must still contain it.
    const store = memStore();
    await store.setItem(KEY, "ce1-before-demotion");
    let cleared = 0;
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => (cleared += 1) }) },
      store,
    );
    observeContextEpoch("ce1-after-demotion");
    await settle();
    expect(cleared, "a pre-demotion cache survived the app restart").toBe(1);
  });

  it("keeps a rehydrated cache built under the SAME context", async () => {
    const store = memStore();
    await store.setItem(KEY, "ce1-same");
    let cleared = 0;
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => (cleared += 1) }) },
      store,
    );
    observeContextEpoch("ce1-same");
    await settle();
    expect(cleared).toBe(0);
  });

  it("records provenance for the next launch", async () => {
    const store = memStore();
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => undefined }) },
      store,
    );
    observeContextEpoch("ce1-recorded");
    await settle();
    expect(store.peek(KEY)).toBe("ce1-recorded");
  });

  it("fails closed across the whole live query cache when provenance cannot be read", async () => {
    // Model the sensitive screen still being mounted with a non-empty register
    // when the server reveals a role/epoch demotion. The other query proves the
    // containment boundary is the established global query cache, not a list
    // of Route 37 keys that could drift as detail/event keys evolve.
    const client = new QueryClient();
    const incidentKey = ["privacy-incidents", "tenant-1"] as const;
    const dashboardKey = ["dashboard-stats", "tenant-1"] as const;
    client.setQueryData(incidentKey, {
      incidents: [{ id: "incident-from-admin-context" }],
      nextCursor: "",
      truncated: false,
    });
    client.setQueryData(dashboardKey, { sent: 42 });
    const observer = new QueryObserver(client, {
      queryKey: incidentKey,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: incidentKey })
        ?.getObserversCount(),
    ).toBe(1);

    observeContextEpoch("ce1-admin");
    const store = {
      getItem: vi
        .fn()
        .mockRejectedValue(new Error("secure storage unavailable")),
      setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
    };
    wireContextEpochCacheReset(client, store);
    observeContextEpoch("ce1-viewer-after-demotion");
    await settle();

    expect(client.getQueryData(incidentKey)).toBeUndefined();
    expect(client.getQueryData(dashboardKey)).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(store.setItem).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("subscribes at most once", async () => {
    // Fast Refresh and a remounting root would otherwise clear repeatedly for
    // one change, turning a correctness mechanism into a refetch storm.
    const store = memStore();
    await store.setItem(KEY, "ce1-old");
    let cleared = 0;
    const client = { getQueryCache: () => ({ clear: () => (cleared += 1) }) };
    wireContextEpochCacheReset(client, store);
    wireContextEpochCacheReset(client, store);
    observeContextEpoch("ce1-new");
    await settle();
    expect(cleared).toBe(1);
  });

  it("notifies plain change listeners too", () => {
    const seen: string[] = [];
    onContextEpochChange((e) => seen.push(e));
    observeContextEpoch("ce1-a");
    observeContextEpoch("ce1-b");
    expect(seen).toEqual(["ce1-b"]);
  });

  it("retires a moved context synchronously even when provenance storage never settles", async () => {
    const client = new QueryClient();
    const incidentKey = ["privacy-incidents", "tenant-1"] as const;
    client.setQueryData(incidentKey, {
      incidents: [{ id: "incident-from-admin-context" }],
    });
    const observer = new QueryObserver(client, {
      queryKey: incidentKey,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const neverSettles = new Promise<string | null>(() => undefined);
    const store = {
      getItem: vi.fn(() => neverSettles),
      setItem: vi
        .fn<(key: string, value: string) => Promise<void>>()
        .mockResolvedValue(),
    };
    wireContextEpochCacheReset(client, store);

    observeContextEpoch("ce1-admin");
    await Promise.resolve();
    expect(store.getItem).toHaveBeenCalledTimes(1);

    observeContextEpoch("ce1-viewer-after-demotion");

    // No await after the move: the old result must disappear before the SDK
    // can hand the response back to TanStack, regardless of native storage.
    expect(client.getQueryData(incidentKey)).toBeUndefined();
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });
});

describe("mobile cache reset: ordering and concurrency", () => {
  /** Storage that records the exact interleaving of reads, writes and clears. */
  function tracingStore(log: string[], initial?: string) {
    const map = new Map<string, string>();
    if (initial) map.set("postwave.mobile.cache-epoch.v1", initial);
    return {
      getItem: async (k: string) => {
        log.push(`get:${map.get(k) ?? "-"}`);
        return map.get(k) ?? null;
      },
      setItem: async (k: string, v: string) => {
        log.push(`set:${v}`);
        map.set(k, v);
      },
      peek: (k: string) => map.get(k) ?? null,
    };
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };

  it("CLEARS BEFORE recording provenance", async () => {
    // Write-ahead is inverted here on purpose. iOS kills a backgrounded app
    // without warning, and mobile has a guaranteed `await` between the two
    // steps — so recording first means the process can die with provenance
    // saying "epoch B" while the cache is still A-era. The next launch then
    // compares B against B and never clears it again.
    const log: string[] = [];
    const store = tracingStore(log, "ce1-before");
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => log.push("clear") }) },
      store,
    );
    observeContextEpoch("ce1-after");
    await settle();

    expect(log).toEqual(["get:ce1-before", "clear", "set:ce1-after"]);
    expect(
      log.indexOf("clear"),
      "provenance was advanced before the cache was actually dropped",
    ).toBeLessThan(log.indexOf("set:ce1-after"));
  });

  it("does not clear twice when two responses land together", async () => {
    // Both would otherwise park on `getItem`, read the same provenance, and
    // both decide to clear — the second wipe destroying what the first
    // refetch had already repopulated.
    const log: string[] = [];
    const store = tracingStore(log, "ce1-before");
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => log.push("clear") }) },
      store,
    );
    observeContextEpoch("ce1-after");
    observeContextEpoch("ce1-after");
    await settle();

    expect(log.filter((e) => e === "clear")).toHaveLength(1);
  });

  it("leaves provenance at the LAST epoch after rapid moves", async () => {
    // Out-of-order `setItem` resolution would strand provenance behind the live
    // epoch, so every later launch clears spuriously and never converges.
    const log: string[] = [];
    const store = tracingStore(log, "ce1-a");
    wireContextEpochCacheReset(
      { getQueryCache: () => ({ clear: () => log.push("clear") }) },
      store,
    );
    observeContextEpoch("ce1-b");
    observeContextEpoch("ce1-c");
    await settle();

    expect(store.peek("postwave.mobile.cache-epoch.v1")).toBe("ce1-c");
  });

  it.each(["rejects", "resolves"] as const)(
    "retires old-context rows when observation A's provenance read %s without wiping data populated after B",
    async (retiredOutcome) => {
      let resolveRetiredRead!: (value: string | null) => void;
      let rejectRetiredRead!: (reason: Error) => void;
      const retiredRead = new Promise<string | null>((resolve, reject) => {
        resolveRetiredRead = resolve;
        rejectRetiredRead = reject;
      });
      const getItem = vi
        .fn<(key: string) => Promise<string | null>>()
        .mockImplementationOnce(() => retiredRead)
        // The record still names the RETIRED owner, which is what a stored
        // provenance looks like before the move is recorded. It used to return
        // the new owner from every later read, so the write asserted at the end
        // of this case was one that changed nothing — and it stopped happening
        // once redundant writes were dropped from the per-response path.
        .mockResolvedValue("ce1-retired-owner");
      const store = {
        getItem,
        setItem: vi
          .fn<(key: string, value: string) => Promise<void>>()
          .mockResolvedValue(),
      };
      const client = new QueryClient();
      const oldOwnerOnlyKey = [
        "privacy-incidents",
        "tenant-retired-owner",
      ] as const;
      const refreshedAfterBKey = [
        "privacy-incident",
        "tenant-shared",
        "incident-shared",
      ] as const;
      client.setQueryData(oldOwnerOnlyKey, {
        incidents: [{ id: "belongs-only-to-retired-owner" }],
      });
      client.setQueryData(refreshedAfterBKey, {
        id: "incident-shared",
        summary: "A-era value",
      });
      const sharedQuery = client
        .getQueryCache()
        .find({ queryKey: refreshedAfterBKey });
      // This row was in flight at A's boundary. If the retired A snapshot is
      // drained after the newer B boundary, its conservative wasInFlight bit
      // would erase a safe B update even though B correctly preserves it.
      sharedQuery?.setState({ fetchStatus: "fetching" });
      wireContextEpochCacheReset(client, store);

      observeContextEpoch("ce1-retired-owner");
      // Let the first reconciliation take ownership of its delayed storage read.
      await Promise.resolve();
      expect(getItem).toHaveBeenCalledTimes(1);

      // The A request has settled before B's header arrives; B's later snapshot
      // now subsumes A and is the authoritative cache boundary.
      sharedQuery?.setState({ fetchStatus: "idle" });
      observeContextEpoch("ce1-new-owner");
      // A same-B response may arrive while B's reconciliation is still queued.
      // It becomes the newest owner without creating another epoch change; the
      // pending clear must follow it rather than being stranded on generation B1.
      observeContextEpoch("ce1-new-owner");
      const newOwnerKey = ["privacy-incidents", "tenant-new-owner"] as const;
      client.setQueryData(refreshedAfterBKey, {
        id: "incident-shared",
        summary: "B-era value",
      });
      client.setQueryData(newOwnerKey, {
        incidents: [{ id: "belongs-to-new-owner" }],
        nextCursor: "",
        truncated: false,
      });
      if (retiredOutcome === "rejects") {
        rejectRetiredRead(new Error("retired secure-storage read failed"));
      } else {
        resolveRetiredRead("ce1-retired-owner");
      }
      await settle();

      expect(getItem).toHaveBeenCalledTimes(3);
      expect(client.getQueryData(oldOwnerOnlyKey)).toBeUndefined();
      expect(client.getQueryData(refreshedAfterBKey)).toEqual({
        id: "incident-shared",
        summary: "B-era value",
      });
      expect(client.getQueryData(newOwnerKey)).toEqual({
        incidents: [{ id: "belongs-to-new-owner" }],
        nextCursor: "",
        truncated: false,
      });
      expect(store.setItem).toHaveBeenCalledWith(
        "postwave.mobile.cache-epoch.v1",
        "ce1-new-owner",
      );
    },
  );
});
