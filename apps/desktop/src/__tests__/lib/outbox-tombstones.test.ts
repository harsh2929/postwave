import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type OfflineMutation,
  clearOfflineStores,
  offlineQueueIdle,
  readOfflineQueue,
  setOfflineIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox } from "../../lib/outbox";
import { clearTombstones, recordTombstone } from "../../lib/tombstones";

/**
 * A queued write must not resurrect a record the user deleted.
 *
 * `@postwave/offline-outbox` has owned this rule, with a conformance test, since
 * it was written — and no replay engine called it. Delete a form on the web app;
 * a desktop window that queued an edit for that form before the delete recreates
 * it on the next drain. The user performed a deletion, watched it succeed, and a
 * write they had forgotten about undoes it.
 */

const QUEUED_AT = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const DELETED_AT = Date.now() - 60 * 60_000;

function item(over: Partial<OfflineMutation> & { id: string }): OfflineMutation {
  return {
    method: "PATCH",
    path: "/api/v1/forms/form_1",
    body: { name: "Edit" },
    idempotencyKey: `idem_${over.id}`,
    queuedAt: QUEUED_AT,
    attempts: 0,
    status: "pending",
    ...over,
  } as OfflineMutation;
}

// Same harness as outbox.test.ts: desktop's store reads window.localStorage and
// crypto, neither of which exists in the node environment these run in.
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
});

afterEach(async () => {
  await clearOfflineStores();
  await offlineQueueIdle();
  vi.unstubAllGlobals();
});

describe("desktop replay respects deletions", () => {
  it("drops an edit queued before the delete", async () => {
    writeOfflineQueue([item({ id: "mut_1" })]);
    recordTombstone("forms", "form_1", DELETED_AT);

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay, "the edit replayed and recreated the record").not.toHaveBeenCalled();
    expect(totals.suppressed).toBe(1);
    expect(readOfflineQueue()).toHaveLength(0);
  });

  it("keeps an edit queued after the delete", async () => {
    // A write queued after a deletion is a deliberate recreation. Dropping it
    // would be the mirror failure, and harder to notice — the user is looking
    // straight at the thing they just made.
    writeOfflineQueue([
      item({ id: "mut_2", queuedAt: new Date(Date.now() - 30 * 60_000).toISOString() }),
    ]);
    recordTombstone("forms", "form_1", DELETED_AT);

    const replay = vi.fn(async (m: OfflineMutation) => {
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== m.id));
      return "replayed" as const;
    });
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.suppressed).toBe(0);
  });

  it("does not strand the rest of the bucket", async () => {
    writeOfflineQueue([
      item({ id: "mut_3" }),
      item({ id: "mut_4", path: "/api/v1/forms/form_2" }),
    ]);
    recordTombstone("forms", "form_1", DELETED_AT);

    const replay = vi.fn(async (m: OfflineMutation) => {
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== m.id));
      return "replayed" as const;
    });
    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(totals.suppressed).toBe(1);
    expect(totals.replayed).toBe(1);
  });
});
