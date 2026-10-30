/**
 * hooks/useSettingsRoles.ts — the workspace-roles read query.
 *
 * Same policy as usePlatformConfig's four queries, for the same reasons:
 * gated by useOnlineQueryGate, a long staleTime (role definitions change on
 * the order of months), and NO retry on a hidden status — the route's
 * effective floor is admin even though the manifest says viewer, so a 403
 * is a final answer that hides the card, not a transient to hammer.
 */
import { useQuery } from "@tanstack/react-query";

import { listWorkspaceRoles, WorkspaceRolesError } from "@/api/workspaceRoles";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isPlatformSurfaceHidden } from "@/lib/platformConfig";

const STALE_MS = 5 * 60_000;

/** True when the error means "this reader may not see the roles card". */
export function isHiddenRolesError(error: unknown): boolean {
  return (
    error instanceof WorkspaceRolesError &&
    (isPlatformSurfaceHidden(error.status) || error.status === 401)
  );
}

export function useWorkspaceRolesQuery() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["settings-workspace-roles", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    retry: (count, error) => !isHiddenRolesError(error) && count < 2,
    queryFn: listWorkspaceRoles,
  });
}
