import { webcrypto } from "node:crypto";

import {
  conformanceCases,
  failureScenarios,
  partitionByShape,
  scriptedReplay,
  SHAPES_NO_ENGINE_QUEUES,
  type ConformanceBinding,
} from "@postwave/offline-outbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type OfflineMutation,
  clearOfflineStores,
  isQueueableMutation,
  offlineQueueIdle,
  readOfflineQueue,
  setOfflineIdentity,
  writeOfflineQueue,
} from "../../lib/offline-store";
import { drainOutbox } from "../../lib/outbox";
import { clearTombstones, recordTombstone } from "../../lib/tombstones";

/**
 * Desktop's replay engine, run against the SHARED conformance fixture.
 *
 * The rules live in `@postwave/offline-outbox` and that package tests them by
 * calling them directly with well-formed arguments — which certifies the rule
 * and says nothing about this engine. `drainOutbox` could pass the wrong field,
 * ignore the answer, or park a bucket it should have skipped, and every one of
 * those tests would stay green.
 *
 * This drives the real `drainOutbox` and asserts on the totals AND on which
 * items were actually sent. The second half is what catches ordering bugs:
 * totals alone cannot tell "the bucket parked" from "the bucket carried on and
 * the later writes happened to succeed".
 *
 * Bound to forms/segments deliberately. Both surfaces allowlist them, so
 * desktop and web run the SAME fixture against the same shapes and a divergence
 * shows up as one suite failing where the other passes — which is the entire
 * point of a conformance fixture, and impossible if each binds to resources the
 * other refuses to queue.
 */

const BINDING: ConformanceBinding = { resource: "forms", otherResource: "segments" };

/** Desktop's store reads window.localStorage and crypto; neither exists in node. */
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

/**
 * Seeds through the store's own writer, then proves the store KEPT what we wrote.
 *
 * Count alone is not enough: a store that considers an item unqueueable may
 * retain it while rewriting its status and dropping `resource`, leaving the
 * length correct and the fixture gone. Web's store does exactly that, which is
 * how the first draft of this suite passed against mangled items.
 */
function seed(items: Array<Record<string, unknown>>): void {
  writeOfflineQueue(items as unknown as OfflineMutation[]);
  const stored = readOfflineQueue() as unknown as Array<Record<string, unknown>>;
  expect(stored.length, "the store dropped seeded items").toBe(items.length);
  for (const want of items) {
    const got = stored.find((s) => s["id"] === want["id"]);
    expect(got, `item ${String(want["id"])} was not stored`).toBeDefined();
    for (const field of ["status", "method", "path", "queuedAt"] as const) {
      expect(
        got?.[field],
        `the store rewrote ${field} on ${String(want["id"])} — the assertions ` +
          `below would run against a mangled fixture`,
      ).toBe(want[field]);
    }
  }
}

describe("desktop conformance: tombstone suppression", () => {
  const cases = conformanceCases(Date.now(), BINDING);
  const { runnable, skippedShapes } = partitionByShape(cases, (method, path) =>
    isQueueableMutation(method, path, { name: "Edit" }),
  );

  it("skips exactly the shapes desktop's allowlist cannot express, and no others", () => {
    // Asserting the same constant web asserts is what keeps the two suites
    // running the SAME set. Each filters independently, so without this one
    // could run four cases and the other five, and both would still call
    // themselves conformant.
    expect(skippedShapes).toEqual(SHAPES_NO_ENGINE_QUEUES);
    expect(runnable.length, "the runnable set changed size").toBe(
      cases.length - SHAPES_NO_ENGINE_QUEUES.length,
    );
  });

  for (const c of runnable) {
    it(`${c.name} → ${c.suppressed ? "dropped" : "sent"}`, async () => {
      seed([
        {
          id: "mut_1",
          idempotencyKey: "idem_mut_1",
          body: { name: "Edit" },
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

      const replay = vi.fn(async (m: OfflineMutation) => {
        // Mirror a real successful replay: the engine re-reads the journal
        // between items, and an item left behind after success would be
        // re-attempted by a later pass.
        writeOfflineQueue(readOfflineQueue().filter((q) => q.id !== m.id));
        return "replayed" as const;
      });
      const totals = await drainOutbox(replay, { retryDelay: () => 0 });

      expect(replay.mock.calls.length === 0, c.why).toBe(c.suppressed);
      expect(totals.suppressed, c.why).toBe(c.suppressed ? 1 : 0);
    });
  }
});

describe("desktop conformance: injected replay failure", () => {
  for (const scenario of failureScenarios(Date.now(), BINDING)) {
    it(scenario.name, async () => {
      seed(scenario.queue.map((q) => ({ ...q, body: { name: "Edit" } })));
      for (const t of scenario.tombstones) {
        recordTombstone(t.resource, t.id, Date.parse(t.deletedAt));
      }

      const { replay, attempted } = scriptedReplay(scenario);
      const totals = await drainOutbox(
        replay as unknown as (
          item: OfflineMutation,
        ) => Promise<"replayed" | "conflict" | "failed">,
        { retryDelay: () => 0 },
      );

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
