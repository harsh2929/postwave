// @vitest-environment happy-dom
//
// Web's adoption of the context epoch, driven through the REAL paths.
//
// The rule (`isStaleContext`) and the header (`X-Postwave-Context-Epoch`) both
// existed with nothing connecting them: the server had zero callers of
// `WriteContextEpoch`, and no client read the header. This asserts the three
// links that make it work — observe on a response, stamp at enqueue, refuse at
// replay — by calling `enqueueOfflineMutation` and `drainOutbox` themselves,
// because a test of the rule cannot tell whether anything consults it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  observeContextEpoch,
  onContextEpochChange,
  readContextEpoch,
  resetContextEpoch,
  subscribeContextEpochCacheReset,
} from "../../lib/context-epoch";
import {
  enqueueOfflineMutation,
  readOfflineQueue,
  setOfflineStorageIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox, listDeadLetter } from "../../lib/outbox";
import { clearTombstones } from "../../lib/tombstones";

beforeEach(() => {
  window.localStorage.clear();
  clearTombstones();
  resetContextEpoch();
  setOfflineStorageIdentity("user-1", "tenant-1");
  // The store keeps an IN-MEMORY queue alongside localStorage, and
  // `enqueueOfflineMutation` appends to it. Clearing storage alone leaves the
  // previous test's items in place — which showed up as one test's epoch
  // appearing in the next, and as drains replaying items a later test never
  // queued. Dead-lettered items live in this same queue, so this resets both.
  writeOfflineQueue([]);
  expect(readOfflineQueue(), "the queue did not reset between tests").toHaveLength(0);
});

/** A queueable write — web's store allowlists only forms and segments. */
function queueAForm() {
  return enqueueOfflineMutation({
    method: "PATCH",
    path: "/api/v1/forms/f-1",
    body: { name: "Ada" },
  });
}

describe("observing the epoch", () => {
  it("records the value the server sent", () => {
    observeContextEpoch("ce1-abc123");
    expect(readContextEpoch()).toBe("ce1-abc123");
  });

  it("treats the FIRST value as a baseline, not a change", () => {
    // At boot every response is the first one. Reporting a change here would
    // clear the cache on every page load — a correctness mechanism that
    // presents as a performance bug.
    const changed = observeContextEpoch("ce1-abc123");
    expect(changed).toBe(false);
  });

  it("reports a change when the value moves, and notifies listeners", () => {
    observeContextEpoch("ce1-old");
    const seen: string[] = [];
    onContextEpochChange((e) => seen.push(e));

    expect(observeContextEpoch("ce1-new")).toBe(true);
    expect(seen).toEqual(["ce1-new"]);
  });

  it("does not report a change when the same value arrives again", () => {
    observeContextEpoch("ce1-same");
    expect(observeContextEpoch("ce1-same")).toBe(false);
  });

  it("ignores a missing header rather than treating it as a change", () => {
    // Unauthenticated responses carry no epoch by design. Clearing on one would
    // discard a live context every time the app fetched a public endpoint.
    observeContextEpoch("ce1-live");
    expect(observeContextEpoch(null)).toBe(false);
    expect(observeContextEpoch("")).toBe(false);
    expect(readContextEpoch(), "a public response wiped the live context").toBe("ce1-live");
  });
});

describe("stamping the epoch on a queued write", () => {
  it("records the context the write was MADE in", () => {
    observeContextEpoch("ce1-atqueue");
    queueAForm();

    const [stored] = readOfflineQueue();
    expect(stored?.contextEpoch, "the queued write carries no context").toBe("ce1-atqueue");
  });

  it("survives the store's sanitizer", () => {
    // A field the sanitizer does not explicitly preserve is DROPPED on the way
    // to storage. That is not hypothetical: it is exactly how the tombstone
    // rule spent its whole life returning false for every web mutation.
    observeContextEpoch("ce1-persisted");
    queueAForm();

    const roundTripped = readOfflineQueue()[0];
    expect(roundTripped?.contextEpoch).toBe("ce1-persisted");
  });

  it("queues without an epoch when none has been seen yet", () => {
    // Queued before any response arrived — offline from boot. The write must
    // still be queued; it simply cannot be judged later.
    queueAForm();
    expect(readOfflineQueue()).toHaveLength(1);
    expect(readOfflineQueue()[0]?.contextEpoch).toBeUndefined();
  });
});

