/**
 * The local record of what this browser has deleted.
 *
 * `@postwave/offline-outbox` owns the RULE — whether a queued mutation must be
 * dropped because its target was deleted — and had no caller on any surface.
 * The rule needs an input: the set of deletions the replay engine should know
 * about. This is that store for desktop; web has its own, keyed separately, because the two apps do not share a storage namespace.
 *
 * WHY IT MATTERS. Delete a subscriber here, and a queued edit for that
 * subscriber — from this tab or another device syncing the same queue — replays
 * on reconnect and recreates the row. The user performed a deletion, watched it
 * succeed, and a write they had forgotten about undoes it. Under an erasure
 * request, that is a record returning after a documented deletion.
 *
 * BOUNDED ON PURPOSE. A tombstone stops being useful once every queue that
 * could have predated it has drained, and an unbounded list is a growing
 * localStorage payload recording who was deleted — which is itself data about
 * people. Entries older than the retention window are dropped on read.
 */
import { type Tombstone } from "@postwave/offline-outbox";

const STORAGE_KEY = "postwave.desktop.tombstones.v1";

/**
 * How long a deletion stays relevant to replay.
 *
 * Comfortably longer than any plausible offline window — a laptop shut for a
 * long weekend still replays against a live tombstone — and short enough that
 * the list does not become a permanent register of deleted people.
 */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Cap on retained entries, so a bulk delete cannot blow the storage quota. */
const MAX_TOMBSTONES = 500;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Denied storage (private mode, blocked cookies) degrades to no
    // suppression rather than throwing inside a replay loop.
    return null;
  }
}

function isTombstone(value: unknown): value is Tombstone {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.resource === "string" &&
    typeof t.id === "string" &&
    typeof t.deletedAt === "string" &&
    t.resource !== "" &&
    t.id !== ""
  );
}

/** Every deletion still inside the retention window, newest first. */
export function readTombstones(now: number = Date.now()): Tombstone[] {
  const store = storage();
  if (!store) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  return parsed
    .filter(isTombstone)
    .filter((t) => {
      const at = Date.parse(t.deletedAt);
      // An unparseable date is kept rather than dropped: the failure mode of
      // keeping it is a suppressed replay, and of dropping it is a resurrected
      // record. Those are not equally bad.
      return Number.isNaN(at) || at >= cutoff;
    })
    .slice(0, MAX_TOMBSTONES);
}

/**
 * Record a deletion the user performed here.
 *
 * Call after the server confirms it. Recording an unconfirmed delete would
 * suppress replays for a record that still exists.
 */
export function recordTombstone(
  resource: string,
  id: string,
  now: number = Date.now(),
): void {
  const store = storage();
  if (!store || !resource || !id) return;
  const entry: Tombstone = {
    resource,
    id: String(id),
    deletedAt: new Date(now).toISOString(),
  };
  const existing = readTombstones(now).filter(
    (t) => !(t.resource === entry.resource && t.id === entry.id),
  );
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify([entry, ...existing].slice(0, MAX_TOMBSTONES)),
    );
  } catch {
    // A full quota must not break a delete the server already accepted.
  }
}

/** Test/reset seam. */
export function clearTombstones(): void {
  storage()?.removeItem(STORAGE_KEY);
}
