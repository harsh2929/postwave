import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  observeContextEpoch,
  onContextEpochChange,
  readContextEpoch,
  resetContextEpoch,
  subscribeContextEpochCacheReset,
} from "../../lib/context-epoch";
import {
  type OfflineMutation,
  clearOfflineStores,
  enqueueOfflineMutation,
  offlineQueueIdle,
  readOfflineQueue,
  setOfflineIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox, listDeadLetter } from "../../lib/outbox";
import { clearTombstones } from "../../lib/tombstones";

/**
 * Desktop's adoption of the context epoch, driven through the REAL drain.
 *
 * Desktop holds a queue across restarts in the encrypted vault, so the gap
 * between "when this was written" and "who I am now" is widest on this surface:
 * a laptop shut with work pending and opened days later replays as whoever is
 * signed in THEN. If an admin demoted them in between, the write either fails
 * confusingly or — where the server's check is coarser than the UI's — succeeds
 * as an action they are no longer allowed to take.
 */

const storage = new Map<string, string>();

beforeEach(async () => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
    crypto: webcrypto as unknown as Crypto,
  });
  vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
  vi.stubGlobal("navigator", {});
  await clearOfflineStores();
  await setOfflineIdentity("test-user:test-tenant");
  await offlineQueueIdle();
  clearTombstones();
  resetContextEpoch();
});

afterEach(async () => {
  await clearOfflineStores();
  await offlineQueueIdle();
  vi.unstubAllGlobals();
});

/**
 * Seeds a queued write directly, with whatever epoch it should carry.
 *
 * Through `writeOfflineQueue` rather than the enqueue path because the drain is
 * what is under test here; the enqueue-side stamping is asserted separately
 * below, where the store's own sanitizer is the thing being checked.
 */
function seed(over: Partial<OfflineMutation> & { id: string }): void {
  writeOfflineQueue([
    {
      method: "PATCH",
      path: "/api/v1/forms/form_1",
      body: { name: "Edit" },
      idempotencyKey: `idem_${over.id}`,
      queuedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      attempts: 0,
      status: "pending",
      ...over,
    } as OfflineMutation,
  ]);
  expect(readOfflineQueue(), "the store rejected the seeded fixture").toHaveLength(1);
}

describe("desktop observes the epoch", () => {
  it("records the value and reports only a MOVE as a change", () => {
    expect(observeContextEpoch("ce1-first"), "first sighting counted as a change").toBe(false);
    expect(readContextEpoch()).toBe("ce1-first");
    expect(observeContextEpoch("ce1-first")).toBe(false);

    const seen: string[] = [];
    onContextEpochChange((e) => seen.push(e));
    expect(observeContextEpoch("ce1-second")).toBe(true);
    expect(seen).toEqual(["ce1-second"]);
  });

  it("ignores an absent header instead of treating it as a change", () => {
    // Unauthenticated responses carry none by design; clearing on one would
    // discard a live context whenever the app touched a public endpoint.
    observeContextEpoch("ce1-live");
    expect(observeContextEpoch(null)).toBe(false);
    expect(readContextEpoch()).toBe("ce1-live");
  });
});

describe("desktop stamps the epoch on a queued write", () => {
  it("stamps it through the REAL enqueue path", async () => {
    // Through `enqueueOfflineMutation`, not `writeOfflineQueue`. The first
    // version of this block seeded the queue directly and was titled as if it
    // tested the stamp — deleting the stamp left it green, which a review
    // demonstrated. The enqueue path is the one production uses.
    observeContextEpoch("ce1-atqueue");
    const result = await enqueueOfflineMutation({
      method: "PATCH",
      path: "/api/v1/forms/form_1",
      body: { name: "Edit" },
    });
    expect(result.ok, "the store refused the write outright").toBe(true);
    await offlineQueueIdle();

    const [stored] = readOfflineQueue();
    expect(stored?.contextEpoch, "the queued write carries no context").toBe("ce1-atqueue");
  });

  it("queues without one when no response has carried an epoch yet", async () => {
    // Launched offline. The write must still queue; it simply cannot be judged.
    const result = await enqueueOfflineMutation({
      method: "PATCH",
      path: "/api/v1/forms/form_1",
      body: { name: "Edit" },
    });
    expect(result.ok).toBe(true);
    await offlineQueueIdle();
    expect(readOfflineQueue()[0]?.contextEpoch).toBeUndefined();
  });

  it("keeps the field through the store's sanitizer", async () => {
    // A field the sanitizer does not explicitly name is DROPPED on the way to
    // the vault — which is exactly how the tombstone rule's `resource` was lost.
    seed({ id: "mut_epoch", contextEpoch: "ce1-persisted" } as never);
    await offlineQueueIdle();
    expect(readOfflineQueue()[0]?.contextEpoch).toBe("ce1-persisted");
  });
});

