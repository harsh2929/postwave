/**
 * The local record of what this device has deleted.
 *
 * `@postwave/offline-outbox` owns the RULE — whether a queued mutation must be
 * dropped because its target was deleted — and had no caller on any surface.
 * The rule needs an input: the deletions the replay path should know about.
 *
 * WHY IT MATTERS HERE MOST. A phone is the device most often offline. Delete a
 * subscriber on a laptop, and a phone that queued an edit for that subscriber
 * in a tunnel recreates it on landing — a deletion the user performed and
 * watched succeed, undone by a device they were not looking at.
 *
 * BOUNDED ON PURPOSE. A tombstone stops mattering once every queue that could
 * predate it has drained, and an unbounded list is a growing on-device record
 * of who was deleted — itself data about people.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type Tombstone } from "@postwave/offline-outbox";

const STORAGE_KEY = "postwave.mobile.tombstones.v1";

/** Comfortably longer than any plausible offline window; short enough not to
 *  become a permanent register of deleted people. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Cap, so a bulk delete cannot grow the payload without bound. */
const MAX_TOMBSTONES = 500;

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

/** Every deletion still inside the retention window. */
export async function readTombstones(
  now: number = Date.now(),
): Promise<Tombstone[]> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  return parsed
    .filter(isTombstone)
    .filter((t) => {
      const at = Date.parse(t.deletedAt);
      // An unparseable date is KEPT. Keeping it suppresses a replay; dropping
      // it resurrects a record. Those failures are not equally bad.
      return Number.isNaN(at) || at >= cutoff;
    })
    .slice(0, MAX_TOMBSTONES);
}

/**
 * Record a deletion the user performed here. Call after the server confirms
 * it — recording an unconfirmed delete would suppress replays for a record
 * that still exists.
 */
export async function recordTombstone(
  resource: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  if (!resource || !id) return;
  const entry: Tombstone = {
    resource,
    id: String(id),
    deletedAt: new Date(now).toISOString(),
  };
  const existing = (await readTombstones(now)).filter(
    (t) => !(t.resource === entry.resource && t.id === entry.id),
  );
  try {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([entry, ...existing].slice(0, MAX_TOMBSTONES)),
    );
  } catch {
    // A full store must not break a delete the server already accepted.
  }
}

/** Test/reset seam. */
export async function clearTombstones(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; a failed clear leaves suppression in place, which is safe.
  }
}
