import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

const storage = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  async: new Map<string, string>(),
  failSetKey: null as string | null,
  failDeleteKey: null as string | null,
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async (key: string) => storage.secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (storage.failSetKey === key) throw new Error("set failed");
    storage.secure.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (storage.failDeleteKey === key) throw new Error("delete failed");
    storage.secure.delete(key);
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.async.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.async.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.async.delete(key);
    }),
  },
}));

// eslint-disable-next-line import/first
import {
  getOfflinePersistenceHealth,
  resetOfflinePersistenceHealth,
} from "./offlinePersistenceHealth";
// eslint-disable-next-line import/first
import {
  configureQueryPersistenceScope,
  queryPersister,
  secureQueryPersistenceLimits,
} from "./secureQueryPersister";

const identity = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant-1",
  principalId: "user-1",
  role: "editor",
};

function multi(entries: readonly (readonly [string, string])[]): PersistedClient {
  const base = persisted(entries[0]?.[0] ?? "first", entries[0]?.[1] ?? "");
  base.clientState.mutations = entries.map(
    ([label, blob]) => persisted(label, blob).clientState.mutations[0]!,
  );
  return base;
}

function persisted(label: string, blob = ""): PersistedClient {
  return {
    timestamp: Date.now(),
    buster: "postwave-mobile-encrypted-v4",
    clientState: {
      queries: [],
      mutations: [
        {
          mutationKey: ["test", label],
          state: {
            context: undefined,
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: { label, blob },
            submittedAt: Date.now(),
          },
        },
      ],
    },
  };
}

describe("encrypted query/offline-mutation persister", () => {
  beforeEach(() => {
    storage.secure.clear();
    storage.async.clear();
    storage.failSetKey = null;
    storage.failDeleteKey = null;
    resetOfflinePersistenceHealth();
    configureQueryPersistenceScope(identity);
  });

  it("round-trips a bounded client through identity-scoped SecureStore", async () => {
    storage.async.set("postwave.mobile.query-cache.v1", "plaintext legacy");
    const client = persisted("first", "customer content");

    await queryPersister.persistClient(client);

    expect(storage.async.has("postwave.mobile.query-cache.v1")).toBe(false);
    expect(await queryPersister.restoreClient()).toEqual(client);
    expect(
      [...storage.secure.keys()].every((key) =>
        key.startsWith("postwave.mobile.query-cache.v2"),
      ),
    ).toBe(true);
  });

  it("does not restore another user or role's encrypted queue", async () => {
    await queryPersister.persistClient(persisted("owner"));

    configureQueryPersistenceScope({ ...identity, principalId: "user-2" });
    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
    configureQueryPersistenceScope({ ...identity, role: "viewer" });
    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
  });

  it("keeps the last committed slot readable after a torn replacement write", async () => {
    const first = persisted("first");
    await queryPersister.persistClient(first);
    storage.failSetKey = "postwave.mobile.query-cache.v2.slot.b.0";

    await expect(
      queryPersister.persistClient(persisted("second")),
    ).rejects.toThrow(/set failed/i);
    storage.failSetKey = null;

    await expect(queryPersister.restoreClient()).resolves.toEqual(first);
  });

  it("retains a cleanup marker and retries failed purges on next restore", async () => {
    await queryPersister.persistClient(persisted("cleanup"));
    storage.failDeleteKey = "postwave.mobile.query-cache.v2.slot.a.0";

    await expect(queryPersister.removeClient()).rejects.toThrow(/incomplete/i);
    expect(
      storage.secure.has("postwave.mobile.query-cache.v2.cleanup-pending"),
    ).toBe(true);

    storage.failDeleteKey = null;
    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
    expect(
      [...storage.secure.keys()].filter((key) =>
        key.startsWith("postwave.mobile.query-cache.v2"),
      ),
    ).toEqual([]);
  });

  it("evicts the oldest queued writes instead of freezing on-disk state (NATIVE#45)", async () => {
    // Three queued edits whose combined size blows the budget. Before the fix
    // this threw before touching the manifest, so NOTHING was persisted and
    // every later edit was lost silently.
    const chunk = "x".repeat(Math.floor(secureQueryPersistenceLimits.maxBytes / 2));
    const oversize = multi([
      ["oldest", chunk],
      ["middle", chunk],
      ["newest", chunk],
    ]);

    await expect(queryPersister.persistClient(oversize)).resolves.toBeUndefined();

    const restored = await queryPersister.restoreClient();
    const labels = (restored?.clientState.mutations ?? []).map(
      (m) => (m.state.variables as { label: string }).label,
    );
    // Newest survives, oldest evicted — and the eviction is reported, not silent.
    expect(labels).toEqual(["newest"]);
    expect(getOfflinePersistenceHealth().droppedMutations).toBe(2);
    expect(getOfflinePersistenceHealth().overflows).toBe(0);
  });

  it("still fails closed when even an empty queue cannot fit", async () => {
    const huge = persisted("large");
    // Bloat a field OUTSIDE clientState.mutations so eviction cannot help.
    (huge as unknown as { buster: string }).buster = "x".repeat(
      secureQueryPersistenceLimits.maxBytes,
    );

    await expect(queryPersister.persistClient(huge)).rejects.toThrow(
      /budget|safely/i,
    );
    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
    expect(getOfflinePersistenceHealth().overflows).toBe(1);
  });

  it("does not persist anything when no human identity scope is active", async () => {
    configureQueryPersistenceScope(null);
    await queryPersister.persistClient(persisted("disabled"));

    expect(storage.secure.size).toBe(0);
    await expect(queryPersister.restoreClient()).resolves.toBeUndefined();
  });
});