describe("desktop refuses a write whose context has moved", () => {
  it("does not replay it, and parks it for the person", async () => {
    seed({ id: "mut_stale", contextEpoch: "ce1-when-queued" } as never);
    observeContextEpoch("ce1-after-demotion");

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(
      replay,
      "the write replayed as the person they are NOW, not the person who queued it",
    ).not.toHaveBeenCalled();
    expect(totals.staleContext).toBe(1);
    // Surfaced rather than silently dropped: it is their work, and only they
    // can decide whether it still applies.
    expect(listDeadLetter()).toHaveLength(1);
  });

  it("REPLAYS a write whose context has not moved", async () => {
    // The mirror failure, and the more damaging one: refusing valid work.
    seed({ id: "mut_ok", contextEpoch: "ce1-stable" } as never);
    observeContextEpoch("ce1-stable");

    const replay = vi.fn(async (m: OfflineMutation) => {
      writeOfflineQueue(readOfflineQueue().filter((q) => q.id !== m.id));
      return "replayed" as const;
    });
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });

  it("replays a write that predates the field", async () => {
    // A record persisted by an older build carries no epoch. Refusing it would
    // discard work for a context that may not have changed at all.
    seed({ id: "mut_legacy" });
    observeContextEpoch("ce1-current");

    const replay = vi.fn(async (m: OfflineMutation) => {
      writeOfflineQueue(readOfflineQueue().filter((q) => q.id !== m.id));
      return "replayed" as const;
    });
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });

  it("replays when this launch has not yet seen an epoch", async () => {
    // Cold start, still offline. Treating "not yet known" as "changed" would
    // dead-letter the entire queue on every launch — the exact work the queue
    // exists to protect.
    seed({ id: "mut_coldstart", contextEpoch: "ce1-from-last-session" } as never);

    const replay = vi.fn(async (m: OfflineMutation) => {
      writeOfflineQueue(readOfflineQueue().filter((q) => q.id !== m.id));
      return "replayed" as const;
    });
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay, "'not yet known' was treated as 'changed'").toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });
});

describe("desktop drops a cache built under another context", () => {
  function memStore() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }
  const KEY = "postwave.desktop.cache-epoch.v1";

  it("does not clear on the first sighting of a launch", () => {
    let cleared = 0;
    subscribeContextEpochCacheReset({ clear: () => (cleared += 1) }, memStore());
    observeContextEpoch("ce1-first");
    expect(cleared, "the cache was wiped on a normal launch").toBe(0);
  });

  it("clears when the epoch moves mid-launch", () => {
    let cleared = 0;
    subscribeContextEpochCacheReset({ clear: () => (cleared += 1) }, memStore());
    observeContextEpoch("ce1-first");
    observeContextEpoch("ce1-second");
    expect(cleared).toBe(1);
  });

  it("clears a REHYDRATED cache built before a demotion", () => {
    // THE CASE A MOVE-ONLY LISTENER CANNOT CATCH, and desktop's is the worst
    // version: the app is quit for the night, an admin demotes the user, and on
    // relaunch an 8-hour persisted cache rehydrates under a buster
    // (version:user:tenant) that a role change leaves byte-identical.
    const store = memStore();
    store.setItem(KEY, "ce1-before-demotion");
    let cleared = 0;
    subscribeContextEpochCacheReset({ clear: () => (cleared += 1) }, store);
    observeContextEpoch("ce1-after-demotion");
    expect(cleared, "a pre-demotion cache survived the relaunch").toBe(1);
  });

  it("keeps a rehydrated cache built under the SAME context", () => {
    // The mirror failure: clearing here discards a valid 8-hour cache on every
    // launch, which is the offline-first behaviour desktop exists for.
    const store = memStore();
    store.setItem(KEY, "ce1-same");
    let cleared = 0;
    subscribeContextEpochCacheReset({ clear: () => (cleared += 1) }, store);
    observeContextEpoch("ce1-same");
    expect(cleared).toBe(0);
  });

  it("records provenance for the next launch", () => {
    const store = memStore();
    subscribeContextEpochCacheReset({ clear: () => undefined }, store);
    observeContextEpoch("ce1-recorded");
    expect(store.getItem(KEY)).toBe("ce1-recorded");
  });
});