describe("refusing a write whose context has moved", () => {
  it("does not replay it, and parks it for the person", async () => {
    observeContextEpoch("ce1-when-queued");
    queueAForm();
    observeContextEpoch("ce1-after-demotion");

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(
      replay,
      "the write replayed as the person they are NOW, not the person who queued it",
    ).not.toHaveBeenCalled();
    expect(totals.staleContext).toBe(1);
    // Surfaced rather than silently dropped: it is their work, and only they
    // can decide whether it still applies.
    expect(listDeadLetter().map((i) => i.id)).toHaveLength(1);
  });

  it("REPLAYS a write whose context has not moved", async () => {
    // The mirror failure, and the more damaging one: refusing valid work.
    observeContextEpoch("ce1-stable");
    queueAForm();

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });

  it("replays a write queued before the client had ever seen an epoch", async () => {
    // Both sides must be known to compare. Refusing on a missing value would
    // discard the entire queue on every cold start — the exact work the queue
    // exists to protect.
    queueAForm();
    observeContextEpoch("ce1-learned-later");

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });

  it("replays when the client has no current epoch to compare against", async () => {
    observeContextEpoch("ce1-when-queued");
    queueAForm();
    resetContextEpoch();

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(replay, "'not yet known' was treated as 'changed'").toHaveBeenCalledTimes(1);
    expect(totals.staleContext).toBe(0);
  });

  it("does not burn the attempt budget retrying something retrying cannot fix", async () => {
    observeContextEpoch("ce1-a");
    queueAForm();
    observeContextEpoch("ce1-b");

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    await drainOutbox(replay);
    const totals = await drainOutbox(replay);

    // Already parked on the first pass; the second sees a dead-letter, not a
    // fresh stale item to count again.
    expect(replay).not.toHaveBeenCalled();
    expect(totals.staleContext).toBe(0);
  });
});

describe("dropping the cache when the context moves", () => {
  /** An isolated store per test, so one case cannot inherit another's provenance. */
  function memStore() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("does not clear on the first sighting of a session", () => {
    // At boot every response is the first. Clearing here would wipe the cache
    // on every page load — a correctness mechanism presenting as a bug.
    const cleared: string[] = [];
    const store = memStore();
    subscribeContextEpochCacheReset(
      { clear: () => cleared.push("clear") },
      () => cleared.push("persister"),
      store,
    );
    observeContextEpoch("ce1-first");
    expect(cleared).toEqual([]);
  });

  it("clears when the epoch moves mid-session", () => {
    const cleared: string[] = [];
    const store = memStore();
    subscribeContextEpochCacheReset(
      { clear: () => cleared.push("clear") },
      () => cleared.push("persister"),
      store,
    );
    observeContextEpoch("ce1-first");
    observeContextEpoch("ce1-second");
    expect(cleared).toEqual(["clear", "persister"]);
  });

  it("clears a REHYDRATED cache built under a different context", () => {
    // THE CASE THE MOVE-ONLY LISTENER COULD NOT CATCH. The tab was closed while
    // an admin demoted the user. On reload the buster (version:user:tenant) is
    // byte-identical, so the pre-demotion cache rehydrates and paints, and the
    // first response of the new session is a FIRST SIGHTING — not a move.
    const store = memStore();
    store.setItem("postwave.web.cache-epoch.v1", "ce1-before-demotion");

    const cleared: string[] = [];
    subscribeContextEpochCacheReset(
      { clear: () => cleared.push("clear") },
      undefined,
      store,
    );
    observeContextEpoch("ce1-after-demotion");

    expect(cleared, "a cache from before the demotion survived the reload").toEqual(["clear"]);
  });

  it("keeps a rehydrated cache built under the SAME context", () => {
    // The mirror failure: clearing here throws away a valid cache on every
    // reload, which is a performance regression with no safety gain.
    const store = memStore();
    store.setItem("postwave.web.cache-epoch.v1", "ce1-same");

    const cleared: string[] = [];
    subscribeContextEpochCacheReset({ clear: () => cleared.push("clear") }, undefined, store);
    observeContextEpoch("ce1-same");

    expect(cleared).toEqual([]);
  });

  it("records provenance so the NEXT launch can be judged", () => {
    const store = memStore();
    subscribeContextEpochCacheReset({ clear: () => undefined }, undefined, store);
    observeContextEpoch("ce1-recorded");
    expect(store.getItem("postwave.web.cache-epoch.v1")).toBe("ce1-recorded");
  });

  it("stops clearing once unsubscribed", () => {
    // The provider rebuilds its client when the server-resolved identity
    // changes. A subscription left behind would clear a client nobody uses.
    const cleared: string[] = [];
    const store = memStore();
    const unsubscribe = subscribeContextEpochCacheReset(
      { clear: () => cleared.push("clear") },
      undefined,
      store,
    );
    observeContextEpoch("ce1-a");
    unsubscribe();
    observeContextEpoch("ce1-b");
    expect(cleared).toEqual([]);
  });
});
