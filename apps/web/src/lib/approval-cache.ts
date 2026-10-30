// SPDX-License-Identifier: AGPL-3.0-only

import type { QueryClient, QueryKey } from "@tanstack/react-query";

const APPROVAL_SCOPES = new Set([
  "approvals",
  "approvals-delegations",
  "approvals-escalation",
]);

function isApprovalQueryKey(queryKey: QueryKey): boolean {
  return (
    queryKey[0] === "settings" &&
    typeof queryKey[3] === "string" &&
    APPROVAL_SCOPES.has(queryKey[3])
  );
}

function startsWithKey(queryKey: QueryKey, prefix: QueryKey): boolean {
  return prefix.every((part, index) => Object.is(queryKey[index], part));
}

/**
 * Remove approval data belonging to a previous principal, workspace, role, or
 * viewer-mode state. Legacy unscoped governance keys are removed as well.
 */
export function purgeStaleApprovalQueries(
  queryClient: QueryClient,
  keep?: QueryKey,
): void {
  const predicate = (query: { queryKey: QueryKey }): boolean =>
    isApprovalQueryKey(query.queryKey) &&
    (!keep || !startsWithKey(query.queryKey, keep));
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
}
