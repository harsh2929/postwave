// SPDX-License-Identifier: AGPL-3.0-only
//
// What to refetch after the subscribers directory writes.
//
// A contact write changes more than the directory row: the status counts,
// the audience growth trend, the audience-intelligence panel, the dashboard
// tiles and the onboarding checklist are all derived from the audience, and a
// delete or an add-to-list also changes list sizes and member tables. Those
// caches are keyed [resource, tenantId, role, …], so a [resource, tenantId]
// prefix reaches every role's copy for this workspace and none of another's.

import type { QueryClient } from "@tanstack/react-query";

const AUDIENCE_DERIVED = [
  "subscribers",
  "subscriber-growth",
  "audience-intelligence",
  "dashboard",
  "onboarding-progress",
] as const;

const MEMBERSHIP_DERIVED = ["lists", "list-members", "list-analytics", "list-activity"] as const;

export interface AudienceChange {
  /** List membership changed (add to list, or a delete that removed members). */
  membership?: boolean;
  /** Contacts that no longer exist; their cached profiles are dropped. */
  deletedIds?: readonly string[];
}

export function refreshAudienceQueries(
  queryClient: QueryClient,
  tenantId: string,
  change: AudienceChange = {},
): void {
  const deleted = change.deletedIds ?? [];
  const resources =
    change.membership || deleted.length > 0
      ? [...AUDIENCE_DERIVED, ...MEMBERSHIP_DERIVED]
      : AUDIENCE_DERIVED;
  for (const resource of resources) {
    void queryClient.invalidateQueries({ queryKey: [resource, tenantId] });
  }
  if (deleted.length > 0) {
    const gone = new Set(deleted);
    queryClient.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === "subscriber" &&
        query.queryKey[1] === tenantId &&
        gone.has(String(query.queryKey[3])),
    });
  }
}
