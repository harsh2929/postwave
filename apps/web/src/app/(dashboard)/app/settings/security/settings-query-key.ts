// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

export function useSettingsQueryKey(
  scope: string,
  options: { adminOnly?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "unresolved";
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && roleCanWrite(role),
  );
  const verified = meQuery.isSuccess && Boolean(identity);
  const authorityKey = verified
    ? `${tenantId}:${identity!.user_id}:${role}:${identity!.viewer_mode ? "viewer" : "member"}`
    : "unverified";
  const queryKey = useMemo(
    () => [...qk.settings(tenantId, role, scope), authorityKey] as const,
    [authorityKey, role, scope, tenantId],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== queryKey) {
      void queryClient.cancelQueries({ queryKey: previous, exact: true });
      queryClient.removeQueries({ queryKey: previous, exact: true });
    }
    previousKeyRef.current = queryKey;
    const scopedKey = queryKey;
    return () => {
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [queryClient, queryKey]);

  return {
    queryKey,
    enabled: verified && (!options.adminOnly || canAdmin),
    identityLoading: meQuery.isPending,
    identityError: !meQuery.isPending && (meQuery.isError || !identity),
    identity,
    role,
    canAdmin,
    authorityKey,
    retryIdentity: () => void meQuery.refetch(),
    retryingIdentity: meQuery.isFetching,
  };
}
