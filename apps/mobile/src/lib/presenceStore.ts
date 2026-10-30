/**
 * lib/presenceStore.ts — workspace presence, held for the process.
 *
 * Deliberately the same shape as lib/eventBusStatus.ts and for the same
 * reasons: it is written from a non-React transport callback, it must be
 * readable from more than one screen, and keeping it dependency-free (only
 * `react`'s useSyncExternalStore) keeps the reducer unit-testable under node.
 *
 * WHY THERE IS NO SECOND SOCKET. Web opens a dedicated `presence.update`
 * subscription because a browser tab is cheap. A phone is not: a second SSE
 * connection is a second radio wake cycle and a second stream-token mint on
 * every reconnect. The workspace connection lib/eventCacheSync already holds
 * open subscribes to `presence.update` alongside the invalidation topics and
 * routes those frames here, so presence costs nothing extra.
 *
 * WHY REPLAYED FRAMES ARE REFUSED. `presence.update` describes who is here
 * NOW. The gap-recovery walk replays events published while the stream was
 * down, so a replayed presence frame is a HISTORICAL viewer list — and it
 * arrives after the fresh snapshot the re-subscribe just produced, so the
 * stale one would win. Web documents the same trap and disables recovery for
 * its presence subscription; we drop the frames at this door instead.
 */
import { useSyncExternalStore } from "react";

import {
  EMPTY_PRESENCE,
  parsePresencePayload,
  type PresenceSnapshot,
} from "@/lib/presence";

let presence: PresenceSnapshot = EMPTY_PRESENCE;
const listeners = new Set<() => void>();

function commit(next: PresenceSnapshot): void {
  presence = next;
  for (const listener of [...listeners]) listener();
}

export function getWorkspacePresence(): PresenceSnapshot {
  return presence;
}

export function subscribeWorkspacePresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply a live `presence.update` payload. A frame we cannot parse leaves the
 * previous snapshot alone — blanking a good viewer list because one frame was
 * malformed is strictly worse than showing a slightly stale one.
 *
 * Returns whether the store changed, which is what the transport test asserts.
 */
export function applyWorkspacePresence(payload: unknown): boolean {
  const next = parsePresencePayload(payload);
  if (!next) return false;
  if (
    next.count === presence.count &&
    next.truncated === presence.truncated &&
    next.viewers.length === presence.viewers.length &&
    next.viewers.every(
      (v, i) =>
        v.id === presence.viewers[i]?.id && v.label === presence.viewers[i]?.label,
    )
  ) {
    return false;
  }
  commit(next);
  return true;
}

/** Full reset — used on disconnect/sign-out and by tests. */
export function resetWorkspacePresence(): void {
  if (presence === EMPTY_PRESENCE) return;
  commit(EMPTY_PRESENCE);
}

/** React binding for the presence chip. */
export function useWorkspacePresence(): PresenceSnapshot {
  return useSyncExternalStore(
    subscribeWorkspacePresence,
    getWorkspacePresence,
    getWorkspacePresence,
  );
}
