// SPDX-License-Identifier: AGPL-3.0-only
//
// One authority read for every integration lifecycle component. It resolves
// the caller the same way the catalog detail page does (whoami under
// qk.authMe(), owner/admin outside viewer mode), derives the same
// tenant/user/role/viewer-mode scoped query-key base the page caches under,
// and re-verifies authority immediately before any write.
"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

export const ADMIN_REQUIRED_REASON =
  "Owner or admin access outside viewer mode is required to change integrations.";

export interface IntegrationLifecycleAuthority {
  pending: boolean;
  error: unknown;
  identity: MeResponse | null;
  canAdmin: boolean;
  /** Scoped key base shared with the catalog pages' integrations cache. */
  baseKey: readonly unknown[];
  /** Re-verify the exact identity before a write; throws the server-derived reason. */
  beforeWrite: (signal: AbortSignal) => Promise<void>;
}

export function useIntegrationLifecycleAuthority(): IntegrationLifecycleAuthority {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = me.isSuccess ? me.data : null;
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canAdmin = Boolean(identity) && !viewerMode && roleCanWrite(role);
  const tenantId = identity?.tenant_id ?? "anon";
  const userId = identity?.user_id ?? "anon";
  const baseKey = useMemo(
    () =>
      [
        ...base("integrations", tenantId, role ?? "none"),
        userId,
        viewerMode ? "viewer-mode" : "durable-mode",
      ] as const,
    [role, tenantId, userId, viewerMode],
  );

  const beforeWrite = useCallback(
    async (signal: AbortSignal) => {
      if (!identity) throw new Error(ADMIN_REQUIRED_REASON);
      try {
        await verifyFreshAdminAuthority(identity, signal);
      } catch (failure) {
        // The fresh identity (when the check produced one) replaces the
        // cached one so every surface on the page re-keys to the new
        // authority instead of keeping controls opened under the old one.
        const fresh = (failure as { freshIdentity?: MeResponse } | null)
          ?.freshIdentity;
        if (fresh && !signal.aborted) {
          queryClient.setQueryData(qk.authMe(), fresh);
        }
        throw failure;
      }
    },
    [identity, queryClient],
  );

  return {
    pending: me.isPending,
    error: me.isError ? me.error : null,
    identity,
    canAdmin,
    baseKey,
    beforeWrite,
  };
}
