// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Memory-only mutation outbox (web).
 *
 * Mirror of apps/desktop/src/lib/outbox.ts. The actual queue lives in
 * offline-store.ts and is deliberately tab-memory-only because a browser
 * origin has no OS-backed encryption secret. This module stays purely about
 * ordering, retry budget, and dead-letter behavior.
 *
 * Why per-resource FIFO: a single stuck campaign mutation must not
 * block subscriber or segment edits. Items in different buckets replay
 * concurrently; items in the same bucket replay serially so a conflict
 * can't reorder later edits to the same resource.
 */

import { readContextEpoch } from "./context-epoch";
import {
  isStaleContext,
  isSuppressedByTombstone,
  STALE_CONTEXT_MESSAGE,
} from "@postwave/offline-outbox";

import { readTombstones } from "./tombstones";

import { useSyncExternalStore } from "react";

export {
  installOutboxMutationDefaults,
  OUTBOX_RESOURCES,
  type OutboxResource,
} from "./outbox-query-defaults";

import {
  OFFLINE_QUEUE_CHANGED_EVENT,
  type OfflineMutation,
  enqueueOfflineMutation,
  readOfflineQueue,
  removeOfflineMutation,
  resourceOfPath,
  updateOfflineMutation,
} from "./offline-store";
import { isDeadLetter, isTerminalStatus } from "@postwave/offline-outbox";

const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 10_000;

/**
 * Decorrelated jitter — next = min(cap, randomBetween(base, prev*3)).
 * Closure over `prev` so successive failures cascade up rather than
 * re-rolling from `base` each time.
 */
export function decorrelatedJitter(
  base: number = BASE_BACKOFF_MS,
  cap: number = MAX_BACKOFF_MS,
): (failureCount: number, _err: unknown) => number {
  let prev = base;
  return (failureCount: number): number => {
    const lower = base;
    const upper = Math.min(cap, Math.max(prev, base) * 3);
    const span = Math.max(0, upper - lower);
    const next = Math.floor(lower + Math.random() * span);
    prev = next;
    void failureCount;
    return next;
  };
}

export function groupByResource(
  items: OfflineMutation[],
): Map<string, OfflineMutation[]> {
  const groups = new Map<string, OfflineMutation[]>();
  for (const it of items) {
    const key = it.resource || resourceOfPath(it.path);
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }
  return groups;
}

// isDeadLetter + isTerminalStatus now live in @postwave/offline-outbox and are
// re-exported so callers importing them from "./outbox" are unchanged. The old
// local isTerminalStatus returned `failed` as terminal, but it had ZERO call
// sites and contradicted this drain loop (which already retries a non-exhausted
// `failed` — see drainOutbox), so the shared, correct semantics
// (conflict | dead-letter) replace it with no behavioural change.
export { isDeadLetter, isTerminalStatus };

export function moveToDeadLetter(id: string, reason: string): void {
  updateOfflineMutation(id, {
    status: "dead-letter",
    lastError: reason,
  });
}

export function deadLetterCount(): number {
  return readOfflineQueue().filter(isDeadLetter).length;
}

export function listDeadLetter(): OfflineMutation[] {
  return readOfflineQueue().filter(isDeadLetter);
}

/**
 * Drive each resource bucket serially internally, concurrently across
 * buckets. Returns a summary suitable for a toast / settings UI.
 */
