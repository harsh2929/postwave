// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A record that was deleted, and when.
 *
 * Recorded on whichever surface performed the delete and shared with the others,
 * so a queue replayed later can tell that its target is gone.
 */
export interface Tombstone {
  /** Resource type, matching `OfflineMutationCore.resource` (e.g. "subscribers"). */
  resource: string;
  /** The deleted record's id. */
  id: string;
  /** ISO-8601. Mutations queued at or after this are NOT suppressed. */
  deletedAt: string;
}

/** The fields the rule reads. Both surfaces' fuller mutation types satisfy it. */
export interface TombstoneCandidate {
  method: string;
  path: string;
  resource?: string;
  queuedAt: string;
}

/**
 * Extracts the record id a mutation targets, if it targets one.
 *
 * `/api/v1/subscribers/sub-1` and `/api/v1/subscribers/sub-1/tags` both target
 * `sub-1`; `/api/v1/subscribers` targets the collection and no record. That
 * distinction is load-bearing — suppressing a collection-level POST would
 * silently drop a new signup that has nothing to do with the deleted row.
 */
function targetedId(path: string, resource: string): string | null {
  // Match the PATH only. A query string or fragment otherwise rides along on
  // the last segment, so `/subscribers/sub-1?hard=true` yields the id
  // "sub-1?hard=true", matches no tombstone, and the rule fails open — the
  // recreation this whole module exists to prevent.
  const pathOnly = path.split(/[?#]/)[0] ?? path;

  // Case-insensitive, because resourceFromPath's regex carries /i and so can
  // return "Subscribers" while the tombstone recorded "subscribers". A
  // case-sensitive indexOf finds nothing there and, again, fails open.
  // Done with a regex rather than lowercasing both sides: toLowerCase can
  // CHANGE STRING LENGTH for some Unicode, which would corrupt the slice
  // offset below.
  const marker = new RegExp(`/${escapeRegExp(resource)}/`, "i");
  const found = marker.exec(pathOnly);
  if (!found) return null;

  const rest = pathOnly.slice(found.index + found[0].length);
  if (rest === "") return null;
  // `split` is typed as possibly-undefined under noUncheckedIndexedAccess, and
  // an empty segment is not an id.
  const id = rest.split("/")[0] ?? "";
  if (id === "") return null;

  try {
    return decodeURIComponent(id);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape ("100%",
    // "a%zz"). That must not escape this function.
    //
    // This predicate runs over PERSISTED queue items inside each engine's
    // replay loop, and on web and desktop the call sits OUTSIDE the per-item
    // try/catch (apps/web/src/lib/outbox.ts:202 vs its try at 223). So a throw
    // here does not skip one mutation — it aborts the entire drain, and does
    // so again on every subsequent drain, because the offending item is still
    // in the queue. One malformed path would permanently wedge the outbox and
    // block every later offline write from ever replaying.
    //
    // Falling back to the raw segment keeps the function total. An id that
    // cannot be decoded simply will not match a tombstone, which is the same
    // fail-open this function already chooses for an unparseable date.
    return id;
  }
}

/** Escape a resource name for literal use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a queued mutation must be dropped because its target was deleted.
 *
 * WHY THIS EXISTS. Every surface queues writes while offline and replays them on
 * reconnect, and none of them asked whether the target still existed. Delete a
 * subscriber on a laptop, and a phone that queued an edit for that subscriber
 * while in a tunnel recreates it on landing — a deletion the user performed and
 * watched succeed, undone by a device they were not looking at. Under an erasure
 * request it is a record returning after a documented deletion.
 *
 * WHY IN THE SHARED PACKAGE. Three engines replay queues. Three copies of
 * "should this still be sent" is exactly how they come to disagree about a
 * deleted record, and the copy that stops getting updated is the one nobody
 * exercises by hand.
 *
 * THE TIME COMPARISON IS THE SUBTLE PART. Only mutations queued STRICTLY BEFORE
 * the deletion are suppressed. A write queued afterwards is a deliberate
 * recreation, and discarding it would be the mirror failure — equally silent,
 * and harder to notice because the user is looking at the thing they just made.
 */
/**
 * The resource segment of an API path, when it has one.
 *
 * Lives here, beside the rule that consumes it, because not every engine STORES
 * a resource field. apps/web's offline store sanitizes queued mutations down to
 * `{id, method, path, idempotencyKey, queuedAt, expiresAt, attempts, status}` —
 * no `resource` — so the rule silently returned false for every web mutation
 * and the suppression could never fire. Deriving it at the call site instead
 * would put a second definition of "which resource is this?" in each engine,
 * which is the shape of drift this package exists to prevent.
 *
 * Returns null for a path with no `/api/v1/<resource>` segment.
 */
export function resourceFromPath(path: string): string | null {
  const match = /\/api\/v\d+\/([a-z0-9-]+)/i.exec(path);
  return match?.[1] ?? null;
}

export function isSuppressedByTombstone(
  mutation: TombstoneCandidate,
  tombstones: readonly Tombstone[],
): boolean {
  if (tombstones.length === 0) return false;
  // Fall back to the path when the engine does not store a resource field —
  // web's sanitizer strips it, which made this rule a no-op there.
  const resource = mutation.resource ?? resourceFromPath(mutation.path);
  if (!resource) return false;

  const id = targetedId(mutation.path, resource);
  if (id === null) return false;

  const queuedAt = Date.parse(mutation.queuedAt);
  if (Number.isNaN(queuedAt)) return false;

  return tombstones.some((t) => {
    // Resource compared case-insensitively for the same reason targetedId
    // matches that way: resourceFromPath's /i regex can yield "Subscribers"
    // from a path while the tombstone was recorded as "subscribers". The id
    // stays case-SENSITIVE — record ids are opaque and two ids differing only
    // in case are two different records.
    if (t.resource.toLowerCase() !== resource.toLowerCase() || t.id !== id) {
      return false;
    }
    const deletedAt = Date.parse(t.deletedAt);
    if (Number.isNaN(deletedAt)) return false;
    return queuedAt < deletedAt;
  });
}
