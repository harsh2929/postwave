// SPDX-License-Identifier: AGPL-3.0-only
//
// What an audience write makes stale, in one place.
//
// Each screen used to invalidate only the query it had just changed. A list
// deleted on /app/lists stayed in the form editor's target-list picker for up
// to a day; members added on a list's Members tab never reached the added
// people's profiles or the index's subscriber counts; a custom field deleted in
// Settings was still offered by the segment builder. The same server resource
// is read by several screens under several keys, so the invalidation belongs
// to the resource, not to the screen that happened to write it.

import type { Query, QueryClient } from "@tanstack/react-query";

import { base, qk, type RoleKey } from "@/lib/query-keys";

/**
 * Every cached read of the list catalogue (GET /api/v1/lists): the /app/lists
 * index, the list detail record, the form target-list picker and the
 * subscriber "Add to list" pickers all key under `base("lists", …)`.
 */
export async function invalidateListCatalogue(
  qc: QueryClient,
  tenantId: string,
  role: RoleKey,
): Promise<void> {
  await qc.invalidateQueries({ queryKey: base("lists", tenantId, role) });
}

/**
 * A membership change seen from both sides: every list's members table and
 * count, the catalogue's per-list subscriber counts, the list analytics and
 * activity tabs, the directory, and each affected subscriber's profile (its
 * record, timeline and list chips all live under `qk.subscriber`).
 *
 * The list side is invalidated as a whole family on purpose — a subscriber's
 * profile names lists by their workspace UUID while list screens key by the
 * engine id, and one membership can move more than one list's numbers.
 */
export async function invalidateMembership(
  qc: QueryClient,
  tenantId: string,
  role: RoleKey,
  { subscriberIds }: { subscriberIds: readonly string[] },
): Promise<void> {
  await Promise.all([
    ...["list-members", "lists", "list-analytics", "list-activity", "subscribers"].map(
      (resource) =>
        qc.invalidateQueries({ queryKey: base(resource, tenantId, role) }),
    ),
    ...subscriberIds.map((id) =>
      qc.invalidateQueries({ queryKey: qk.subscriber(tenantId, role, id) }),
    ),
  ]);
}

/**
 * A tag added to or removed from subscribers: the directory's rows and tag
 * chips, the tag catalogue and its counts, each tag's member list, history and
 * membership trend, and each subscriber's timeline and segment membership
 * (a segment can be defined by a tag).
 *
 * The subscriber record itself is left to the caller, which already refetches
 * it with the write's own answer.
 */
export async function invalidateTagging(
  qc: QueryClient,
  tenantId: string,
  role: RoleKey,
  { subscriberIds }: { subscriberIds: readonly string[] },
): Promise<void> {
  await Promise.all([
    ...[
      "subscribers",
      "tags",
      "tag-taxonomy",
      "tag-subscribers",
      "tag-history",
      "tag-membership",
    ].map((resource) =>
      qc.invalidateQueries({ queryKey: base(resource, tenantId, role) }),
    ),
    ...subscriberIds.flatMap((id) =>
      ["timeline", "segment-membership"].map((facet) =>
        qc.invalidateQueries({
          queryKey: [...qk.subscriber(tenantId, role, id), facet],
        }),
      ),
    ),
  ]);
}

/**
 * Custom-field definitions (GET /api/v1/custom-fields) are read by the
 * subscriber profile panel and edit dialog (`base("custom-fields", …)`), the
 * segment builder's field picker (`base("segment-fields", …)`, and the
 * `base("segment-fields-fallback", …)` list it builds from these definitions
 * when the predicate registry is unavailable) and the directory's bulk field
 * dialog (`[...base("subscribers", …), "bulk-custom-field-defs"]`).
 *
 * Matched on tenant rather than on the exact role key: definitions are
 * workspace-wide, and the segment builder scopes its key by the durable role
 * where the rest of the app uses the effective one, so a role-exact prefix
 * would silently miss it for an elevated session.
 */
export async function invalidateCustomFieldDefinitions(
  qc: QueryClient,
  tenantId: string,
): Promise<void> {
  // base() spells a missing tenant as "anon"; match what it wrote.
  const tenant = base("", tenantId, null)[1];
  await qc.invalidateQueries({
    predicate: (query: Query) => {
      const [resource, keyTenant] = query.queryKey;
      if (keyTenant !== tenant) return false;
      return (
        resource === "custom-fields" ||
        resource === "segment-fields" ||
        resource === "segment-fields-fallback" ||
        (resource === "subscribers" &&
          query.queryKey.includes("bulk-custom-field-defs"))
      );
    },
  });
}