export async function drainOutbox(
  replay: (
    item: OfflineMutation,
  ) => Promise<"replayed" | "conflict" | "failed">,
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
  const totals = {
    replayed: 0,
    conflicts: 0,
    failed: 0,
    dead: 0,
    suppressed: 0,
    staleContext: 0,
  };
  // Read once per drain, not per item: a deletion landing mid-drain should not
  // change how earlier items in the same pass were judged.
  const tombstones = readTombstones();
  // Read once per drain, like the tombstones: a context change landing
  // mid-drain must not judge earlier items in the same pass differently.
  const epoch = readContextEpoch();
  await Promise.all(
    Array.from(groups.values()).map(async (items) => {
      for (const item of items) {
        // Exhausted retry budget (incl. failed + maxed attempts): abandon
        // it. Convert to dead-letter first so a restored/verbatim `failed`
        // item can't masquerade as resumable, then skip — an abandoned head
        // must not strand later edits in the bucket forever.
        if (isDeadLetter(item)) {
          if (item.status !== "dead-letter") {
            moveToDeadLetter(
              item.id,
              item.lastError ?? "Retry budget exhausted.",
            );
          }
          continue;
        }
        // A pre-existing unresolved CONFLICT parks the WHOLE bucket:
        // replaying later same-resource edits over it would silently
        // reorder writes. FIFO holds until the user resolves/discards it.
        // NOTE: a non-exhausted `failed` is a *transient* failure (network /
        // 5xx) and stays resumable — it must NOT park the bucket, or the
        // retry budget becomes unreachable across drains (matches desktop).
        if (item.status === "conflict") break;
        // A 429 Retry-After window is a deferred pending item, not a replay
        // failure. Park its FIFO bucket without incrementing failure totals.
        if (item.retryableAt && item.retryableAt > Date.now()) break;
        // The target was deleted after this mutation was queued. Replaying it
        // recreates a record the user deleted and watched go — from a tab or a
        // device they are not looking at, and under an erasure request, after a
        // documented deletion. Discard rather than park the bucket: there is
        // nothing to resolve and no later drain that makes it replayable.
        //
        // The RULE lives in @postwave/offline-outbox because three engines
        // replay queues, and three copies of "should this still be sent" is
        // exactly how they come to disagree about a deleted record.
        if (isSuppressedByTombstone(item, tombstones)) {
          discardOutboxItem(item.id);
          totals.suppressed += 1;
          continue;
        }
        // The write was made in a context the caller has since left — their
        // role, plan or workspace moved while it waited. Replaying it would
        // authenticate as who they are NOW, which either fails confusingly or,
        // where the server's check is coarser than the UI's, succeeds as an
        // action they are no longer allowed to take.
        //
        // DEAD-LETTERED, NOT RETRIED. A context change is not transient:
        // retrying cannot fix it, and keeping a permanently-unreplayable item
        // alive burns the attempt budget and eventually reports a failure whose
        // cause has scrolled away. It is surfaced to the person instead — it is
        // their work, and only they can decide whether it still applies.
        if (isStaleContext(item, epoch)) {
          moveToDeadLetter(item.id, STALE_CONTEXT_MESSAGE);
          totals.staleContext += 1;
          continue;
        }
        try {
          const outcome = await replay(item);
          if (outcome === "replayed") {
            totals.replayed += 1;
            continue;
          }
          if (outcome === "conflict") totals.conflicts += 1;
          else totals.failed += 1;
          // Fresh conflict/failure this drain: stop the bucket so we don't
          // reorder later writes over the one that just failed.
          break;
        } catch {
          totals.failed += 1;
          break;
        }
      }
    }),
  );
  totals.dead = deadLetterCount();
  return totals;
}

/**
 * Snapshot of the outbox surfaced to UI consumers (QueueTray, offline
 * banner). Pre-buckets the queue so each subscriber doesn't re-filter
 * on render.
 */
export interface OutboxSnapshot {
  all: OfflineMutation[];
  pending: OfflineMutation[];
  replaying: OfflineMutation[];
  failed: OfflineMutation[];
  conflicts: OfflineMutation[];
  deadLetter: OfflineMutation[];
  /** pending + replaying — the "N changes will sync" counter. */
  pendingCount: number;
  /** failed + conflicts + dead-letter — the red "needs attention" badge. */
  attentionCount: number;
}

let lastSnapshot: OutboxSnapshot | null = null;
let lastSnapshotKey = "";

function computeSnapshot(): OutboxSnapshot {
  if (typeof window === "undefined") {
    return {
      all: [],
      pending: [],
      replaying: [],
      failed: [],
      conflicts: [],
      deadLetter: [],
      pendingCount: 0,
      attentionCount: 0,
    };
  }
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
  };
}

function snapshotKey(items: OfflineMutation[]): string {
  return items.map((i) => `${i.id}:${i.status}:${i.attempts}`).join("|");
}

function getSnapshot(): OutboxSnapshot {
  const fresh = computeSnapshot();
  const key = snapshotKey(fresh.all);
  if (lastSnapshot && key === lastSnapshotKey) return lastSnapshot;
  lastSnapshot = fresh;
  lastSnapshotKey = key;
  return fresh;
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (): void => cb();
  window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(OFFLINE_QUEUE_CHANGED_EVENT, handler);
}

/**
 * React hook — subscribes to offline-queue mutations and returns the
 * bucketed snapshot. QueueTray + OfflineBanner share this hook so
 * counts stay in sync without prop-drilling.
 */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Discard an item from the outbox — drives the "Discard" action. */
export function discardOutboxItem(id: string): void {
  removeOfflineMutation(id);
}

/** Re-enqueue an item with attempts=0 — drives the "Retry" action. */
export function retryOutboxItem(id: string): void {
  const items = readOfflineQueue();
  const target = items.find((it) => it.id === id);
  if (!target) return;
  updateOfflineMutation(id, {
    status: "pending",
    attempts: 0,
    conflictStatus: undefined,
    ...(target.lastError ? { lastError: undefined } : {}),
  });
}

/**
 * Discard a conflicted item and enqueue a clone with `If-Match: *` so
 * the server overwrites the current version — the "Keep mine" path.
 */
export function reissueAsOverwrite(id: string): OfflineMutation | null {
  const items = readOfflineQueue();
  const target = items.find((it) => it.id === id);
  if (!target) return null;
  removeOfflineMutation(id);
  const headers = { ...(target.headers ?? {}), "if-match": "*" };
  return enqueueOfflineMutation({
    method: target.method,
    path: target.path,
    query: target.query,
    body: target.body,
    headers,
    // A new semantic attempt must not reuse the 4xx-cached idempotency key.
    // enqueueOfflineMutation mints a fresh key when this field is omitted.
  });
}
