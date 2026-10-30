/**
 * IDB-backed mutation outbox.
 *
 * Layers on top of offline-store.ts (the canonical queue) and adds:
 *   - FIFO ordering (resource-wide by default, subscriber-record-specific)
 *     with independent buckets drained concurrently.
 *   - Per-item attempt budget (OUTBOX_MAX_ATTEMPTS = 6) with decorrelated
 *     jitter between attempts.
 *   - Dead-letter bucket for items that exhaust their attempt budget.
 *   - TanStack Query v5 mutation defaults wiring per resource so caller
 *     mutations get the same retry/backoff policy without each call site
 *     restating it.
 *
 * The Idempotency-Key minted in Feature 6 stays stable across enqueue →
 * replay → server-side dedup, so expanding the allowlist is safe — every
 * retry hits the same dedup row on the server.
 */

import {
  isStaleContext,
  isSuppressedByTombstone,
  STALE_CONTEXT_MESSAGE,
} from "@postwave/offline-outbox";

import { readContextEpoch } from "./context-epoch";

import { readTombstones } from "./tombstones";

import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { isDeadLetter, isTerminalStatus } from "@postwave/offline-outbox";

import {
  OUTBOX_MAX_ATTEMPTS,
  getOfflinePersistenceError,
  type OfflineJournalEntry,
  type OfflineMutation,
  readOfflineQueue,
  readOfflineJournal,
  removeOfflineJournalEntry,
  offlineMutationOrderingKey,
  resolveOfflineMutation,
  resolveOfflineMutationDurably,
  subscribeOfflineQueue,
  updateOfflineMutation,
  writeOfflineQueue,
} from "./offline-store";

/** Resource buckets that get a tuned retry/backoff default. */
export const OUTBOX_RESOURCES = [
  "campaigns",
  "subscribers",
  "segments",
  "templates",
  "lists",
  "tags",
  "forms",
] as const;
export type OutboxResource = (typeof OUTBOX_RESOURCES)[number];

const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 10_000;

/**
 * Decorrelated jitter backoff — same shape as httpFetch's, exported here
 * so TanStack Query mutation `retryDelay` can use it from any call site.
 *
 *   next = min(cap, randomBetween(base, prev * 3))
 */
export function decorrelatedJitter(
  base: number = BASE_BACKOFF_MS,
  cap: number = MAX_BACKOFF_MS,
): (failureCount: number, _err: unknown) => number {
  // Closure over `prev` so successive calls within a mutation observe
  // the AWS-style cascade rather than re-rolling from `base` each time.
  let prev = base;
  return (failureCount: number): number => {
    const lower = base;
    const upper = Math.min(cap, Math.max(prev, base) * 3);
    const span = Math.max(0, upper - lower);
    const next = Math.floor(lower + Math.random() * span);
    prev = next;
    // failureCount unused but kept in the signature TanStack Query
    // expects.
    void failureCount;
    return next;
  };
}

/**
 * Mid-drain backoff: honor a server Retry-After (ms) from the failed
 * attempt when present, clamped to the same ceiling httpFetch uses so a
 * long/hostile value can't stall a bucket drain (the item still retries
 * on a later drain). Falls back to the decorrelated jitter otherwise.
 */
export function effectiveReplayDelay(
  jitterMs: number,
  retryAfterMs?: number,
): number {
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.max(jitterMs, Math.min(MAX_BACKOFF_MS, retryAfterMs));
  }
  return jitterMs;
}

/**
 * Group queue items by their ordering bucket. Order within each bucket is
 * preserved. Most resources are resource-wide; subscriber profile PATCHes
 * use a record-specific bucket so unrelated profiles cannot strand each
 * other while same-profile edits remain strictly FIFO.
 */
export function groupByResource(
  items: OfflineMutation[],
): Map<string, OfflineMutation[]> {
  const groups = new Map<string, OfflineMutation[]>();
  for (const it of items) {
    const key = offlineMutationOrderingKey(it);
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }
  return groups;
}

/** True when the item has burned through its attempt budget. */
// Dead-letter predicate now lives in @postwave/offline-outbox (byte-identical
// to what was here; imported above); re-exported so callers importing it from
// "./outbox" are unchanged.
export { isDeadLetter };

// isTerminalStatus (conflict | dead-letter; `failed` is transient + keeps
// retrying) now lives in @postwave/offline-outbox — byte-identical to what was
// here — and is re-exported so callers importing it from "./outbox" (incl. the
// outbox test) are unchanged.
export { isTerminalStatus };

