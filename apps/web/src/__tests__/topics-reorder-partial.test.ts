// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression: reordering preference topics fanned the PATCHes out with
// `Promise.all` and, on rejection, restored the pre-drag order in the cache and
// reported "Reorder failed."
//
// `Promise.all` rejects on the FIRST rejection while the remaining requests may
// already have committed. So dragging five topics with two failures left three
// persisted server-side, the UI showing the ORIGINAL order, and a message
// saying nothing happened — a state that existed in neither place. Nothing
// re-read the server afterwards, so the lie survived until an unrelated
// invalidation.
//
// Rolling back is only truthful when nothing was written.
import { describe, expect, it, vi } from "vitest";

import {
  changedTopics,
  commitTopicOrder,
} from "@/app/(dashboard)/app/settings/topics/reorder";
import type { Topic } from "@/lib/preferences-api";

const topic = (id: string, displayOrder: number): Topic =>
  ({
    id,
    tenantId: "t1",
    slug: id,
    name: id,
    description: "",
    defaultOptIn: true,
    displayOrder,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }) as Topic;

const PREVIOUS = [topic("a", 0), topic("b", 1), topic("c", 2)];
// Drag "c" to the front: every topic moves.
const NEXT = [topic("c", 2), topic("a", 0), topic("b", 1)];

function deps(update: ReorderUpdate) {
  const calls = { setCache: [] as Topic[][], resync: 0, errors: [] as string[] };
  return {
    calls,
    deps: {
      update,
      setCache: (t: Topic[]) => calls.setCache.push(t),
      resync: () => {
        calls.resync += 1;
      },
      onError: (m: string) => calls.errors.push(m),
    },
  };
}
type ReorderUpdate = (
  id: string,
  patch: { displayOrder: number },
) => Promise<unknown>;

describe("changedTopics", () => {
  it("returns only topics whose position moved, renumbered to array order", () => {
    const changed = changedTopics(NEXT, PREVIOUS);
    expect(changed.map((t) => [t.id, t.displayOrder])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("returns nothing when the order is unchanged", () => {
    expect(changedTopics(PREVIOUS, PREVIOUS)).toEqual([]);
  });
});

describe("commitTopicOrder", () => {
  it("persists every moved topic and resyncs on success", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const { calls, deps: d } = deps(update);

    const out = await commitTopicOrder(NEXT, PREVIOUS, d);

    expect(update).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ attempted: 3, failed: 0, rolledBack: false });
    expect(calls.errors).toEqual([]);
    expect(calls.resync).toBe(1);
  });

  it("does NOT roll back when only some writes failed", async () => {
    // "a" fails; "c" and "b" commit. The server now holds a mix.
    const update = vi.fn(async (id: string) => {
      if (id === "a") throw new Error("500");
    });
    const { calls, deps: d } = deps(update);

    const out = await commitTopicOrder(NEXT, PREVIOUS, d);

    // Every write is attempted — not abandoned at the first rejection.
    expect(update).toHaveBeenCalledTimes(3);
    expect(out.failed).toBe(1);
    expect(out.rolledBack).toBe(false);

    // The only cache write is the optimistic one; the pre-drag order must NOT
    // be restored over a server that partly accepted the change.
    expect(calls.setCache).toHaveLength(1);
    expect(calls.setCache[0]!.map((t) => t.id)).toEqual(["c", "a", "b"]);

    // And the truth is re-read rather than guessed.
    expect(calls.resync).toBe(1);
    expect(calls.errors[0]).toMatch(/1 of 3/);
  });

  it("rolls back only when nothing reached the server", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    const { calls, deps: d } = deps(update);

    const out = await commitTopicOrder(NEXT, PREVIOUS, d);

    expect(out).toEqual({ attempted: 3, failed: 3, rolledBack: true });
    // Optimistic write, then the restore — the pre-drag order is still true.
    expect(calls.setCache).toHaveLength(2);
    expect(calls.setCache[1]!.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(calls.resync).toBe(0);
    expect(calls.errors).toEqual(["Reorder failed."]);
  });

  it("writes nothing when the order did not change", async () => {
    const update = vi.fn();
    const { calls, deps: d } = deps(update);

    const out = await commitTopicOrder(PREVIOUS, PREVIOUS, d);

    expect(update).not.toHaveBeenCalled();
    expect(out.attempted).toBe(0);
    expect(calls.resync).toBe(0);
  });
});
