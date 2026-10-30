// SPDX-License-Identifier: AGPL-3.0-only
//
// A queued mutation must not resurrect something that was deleted.
//
// Every surface queues writes while offline and replays them on reconnect. None
// of them asks whether the target still exists. So: delete a subscriber on your
// laptop, and a phone that queued an edit for that subscriber while in a tunnel
// replays it on landing — recreating the record, or worse, half of it.
//
// For a subscriber that is a deletion the user performed and watched succeed,
// undone by a device they were not looking at. Under GDPR erasure it is a record
// coming back after a documented deletion.
//
// The rule lives here, in the shared package, for the reason the package exists:
// three engines replay queues, and three copies of "should this still be sent"
// is how they end up disagreeing about a deleted record.

import { describe, expect, it } from "vitest";

import { isSuppressedByTombstone,
  resourceFromPath, type Tombstone } from "./tombstone";

const deletedAt = "2026-08-05T12:00:00.000Z";
const before = "2026-08-05T11:00:00.000Z";
const after = "2026-08-05T13:00:00.000Z";

const tombstones: Tombstone[] = [
  { resource: "subscribers", id: "sub-1", deletedAt },
];

function mutation(over: Partial<Parameters<typeof isSuppressedByTombstone>[0]> = {}) {
  return {
    method: "PATCH",
    path: "/api/v1/subscribers/sub-1",
    resource: "subscribers",
    queuedAt: before,
    ...over,
  };
}

describe("tombstone suppression", () => {
  it("suppresses a mutation queued BEFORE the delete", () => {
    expect(isSuppressedByTombstone(mutation(), tombstones)).toBe(true);
  });

  it("does NOT suppress a mutation queued AFTER the delete", () => {
    // The user deleted, then deliberately recreated. Suppressing here would
    // discard an intent newer than the deletion — the opposite failure, and
    // silent in the same way.
    expect(isSuppressedByTombstone(mutation({ queuedAt: after }), tombstones)).toBe(false);
  });

  it("does not touch a different record of the same type", () => {
    expect(
      isSuppressedByTombstone(mutation({ path: "/api/v1/subscribers/sub-2" }), tombstones),
    ).toBe(false);
  });

  it("does not touch a different resource type with the same id", () => {
    expect(
      isSuppressedByTombstone(
        mutation({ resource: "campaigns", path: "/api/v1/campaigns/sub-1" }),
        tombstones,
      ),
    ).toBe(false);
  });

  it("suppresses a nested write under the deleted record", () => {
    // `PATCH /subscribers/sub-1/tags` targets the deleted subscriber just as
    // surely as a write to the record itself, and recreating it through a
    // sub-resource is the same resurrection by a longer path.
    expect(
      isSuppressedByTombstone(mutation({ path: "/api/v1/subscribers/sub-1/tags" }), tombstones),
    ).toBe(true);
  });

  it("suppresses a DELETE of the same record without reporting failure", () => {
    // Deleting an already-deleted record is the user's intent already satisfied.
    // Replaying it would 404 and surface as a sync error for something that
    // went exactly as they wanted.
    expect(
      isSuppressedByTombstone(mutation({ method: "DELETE" }), tombstones),
    ).toBe(true);
  });

  it("never suppresses a collection-level create", () => {
    // POST /subscribers has no id in its path. It cannot be the deleted record,
    // and suppressing it would silently drop a new signup.
    expect(
      isSuppressedByTombstone(
        mutation({ method: "POST", path: "/api/v1/subscribers" }),
        tombstones,
      ),
    ).toBe(false);
  });

  it("is inert with no tombstones", () => {
    expect(isSuppressedByTombstone(mutation(), [])).toBe(false);
  });
});

describe("engines that do not store a resource field", () => {
  // apps/web's offline store sanitizes a queued mutation down to
  // {id, method, path, idempotencyKey, queuedAt, expiresAt, attempts, status}.
  // With `resource` required, the rule returned false for every web mutation —
  // the suppression existed and could not fire.
  it("derives the resource from the path", () => {
    expect(
      isSuppressedByTombstone(
        {
          method: "PATCH",
          path: "/api/v1/subscribers/sub-1",
          queuedAt: "2026-08-01T10:00:00.000Z",
        },
        [
          {
            resource: "subscribers",
            id: "sub-1",
            deletedAt: "2026-08-01T11:00:00.000Z",
          },
        ],
      ),
    ).toBe(true);
  });

  it("still leaves a collection write alone", () => {
    expect(
      isSuppressedByTombstone(
        {
          method: "POST",
          path: "/api/v1/subscribers",
          queuedAt: "2026-08-01T10:00:00.000Z",
        },
        [
          {
            resource: "subscribers",
            id: "sub-1",
            deletedAt: "2026-08-01T11:00:00.000Z",
          },
        ],
      ),
    ).toBe(false);
  });

  it("returns null for a path with no resource segment", () => {
    expect(resourceFromPath("/healthz")).toBeNull();
  });
});