/**
 * Mark an item as dead-letter. Preserves the last error so the
 * settings/offline UI can render the failure reason.
 */
export function moveToDeadLetter(id: string, reason: string): void {
  updateOfflineMutation(id, {
    status: "dead-letter",
    lastError: reason,
  });
}

/**
 * Total dead-letter count for the offline ledger UI badge.
 */
export function deadLetterCount(): number {
  return readOfflineQueue().filter(isDeadLetter).length;
}

/**
 * All dead-letter items, in queue order, for the settings/offline UI.
 */
export function listDeadLetter(): OfflineMutation[] {
  return readOfflineQueue().filter(isDeadLetter);
}

/**
 * Wire `setMutationDefaults` for each tracked resource so any TanStack
 * Query v5 mutation keyed under [resource, op, …] inherits the outbox
 * retry/backoff policy. Idempotent — safe to call once per QueryClient.
 */
export function installOutboxMutationDefaults(client: QueryClient): void {
  for (const resource of OUTBOX_RESOURCES) {
    client.setMutationDefaults([resource], {
      // retry: 0 — TanStack-level retries would re-invoke the api-client
      // call and re-mint the Idempotency-Key per attempt (defeating
      // server dedupe) AND stack with httpFetch's internal retry budget
      // (which already retries with a stable key). The offline queue is
      // the durability mechanism, not TanStack retries.
      retry: 0,
      networkMode: "offlineFirst",
      gcTime: 24 * 60 * 60 * 1000,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Replay one item, retrying with decorrelated-jitter delays within this
 * drain while the persisted attempt budget allows. The replay function
 * (api-client) owns attempt accounting + dead-lettering; we re-read the
 * persisted item between attempts to observe what it decided.
 */
async function replayWithRetry(
  first: OfflineMutation,
  replay: (
    item: OfflineMutation,
  ) => Promise<"replayed" | "conflict" | "failed">,
  nextDelay: (failureCount: number, err: unknown) => number,
): Promise<"replayed" | "conflict" | "failed"> {
  let item = first;
  for (;;) {
    let outcome: "replayed" | "conflict" | "failed";
    try {
      outcome = await replay(item);
    } catch {
      outcome = "failed";
    }
    if (outcome !== "failed") return outcome;
    const current = readOfflineQueue().find((it) => it.id === item.id);
    // Stop when the item is gone, was dead-lettered/parked by the
    // replay function, exhausted its budget, or the replay didn't make
    // a real attempt (e.g. policy refusal — attempts unchanged).
    if (
      !current ||
      isDeadLetter(current) ||
      current.status !== "failed" ||
      current.attempts >= OUTBOX_MAX_ATTEMPTS ||
      current.attempts <= item.attempts
    ) {
      return "failed";
    }
    item = current;
    await sleep(
      effectiveReplayDelay(
        nextDelay(current.attempts, null),
        current.retryAfterMs,
      ),
    );
  }
}

/**
 * Iterate items grouped by their ordering key and drive them through `replay`
 * serially within a bucket, concurrently across buckets. The caller
 * supplies the actual replay function (which talks to api-client) so
 * this module stays free of HTTP concerns.
 *
 * Failed items retry with decorrelated jitter while attempts <
 * OUTBOX_MAX_ATTEMPTS; items at/over the budget go to dead-letter via
 * moveToDeadLetter. When an item ends a drain failed or conflicted, the
 * REST of its ordering bucket is skipped for this drain — replaying a
 * later edit over an earlier failure would reorder writes. The same
 * holds for an unresolved 'conflict' left over from a PREVIOUS drain:
 * it blocks its bucket until the user resolves it. 'dead-letter' items,
 * by contrast, are skipped so an abandoned item doesn't strand the
 * bucket forever.
 *
 * Returns a per-bucket summary that callers can fold into a UI toast.
 */
export async function drainOutbox(
  replay: (
    item: OfflineMutation,
  ) => Promise<"replayed" | "conflict" | "failed">,
  opts?: {
    /** Test seam — defaults to the decorrelated-jitter cascade. */
    retryDelay?: (failureCount: number, err: unknown) => number;
  },
): Promise<{
  replayed: number;
  conflicts: number;
  failed: number;
  dead: number;
  /** Dropped because their target was deleted after they were queued. */
  suppressed: number;
  /** Parked because the caller's role, plan or workspace moved while they waited. */
  staleContext: number;
}> {
  const groups = groupByResource(readOfflineQueue());
  const totals = { replayed: 0, conflicts: 0, failed: 0, dead: 0, suppressed: 0, staleContext: 0 };
  // Read once per drain: a deletion landing mid-drain must not change how
  // earlier items in the same pass were judged.
  const tombstones = readTombstones();
  // Read once per drain, like the tombstones: a context change landing
  // mid-drain must not judge earlier items in the same pass differently.
  const epoch = readContextEpoch();
  await Promise.all(
    Array.from(groups.values()).map(async (items) => {
      const nextDelay =
        opts?.retryDelay ?? decorrelatedJitter(BASE_BACKOFF_MS, MAX_BACKOFF_MS);
      for (const queuedItem of items) {
        // A prior same-record success may have handed a fresh ETag to this
        // successor. Re-read the canonical journal instead of replaying the
        // stale grouping snapshot.
        const item = readOfflineQueue().find(
          (candidate) => candidate.id === queuedItem.id,
        );
        if (!item) continue;
        if (item.status === "conflict") {
          // An unresolved conflict from a PREVIOUS drain parks the whole
          // bucket: replaying later same-resource edits over it would
          // reorder writes. FIFO is preserved until the user resolves or
          // discards the conflicted item.
          break;
        }
        if (item.status === "dead-letter") {
          // Dead-letter is skippable — an abandoned item must not strand
          // its bucket forever; later edits in the bucket still replay.
          continue;
        }
        if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
          // Budget burned on a previous drain — park it for review.
          moveToDeadLetter(
            item.id,
            item.lastError ?? "Retry budget exhausted.",
          );
          continue;
        }
        // The target was deleted after this mutation was queued. Replaying it
        // recreates a record the user deleted and watched go. Discarded rather
        // than parked: there is nothing to resolve and no later drain makes it
        // replayable.
        //
        // Same rule object as web's engine, from @postwave/offline-outbox —
        // three engines replay queues, and three copies of "should this still
        // be sent" is how they come to disagree about a deleted record.
        if (isSuppressedByTombstone(item, tombstones)) {
          discardOutboxItem(item.id);
          totals.suppressed += 1;
          continue;
        }
        // The write was made in a context the caller has since left. Desktop
        // holds a queue across restarts, so the gap between "when this was
        // written" and "who I am now" is widest here: a laptop shut with work
        // pending and opened days later replays as whoever is signed in THEN.
        //
        // DEAD-LETTERED, NOT RETRIED. A context change is not transient —
        // retrying cannot fix it, and keeping a permanently-unreplayable item
        // alive burns the attempt budget and reports a failure whose cause has
        // long scrolled away. Surfaced to the person instead: it is their work.
        if (isStaleContext(item, epoch)) {
          moveToDeadLetter(item.id, STALE_CONTEXT_MESSAGE);
          totals.staleContext += 1;
          continue;
        }
        const outcome = await replayWithRetry(item, replay, nextDelay);
        if (outcome === "replayed") {
          totals.replayed += 1;
          continue;
        }
        if (outcome === "conflict") totals.conflicts += 1;
        else totals.failed += 1;
        // Per-resource FIFO: don't replay later edits in this bucket
        // over the failure/conflict we just hit.
        break;
      }
    }),
  );
  totals.dead = deadLetterCount();
  return totals;
}

/**
 * Snapshot of the outbox surfaced to UI consumers (QueueTray, StatusBar
 * chip). Buckets the queue into the four states the UI cares about and
 * pre-computes the counts so consumers don't filter on every render.
 */
export interface OutboxSnapshot {
  all: OfflineMutation[];
  pending: OfflineMutation[];
  replaying: OfflineMutation[];
  failed: OfflineMutation[];
  conflicts: OfflineMutation[];
  deadLetter: OfflineMutation[];
  /** Pending + replaying — the "N changes will sync" counter. */
  pendingCount: number;
  /** Failed + dead-letter + conflicts — the red "needs attention" badge. */
  attentionCount: number;
  /** Persistent vault/capacity failure; cleared only after a durable write. */
  persistenceError: string | null;
  /** Recent non-sensitive outcomes retained across restart. */
  recent: OfflineJournalEntry[];
}

let lastSnapshot: OutboxSnapshot | null = null;
let lastSnapshotKey = "";

function computeSnapshot(): OutboxSnapshot {
  const all = readOfflineQueue();
  const pending: OfflineMutation[] = [];
  const replaying: OfflineMutation[] = [];
  const failed: OfflineMutation[] = [];
  const conflicts: OfflineMutation[] = [];
  const dead: OfflineMutation[] = [];
  for (const item of all) {
    if (isDeadLetter(item)) {
      dead.push(item);
      continue;
    }
    switch (item.status) {
      case "pending":
        pending.push(item);
        break;
      case "replaying":
        replaying.push(item);
        break;
      case "failed":
        failed.push(item);
        break;
      case "conflict":
        conflicts.push(item);
        break;
      default:
        pending.push(item);
    }
  }
  return {
    all,
    pending,
    replaying,
    failed,
    conflicts,
    deadLetter: dead,
    pendingCount: pending.length + replaying.length,
    attentionCount: failed.length + conflicts.length + dead.length,
    persistenceError: getOfflinePersistenceError(),
    recent: readOfflineJournal(),
  };
}

function snapshotKey(snapshot: OutboxSnapshot): string {
  // Stable identity for useSyncExternalStore — change only when the
  // queue actually changed (id/status/attempts). Avoids tearing
  // re-renders on inert refreshes.
  const itemsKey = snapshot.all
    .map((i) => `${i.id}:${i.status}:${i.attempts}`)
    .join("|");
  const historyKey = snapshot.recent
    .map((entry) => `${entry.id}:${entry.status}:${entry.resolvedAt}`)
    .join("|");
  return `${itemsKey}::${historyKey}::${snapshot.persistenceError ?? ""}`;
}

function getSnapshot(): OutboxSnapshot {
  const fresh = computeSnapshot();
  const key = snapshotKey(fresh);
  if (lastSnapshot && key === lastSnapshotKey) return lastSnapshot;
  lastSnapshot = fresh;
  lastSnapshotKey = key;
  return fresh;
}

/**
 * React hook — subscribes to offline-queue mutations and returns the
 * full bucketed snapshot. QueueTray + StatusBar share this hook so
 * counts stay in sync without prop-drilling.
 */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(
    (cb) => subscribeOfflineQueue(cb),
    getSnapshot,
    getSnapshot,
  );
}

/**
 * Discard an item from the outbox. Used by the QueueTray "Discard"
 * action on dead-letter / failed items.
 */
export function discardOutboxItem(id: string): void {
  resolveOfflineMutation(id, "discarded");
}

/** Restore a just-discarded item for the bounded Undo action. */
export function restoreOutboxItem(item: OfflineMutation): void {
  const items = readOfflineQueue();
  if (items.some((current) => current.id === item.id)) return;
  removeOfflineJournalEntry(item.id);
  writeOfflineQueue([...items, { ...item, status: "pending" }]);
}

export function completeOutboxItem(
  id: string,
  successorBaseVersion?: string,
): void {
  resolveOfflineMutation(id, "synced", successorBaseVersion);
}

export function completeOutboxItemDurably(
  id: string,
  successorBaseVersion?: string,
): Promise<boolean> {
  return resolveOfflineMutationDurably(id, "synced", successorBaseVersion);
}

/**
 * Re-enqueue an item with attempts=0 so the next drain treats it as a
 * fresh send. Preserves the original Idempotency-Key so server-side
 * dedup still matches the original online attempt (if any).
 */
export function retryOutboxItem(id: string): void {
  const items = readOfflineQueue();
  const target = items.find((it) => it.id === id);
  if (!target) return;
  updateOfflineMutation(id, {
    status: "pending",
    attempts: 0,
    ...(target.lastError ? { lastError: undefined } : {}),
  });
}

/**
 * Re-issue a conflicted item as a forced overwrite (`If-Match: *`).
 * Used by the conflict resolver's "Keep mine" path.
 *
 * The overwrite is re-issued IN PLACE — at the item's original queue
 * position — rather than appended at the global tail. A newer queued
 * edit to the same resource must still replay AFTER this overwrite, or
 * the overwrite would clobber it. The original Idempotency-Key is
 * preserved so server-side dedup still matches the original attempt.
 */
export function reissueAsOverwrite(id: string): OfflineMutation | null {
  const items = readOfflineQueue();
  const target = items.find((it) => it.id === id);
  if (!target) return null;
  updateOfflineMutation(id, {
    status: "pending",
    attempts: 0,
    headers: { ...(target.headers ?? {}), "if-match": "*" },
    baseVersion: "*",
    lastError: undefined,
  });
  return readOfflineQueue().find((it) => it.id === id) ?? null;
}