/**
 * The write-storm guard.
 *
 * TanStack v5's `persistQueryClientSubscribe` calls `persistQueryClientSave`
 * on EVERY query-cache AND mutation-cache event, with no throttle at all (v4
 * had one; v5 dropped it). Each of those calls lands here as a full encrypted
 * persist: dehydrate, chunk, and up to MAX_CHUNKS awaited Keychain writes plus
 * the deletes for the slot being replaced.
 *
 * The payload almost never changes. `shouldPersistQuery` returns false
 * unconditionally (lib/queryClient.ts), so the persisted blob holds ONLY
 * paused mutations — and during a cold start, hundreds of query-cache events
 * fire while that list stays byte-identical. The app was re-encrypting and
 * rewriting the same bytes to the Keychain hundreds of times per launch, on
 * the JS thread that also drives scrolling.
 *
 * The comparison has to be over `clientState` alone: the envelope carries
 * `expiresAt`, and the PersistedClient carries `timestamp`, both of which move
 * on every single call. Hashing the whole envelope would never match and the
 * guard would be dead code that still looked right.
 */
describe("unchanged payloads are not re-persisted", () => {
  beforeEach(() => {
    storage.secure.clear();
    storage.async.clear();
    storage.failSetKey = null;
    storage.failDeleteKey = null;
    resetOfflinePersistenceHealth();
    configureQueryPersistenceScope(identity);
  });

  async function countedWrites(fn: () => Promise<void>): Promise<number> {
    const SecureStore = await import("expo-secure-store");
    const setItem = vi.mocked(SecureStore.setItemAsync);
    const before = setItem.mock.calls.length;
    await fn();
    return setItem.mock.calls.length - before;
  }

  it("writes on the first persist and skips an identical follow-up", async () => {
    const client = persisted("only");
    const first = await countedWrites(() => queryPersister.persistClient(client));
    expect(first).toBeGreaterThan(0);

    // Same clientState, fresh envelope timestamp — exactly what
    // persistQueryClientSave produces on the next cache event.
    const second = await countedWrites(() =>
      queryPersister.persistClient({ ...client, timestamp: client.timestamp + 1_000 }),
    );
    expect(second).toBe(0);
  });

  it("absorbs a burst of cache events with a single write", async () => {
    const client = persisted("only");
    await queryPersister.persistClient(client);

    const burst = await countedWrites(async () => {
      for (let i = 0; i < 50; i += 1) {
        await queryPersister.persistClient({
          ...client,
          timestamp: client.timestamp + i,
        });
      }
    });
    // 50 cache events used to be 50 full persist cycles.
    expect(burst).toBe(0);
  });

  it("still persists immediately when a mutation is actually queued", async () => {
    await queryPersister.persistClient(persisted("first"));
    // Durability is the point of this store: new queued work must reach disk.
    const changed = await countedWrites(() =>
      queryPersister.persistClient(multi([["first", ""], ["second", ""]])),
    );
    expect(changed).toBeGreaterThan(0);
  });

  it("restores the persisted payload after a skipped write", async () => {
    const client = persisted("only");
    await queryPersister.persistClient(client);
    await queryPersister.persistClient({ ...client, timestamp: client.timestamp + 1 });
    const restored = await queryPersister.restoreClient();
    expect(restored?.clientState.mutations).toHaveLength(1);
  });

  it("does not let the guard survive a removeClient", async () => {
    const client = persisted("only");
    await queryPersister.persistClient(client);
    await queryPersister.removeClient();
    // After a wipe the identical payload must be written again, or signing
    // back in would leave the queue unrecoverable.
    const again = await countedWrites(() => queryPersister.persistClient(client));
    expect(again).toBeGreaterThan(0);
  });
});