describe("targetedId is total and matches the real path", () => {
  // decodeURIComponent throws URIError on a malformed escape. This predicate
  // runs over PERSISTED queue items inside each engine's replay loop, and on
  // web and desktop the call sits OUTSIDE the per-item try/catch
  // (apps/web/src/lib/outbox.ts:202, whose try begins at 223; desktop's loop
  // at 315 likewise). A throw there aborts the WHOLE drain rather than
  // skipping one item — and repeats on every later drain, because the
  // offending item is still queued. One malformed path permanently wedges the
  // outbox and blocks every subsequent offline write from replaying.
  it.each([
    "/api/v1/subscribers/100%",
    "/api/v1/subscribers/a%zz",
    "/api/v1/subscribers/%",
    "/api/v1/subscribers/%E0%A4%A",
  ])("does not throw on the malformed escape in %s", (path) => {
    expect(() =>
      isSuppressedByTombstone(mutation({ path }), tombstones),
    ).not.toThrow();
  });

  it("still suppresses a normally-encoded id", () => {
    // Guard the guard: the catch must not have turned decoding off entirely.
    // enc("sub 1") is the encoded form; the tombstone holds the decoded id.
    expect(
      isSuppressedByTombstone(
        { ...mutation(), path: "/api/v1/subscribers/sub%201" },
        [{ resource: "subscribers", id: "sub 1", deletedAt }],
      ),
    ).toBe(true);
  });

  // A query string rode along on the last segment, so the extracted id was
  // "sub-1?hard=true", which matches no tombstone. The rule then failed OPEN:
  // the delete is silently undone by a replay, which is precisely the failure
  // this module's header describes.
  it.each([
    "/api/v1/subscribers/sub-1?hard=true",
    "/api/v1/subscribers/sub-1?a=1&b=2",
    "/api/v1/subscribers/sub-1#frag",
  ])("ignores the query string / fragment in %s", (path) => {
    expect(isSuppressedByTombstone(mutation({ path }), tombstones)).toBe(true);
  });

  it("matches the resource case-insensitively", () => {
    // resourceFromPath's regex carries /i, so it can return "Subscribers"
    // while the tombstone was recorded lowercase. A case-sensitive compare
    // fails open.
    expect(
      isSuppressedByTombstone(
        { method: "PATCH", path: "/api/v1/Subscribers/sub-1", queuedAt: before },
        tombstones,
      ),
    ).toBe(true);
  });

  it("matches when the ENGINE supplies a differently-cased resource", () => {
    // Distinct from the case above, which relies on resourceFromPath's own /i
    // to produce "Subscribers" from the path — there, marker and path already
    // agree. This is the case only the marker's /i can save: the engine stores
    // resource "subscribers" while the path segment is "Subscribers", so an
    // exact indexOf/RegExp finds nothing and the rule fails open.
    expect(
      isSuppressedByTombstone(
        {
          method: "PATCH",
          path: "/api/v1/Subscribers/sub-1",
          resource: "subscribers",
          queuedAt: before,
        },
        tombstones,
      ),
    ).toBe(true);
  });

  it("keeps record ids case-SENSITIVE", () => {
    // Ids are opaque. Two ids differing only in case are two different
    // records, and suppressing the wrong one would discard a live write.
    expect(
      isSuppressedByTombstone(
        mutation({ path: "/api/v1/subscribers/SUB-1" }),
        tombstones,
      ),
    ).toBe(false);
  });

  it("does not treat a collection path as targeting the deleted record", () => {
    expect(
      isSuppressedByTombstone(
        mutation({ method: "POST", path: "/api/v1/subscribers" }),
        tombstones,
      ),
    ).toBe(false);
    expect(
      isSuppressedByTombstone(
        mutation({ method: "POST", path: "/api/v1/subscribers?page=2" }),
        tombstones,
      ),
    ).toBe(false);
  });

  it("survives a resource name containing regex metacharacters", () => {
    // `resource` can come from the ENGINE, not only from resourceFromPath, so
    // it is not guaranteed to be [a-z0-9-]. Interpolating it into a RegExp
    // unescaped would either throw SyntaxError or match the wrong thing.
    expect(() =>
      isSuppressedByTombstone(
        { method: "PATCH", path: "/api/v1/a(b/x", resource: "a(b", queuedAt: before },
        tombstones,
      ),
    ).not.toThrow();
  });
});
