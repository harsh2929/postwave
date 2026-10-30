// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Role × audit-scope matrix (mirrors desktop's editable RBAC grid) for the
// team settings page, which loads this module after first paint.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ApiError } from "@/lib/api";
import type { AuthRole, MeResponse } from "@/lib/auth-api";
import { base, STALE } from "@/lib/query-keys";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  isPrivilegedScope,
  listRoles,
  scopeHeaderLabel,
  toggleScope,
  updateRoleScopes,
  type RolesResponse,
  type RoleWithScopes,
} from "@/lib/team-roles-api";

const TEAM_ROLES_SCOPE = "team-roles";

async function loadRoleMatrix(signal?: AbortSignal): Promise<RolesResponse> {
  try {
    return await listRoles({ signal });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      // Owner-only read surface; non-owners simply don't see the grid.
      return { roles: [], availableScopes: [] };
    }
    throw err;
  }
}

interface RoleScopeMatrixProps {
  canWrite: boolean;
  identityLoading: boolean;
  identityReady: boolean;
  role: AuthRole | null;
  tenantId: string;
  userId: string;
  viewerMode: boolean;
  identity: MeResponse | null;
}

interface UpdateRoleScopesVariables {
  nextScopes: string[];
  roleId: string;
  roleName: string;
}

export function RoleScopeMatrix({
  canWrite,
  identityLoading,
  identityReady,
  role,
  tenantId,
  userId,
  viewerMode,
  identity,
}: RoleScopeMatrixProps) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const settingsBaseKey = useMemo(
    () =>
      [
        ...base("settings", tenantId, role),
        userId,
        viewerMode ? "viewer-mode" : "durable-mode",
      ] as const,
    [role, tenantId, userId, viewerMode],
  );
  const rolesKey = useMemo(
    () => [...settingsBaseKey, TEAM_ROLES_SCOPE] as const,
    [settingsBaseKey],
  );
  const rolesQuery = useQuery({
    queryKey: rolesKey,
    queryFn: ({ signal }) => loadRoleMatrix(signal),
    enabled: identityReady && canWrite,
    staleTime: STALE.list,
  });
  const updateScopesMutation = useMutation<
    unknown,
    unknown,
    UpdateRoleScopesVariables,
    unknown
  >({
    mutationFn: async ({ roleId, nextScopes }) => {
      if (!identity || !canWrite)
        throw new Error("Owner or admin access is required.");
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await updateRoleScopes(roleId, [...nextScopes], {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : "Could not update scopes.",
      );
    },
    onSuccess: (_result, variables) => {
      toast.success(`Updated ${variables.roleName} scopes.`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: settingsBaseKey,
        exact: false,
      });
    },
  });
  const roles = Array.isArray(rolesQuery.data?.roles)
    ? rolesQuery.data?.roles
    : [];
  const scopes = Array.isArray(rolesQuery.data?.availableScopes)
    ? rolesQuery.data?.availableScopes
    : [];
  const error =
    rolesQuery.error instanceof Error
      ? rolesQuery.error.message
      : rolesQuery.isError
        ? "Could not load roles — this is a failed request, not a workspace with no roles."
        : null;

  // `canWrite` mirrors the query's own `enabled` gate: a disabled query sits at
  // isPending forever, so without it a viewer (or an admin previewing viewer
  // mode) would be pinned to "Loading role matrix…" instead of falling through
  // to the read-only/hidden branches below.
  const loading =
    identityLoading ||
    (identityReady && canWrite && rolesQuery.isPending && !rolesQuery.data);
  const savingId = updateScopesMutation.isPending
    ? (updateScopesMutation.variables?.roleId ?? null)
    : null;

  const [pendingGrant, setPendingGrant] = useState<{
    role: RoleWithScopes;
    scope: string;
  } | null>(null);
  const grantFocusRef = useRef<HTMLInputElement | null>(null);
  const updatingRoleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (identityReady && canWrite) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    updatingRoleIdsRef.current.clear();
    setPendingGrant(null);
    void queryClient.cancelQueries({ queryKey: rolesKey });
    queryClient.removeQueries({ queryKey: rolesKey });
  }, [canWrite, identityReady, queryClient, rolesKey]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function commitToggle(
    role: RoleWithScopes,
    scope: string,
    enabled: boolean,
  ): Promise<unknown> {
    if (updatingRoleIdsRef.current.size > 0) {
      return Promise.reject(
        new Error(
          `A scope update for ${role.name} is already in progress. Wait for it to finish and try again.`,
        ),
      );
    }
    updatingRoleIdsRef.current.add(role.id);
    // A privileged confirmation can stay open while a background refresh
    // updates this role. Resolve the baseline by stable ID at commit time so
    // confirming one scope never replaces newer assignments with the object
    // snapshot captured when the dialog opened.
    const currentRole = queryClient
      .getQueryData<RolesResponse>(rolesKey)
      ?.roles.find((candidate) => candidate.id === role.id);
    const next = toggleScope(
      currentRole?.assignedScopes ?? role.assignedScopes,
      scope,
      enabled,
    );
    return updateScopesMutation
      .mutateAsync({
        nextScopes: next,
        roleId: role.id,
        roleName: role.name,
      })
      .finally(() => updatingRoleIdsRef.current.delete(role.id));
  }

  function onToggle(
    role: RoleWithScopes,
    scope: string,
    enabled: boolean,
    trigger: HTMLInputElement | null,
  ) {
    // React mutation state is committed on the next render. Guard by role ID
    // before consulting it so two same-tick checkbox events cannot enqueue
    // competing replacement payloads for the same role.
    if (updatingRoleIdsRef.current.has(role.id)) return;
    // Granting a high-privilege scope confirms first (SETC-015); revoking and
    // low-risk scopes stay one-click.
    if (enabled && isPrivilegedScope(scope)) {
      grantFocusRef.current = trigger;
      setPendingGrant({ role, scope });
      return;
    }
    void commitToggle(role, scope, enabled).catch(() => {
      // The mutation's onError handler restores the cache and owns the toast.
    });
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Audit-scope access</CardTitle>
          <CardDescription>Loading role matrix…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (roles.length === 0 && !error) {
    // Either no custom roles or the caller isn't an owner — hide silently.
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit-scope access</CardTitle>
        <CardDescription>
          Grant each role access to specific audit scopes.{" "}
          {canWrite
            ? "Toggle a cell to change a role's scopes."
            : "Read-only — only owners and admins can edit."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="mb-3 text-sm text-destructive-emphasis">
            {error}
          </p>
        )}
        <div className="border rounded-md overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {/* Role column is pinned so it stays visible while the scope
                    columns scroll right (SETC-014). */}
                <th
                  scope="col"
                  className="sticky left-0 z-10 bg-muted/50 text-left px-3 py-2 font-medium"
                >
                  Role
                </th>
                {scopes.map((s) => (
                  <th
                    scope="col"
                    key={s}
                    className="px-3 py-2 font-medium text-center whitespace-nowrap"
                    title={s}
                  >
                    {/* Keep the action prefix so read/write columns differ
                        (SETC-013). */}
                    {scopeHeaderLabel(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id} className="border-t">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2">
                    <div className="font-medium capitalize">{role.name}</div>
                    {role.description && (
                      <div className="text-xs text-muted-foreground">
                        {role.description}
                      </div>
                    )}
                  </td>
                  {scopes.map((s) => {
                    const checked = role.assignedScopes.includes(s);
                    return (
                      <td key={s} className="px-3 py-2 text-center">
                        <label className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md has-[:disabled]:cursor-not-allowed sm:size-8">
                          <Checkbox
                            aria-label={`${role.name}: ${s}`}
                            checked={checked}
                            disabled={!canWrite || savingId === role.id}
                            onChange={(e) =>
                              void onToggle(
                                role,
                                s,
                                e.target.checked,
                                e.currentTarget,
                              )
                            }
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>

      <ConfirmDialog
        open={pendingGrant !== null}
        onOpenChange={(open) => {
          if (!open) setPendingGrant(null);
        }}
        title="Grant a high-privilege scope?"
        description={
          pendingGrant
            ? `Grant "${scopeHeaderLabel(pendingGrant.scope)}" to the ${pendingGrant.role.name} role? This is a broad audit/admin capability. You can revoke it later.`
            : ""
        }
        confirmLabel="Grant scope"
        confirmVariant="default"
        fallbackFocusRef={grantFocusRef}
        onConfirm={() =>
          pendingGrant
            ? commitToggle(pendingGrant.role, pendingGrant.scope, true).then(
                () => undefined,
              )
            : Promise.resolve()
        }
      />
    </Card>
  );
}
