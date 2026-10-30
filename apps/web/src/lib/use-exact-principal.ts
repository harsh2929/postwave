// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { whoami } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { qk, STALE } from "@/lib/query-keys";

/** Shared current-principal gate for account-security surfaces. */
export function useExactPrincipal() {
  const query = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = query.isSuccess ? query.data : null;
  return {
    identity,
    principalKey: exactPrincipalKey(identity),
    loading: query.isPending,
    error: !query.isPending && (query.isError || !identity),
    retrying: query.isFetching && query.isError,
    retry: () => void query.refetch(),
  };
}
