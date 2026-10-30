// @vitest-environment happy-dom
//
// Web's replay engine, run against the SHARED conformance fixture.
//
// The rules already live in `@postwave/offline-outbox`, and the package tests
// them thoroughly — by calling them directly, with well-formed arguments. That
// certifies the rule and says nothing about this engine: `drainOutbox` could
// pass the wrong field, drop the answer on the floor, or park a bucket it
// should have skipped, and every one of those tests would stay green.
//
// So this drives `drainOutbox` — the real function the app calls — and asserts
// on both the totals and WHICH ITEMS WERE SENT. The second half is the one that
// catches ordering bugs: totals alone cannot tell "the bucket parked" from "the
// bucket carried on and the later writes happened to succeed".
//
// BOUND TO forms/segments. Web's store allowlists only those two, and quietly
// REWRITES anything else — status becomes `failed`, `resource` is dropped — so
// a fixture using subscribers would be asserting against mangled items. The
// first draft of this file did exactly that and passed.

import {
  conformanceCases,
  failureScenarios,
  partitionByShape,
  scriptedReplay,
  SHAPES_NO_ENGINE_QUEUES,
  type ConformanceBinding,
} from "@postwave/offline-outbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isQueueableMutation,
  readOfflineQueue,
  setOfflineStorageIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox } from "../../lib/outbox";
import { clearTombstones, recordTombstone } from "../../lib/tombstones";

/** The two resources web will actually queue. */
const BINDING: ConformanceBinding = { resource: "forms", otherResource: "segments" };

beforeEach(() => {
  window.localStorage.clear();
  clearTombstones();
  // The queue is identity-scoped: an unbound store reads back EMPTY, so every
  // assertion below would pass against a queue that was never seeded.
  setOfflineStorageIdentity("user-1", "tenant-1");
});

/**
 * Seeds through the store's own writer, then proves the store KEPT what we wrote.
 *
 * Checking the count alone is not enough, and that is not a theoretical worry:
 * the store accepts an item it considers unqueueable but rewrites its status to
 * `failed` and strips `resource`, so the length matches while the fixture is
 * gone. Every field the assertions depend on is verified here.
 */
function seed(items: Array<Record<string, unknown>>): void {
  writeOfflineQueue(items as never);
  const stored = readOfflineQueue() as unknown as Array<Record<string, unknown>>;
  expect(stored.length, "the store dropped seeded items").toBe(items.length);
  for (const want of items) {
    const got = stored.find((s) => s["id"] === want["id"]);
    expect(got, `item ${String(want["id"])} was not stored`).toBeDefined();
    for (const field of ["status", "resource", "method", "path", "queuedAt"] as const) {
      expect(
        got?.[field],
        `the store rewrote ${field} on ${String(want["id"])} — the assertions ` +
          `below would run against a mangled fixture`,
      ).toBe(want[field]);
    }
  }
}

describe("web conformance: tombstone suppression", () => {
  const cases = conformanceCases(Date.now(), BINDING);
  const { runnable, skippedShapes } = partitionByShape(cases, (method, path) =>
    isQueueableMutation(method, path),
  );

  it("skips exactly the shapes web's allowlist cannot express, and no others", () => {
    // Not a ">= 4" floor. A floor set below the real count is not a guard: a
    // case can vanish — allowlist tweak, binding typo, fixture rename — and the
    // suite stays green while quietly covering less. Naming the skipped SHAPES
    // and the exact runnable count makes any such drift fail here.
    expect(skippedShapes).toEqual(SHAPES_NO_ENGINE_QUEUES);
    expect(runnable.length, "the runnable set changed size").toBe(
      cases.length - SHAPES_NO_ENGINE_QUEUES.length,
    );
  });

  for (const c of runnable) {
    it(`${c.name} → ${c.suppressed ? "dropped" : "sent"}`, async () => {
      seed([
        {
          id: "m1",
          idempotencyKey: "idem-m1",
          body: { name: "Ada" },
          attempts: 0,
          status: "pending",
          method: c.mutation.method,
          path: c.mutation.path,
          resource: c.mutation.resource,
          queuedAt: c.mutation.queuedAt,
        },
      ]);
      for (const t of c.tombstones) {
        recordTombstone(t.resource, t.id, Date.parse(t.deletedAt));
      }

      const replay = vi.fn().mockResolvedValue("replayed" as const);
      const totals = await drainOutbox(replay);

      expect(replay.mock.calls.length === 0, c.why).toBe(c.suppressed);
      expect(totals.suppressed, c.why).toBe(c.suppressed ? 1 : 0);
    });
  }
});

describe("web conformance: injected replay failure", () => {
  for (const scenario of failureScenarios(Date.now(), BINDING)) {
    it(scenario.name, async () => {
      seed(scenario.queue.map((q) => ({ ...q, body: { name: "Ada" } })));
      for (const t of scenario.tombstones) {
        recordTombstone(t.resource, t.id, Date.parse(t.deletedAt));
      }

      const { replay, attempted } = scriptedReplay(scenario);
      const totals = await drainOutbox(replay as never);

      expect(totals.replayed, scenario.why).toBe(scenario.expect.replayed);
      expect(totals.conflicts, scenario.why).toBe(scenario.expect.conflicts);
      expect(totals.failed, scenario.why).toBe(scenario.expect.failed);
      expect(totals.suppressed, scenario.why).toBe(scenario.expect.suppressed);
      // Exact, and sorted because buckets drain concurrently so cross-bucket
      // order is not defined. Independent of the totals above: this is what
      // catches an item sent that should have been parked, an item skipped
      // that should have been sent, and an engine that replays one item more
      // than once.
      expect([...attempted].sort(), scenario.why).toEqual([...scenario.expect.attempted].sort());
    });
  }
});
