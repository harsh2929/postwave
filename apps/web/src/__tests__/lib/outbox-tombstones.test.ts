// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setOfflineStorageIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox } from "../../lib/outbox";
import { clearTombstones, recordTombstone } from "../../lib/tombstones";

/**
 * A queued write must not resurrect a record the user deleted.
 *
 * `@postwave/offline-outbox` has owned this rule — and a conformance test for
 * it — since it was written, and NO replay engine called it. Every surface
 * queues writes while offline and replays them on reconnect, and none asked
 * whether the target still existed. Delete a subscriber on a laptop; a tab that
 * queued an edit for that subscriber before the delete recreates it on the next
 * drain. Under an erasure request, that is a record returning after a
 * documented deletion.
 */

function queue(items: unknown[]): void {
  // Through the store's own writer: the queue is identity-scoped and
  // TTL-bounded, so a hand-written localStorage key is read back as empty and
  // every assertion below would pass vacuously.
  writeOfflineQueue(items as never);
}

/**
 * Two hours ago, as an ISO STRING. The store's sanitizer parses `queuedAt` as a
 * timestamp string; a number fails the parse and is silently replaced with now,
 * which also trips the replayability check — so a numeric fixture tests the
 * expiry path rather than the tombstone rule.
 */
const QUEUED_AT = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
/** One hour ago: deleted AFTER the edit above was queued. */
const DELETED_AT = Date.now() - 60 * 60_000;

function mutation(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    method: "PATCH",
    path: "/api/v1/subscribers/sub-1",
    resource: "subscribers",
    body: { first_name: "Ada" },
    // Inside the queue's 4h TTL. A backdated timestamp is clamped to now and
    // the item is marked "no longer replayable", so an out-of-window fixture
    // tests the expiry path rather than the tombstone rule.
    queuedAt: QUEUED_AT,
    attempts: 0,
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  clearTombstones();
  // The queue is identity-scoped — an unbound store reads back empty, and every
  // assertion below would pass vacuously.
  setOfflineStorageIdentity("user-1", "tenant-1");
});

describe("a deleted target's queued edits are dropped", () => {
  it("does not replay an edit queued before the delete", async () => {
    queue([mutation()]);
    recordTombstone("subscribers", "sub-1", DELETED_AT);

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(replay, "the edit was replayed and recreated the record").not.toHaveBeenCalled();
    expect(totals.suppressed).toBe(1);
    expect(totals.replayed).toBe(0);
  });

  it("DOES replay an edit queued after the delete", async () => {
    // The mirror failure, and the harder one to notice: a write queued after a
    // deletion is a deliberate recreation, and discarding it would silently
    // drop something the user is looking straight at.
    queue([
      // Queued AFTER the delete: a deliberate recreation.
      mutation({ queuedAt: new Date(Date.now() - 30 * 60_000).toISOString() }),
    ]);
    recordTombstone("subscribers", "sub-1", DELETED_AT);

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals.suppressed).toBe(0);
  });

  it("leaves a collection-level write alone", async () => {
    // `/api/v1/subscribers` targets no record. Suppressing it would drop a new
    // signup that has nothing to do with the deleted row.
    queue([
      mutation({ method: "POST", path: "/api/v1/subscribers", id: "m2" }),
    ]);
    recordTombstone("subscribers", "sub-1", DELETED_AT);

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    await drainOutbox(replay);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("does not park the rest of the bucket", async () => {
    // A suppressed item has nothing to resolve and no later drain that makes it
    // replayable, so it must be discarded rather than block the FIFO behind it.
    queue([
      mutation(),
      mutation({ id: "m2", path: "/api/v1/subscribers/sub-2" }),
    ]);
    recordTombstone("subscribers", "sub-1", DELETED_AT);

    const replay = vi.fn().mockResolvedValue("replayed" as const);
    const totals = await drainOutbox(replay);

    expect(totals.suppressed).toBe(1);
    expect(totals.replayed).toBe(1);
  });
});
