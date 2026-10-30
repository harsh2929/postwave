// SPDX-License-Identifier: AGPL-3.0-only
//
// Persisting a topic reorder, extracted so the partial-failure path is
// testable.
//
// The previous inline version fanned the PATCHes out with `Promise.all` and, in
// the catch, rolled the local cache back to the pre-drag order and reported
// "Reorder failed." `Promise.all` rejects on the FIRST rejection while the
// other requests may already have committed, so a partial failure left the
// server holding a mix of old and new positions while the UI showed the old
// order and claimed nothing had happened — an order that existed nowhere.
//
// Rolling back is only honest when nothing was written. Otherwise the only
// truthful move is to re-read the server.

import type { Topic } from "@/lib/preferences-api";

export interface ReorderDeps {
  /** PATCH one topic's displayOrder. */
  update: (id: string, patch: { displayOrder: number }) => Promise<unknown>;
  /** Write the optimistic order into the cache. */
  setCache: (topics: Topic[]) => void;
  /** Re-read from the server (used whenever the server may have changed). */
  resync: () => void;
  onError: (message: string) => void;
}

export interface ReorderOutcome {
  /** Topics whose position actually moved. */
  attempted: number;
  failed: number;
  /** True when the cache was restored because nothing reached the server. */
  rolledBack: boolean;
}

/** Renumber to array order and return only the topics whose position changed. */
export function changedTopics(next: Topic[], previous: Topic[]): Topic[] {
  return next
    .map((t, i) => ({ ...t, displayOrder: i }))
    .filter((t) => {
      const before = previous.find((p) => p.id === t.id);
      return before !== undefined && before.displayOrder !== t.displayOrder;
    });
}

export async function commitTopicOrder(
  next: Topic[],
  previous: Topic[],
  deps: ReorderDeps,
): Promise<ReorderOutcome> {
  const renumbered = next.map((t, i) => ({ ...t, displayOrder: i }));
  deps.setCache(renumbered);

  const changed = changedTopics(next, previous);
  if (changed.length === 0) {
    return { attempted: 0, failed: 0, rolledBack: false };
  }

  const results = await Promise.allSettled(
    changed.map((t) => deps.update(t.id, { displayOrder: t.displayOrder })),
  );
  const failed = results.filter((r) => r.status === "rejected").length;

  if (failed === 0) {
    deps.resync();
    return { attempted: changed.length, failed: 0, rolledBack: false };
  }

  if (failed === changed.length) {
    // Nothing landed — the pre-drag order is still the truth, so restoring it
    // is accurate and spares a round-trip.
    deps.setCache(previous);
    deps.onError("Reorder failed.");
    return { attempted: changed.length, failed, rolledBack: true };
  }

  // Partial: the server holds a mix. Never guess — re-read it.
  deps.resync();
  deps.onError(
    `${failed} of ${changed.length} topics could not be reordered. The saved order has been reloaded.`,
  );
  return { attempted: changed.length, failed, rolledBack: false };
}
