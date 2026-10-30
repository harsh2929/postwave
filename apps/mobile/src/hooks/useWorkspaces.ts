/**
 * hooks/useWorkspaces.ts — "which workspaces does this email belong to".
 *
 * Deliberately NOT offline-capable, for the same reason `useSessions` is not:
 * the only thing this list is used for is an action (switching), the action
 * itself requires the network, and a cached membership list is a claim about
 * access that may have been revoked since. When the gate is closed the caller
 * renders a reconnect notice rather than a stale roster.
 */
import { useQuery } from "@tanstack/react-query";

import { listWorkspaces } from "@/api/workspaces";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  sortWorkspaces,
  type WorkspaceSummary,
} from "@/lib/workspaceSwitchPolicy";

export type { WorkspaceSummary };

export const WORKSPACES_QUERY_KEY = "auth-workspaces" as const;

export class WorkspacesApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "WorkspacesApiError";
    this.code = code;
  }
}

export function useWorkspaces() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [WORKSPACES_QUERY_KEY, gate.baseUrl, gate.tenantId, gate.userId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(gate.baseUrl),
    // Membership is access state; never serve a stale roster on re-focus.
    staleTime: 0,
    queryFn: async (): Promise<WorkspaceSummary[]> => {
      if (!gate.baseUrl) {
        throw new WorkspacesApiError("No workspace is connected.");
      }
      const res = await listWorkspaces(gate.baseUrl);
      if (res.error) {
        throw new WorkspacesApiError(
          res.error.message || "Couldn't load your workspaces.",
          res.error.code,
        );
      }
      return sortWorkspaces(res.data);
    },
  });
}
