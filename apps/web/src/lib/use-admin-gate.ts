// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared client hook: resolves the current user's role from whoami and exposes
// a `canWrite` flag for the owner/admin-gated governance surfaces (team,
// discounts, approvals, suppressions, SCIM). Writes on these pages are
// additionally enforced server-side (ScopeAdmin), but gating the UI keeps
// non-admins from seeing controls that would 403.

"use client";

import { useQuery } from "@tanstack/react-query";

import {
  effectiveAuthRole,
  whoami,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

export type AdminGateState = "loading" | "writer" | "read-only" | "error";

export interface AdminGate {
  /** Exact identity snapshot that produced this gate decision. */
  identity?: MeResponse | null;
  role: AuthRole | null;
  /** Owner or admin — may use the write controls. */
  canWrite: boolean;
  loading: boolean;
  state: AdminGateState;
  retrying: boolean;
  retry: () => void;
}

/** True for roles allowed to mutate governance/admin surfaces. */
export function roleCanWrite(role: AuthRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function useAdminGate(): AdminGate {
  const identity = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const role = identity.data ? effectiveAuthRole(identity.data) : null;
  const loading = identity.isPending;
  const state: AdminGateState = loading
    ? "loading"
    : identity.isError || !identity.data
      ? "error"
      : identity.data.viewer_mode === true
        ? "read-only"
        : roleCanWrite(role)
          ? "writer"
          : "read-only";

  return {
    identity: identity.data ?? null,
    role,
    canWrite: state === "writer",
    loading,
    state,
    retrying: identity.isFetching && state === "error",
    retry: () => {
      void identity.refetch();
    },
  };
}
