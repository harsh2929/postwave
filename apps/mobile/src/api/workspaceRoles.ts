/**
 * api/workspaceRoles.ts — the roles read behind Settings' workspace-roles card.
 *
 * GET /api/v1/roles — mounted at apps/api/internal/server/audit_operations.go
 * (MountAuditOperationsSurface). The routeauth manifest floor is viewer, but
 * the route middleware additionally requires admin, so non-admin sessions get
 * a 403 — which this surface treats as "hide the card", the same policy
 * api/platformConfig.ts records for its four reads.
 *
 * READ-ONLY: PUT /roles/{id}/scopes stays on the web admin (see the lib
 * header for why re-permissioning a whole role is not a phone verb).
 */
import { rawRequest } from "./request";

import {
  normalizeWorkspaceRoles,
  type WorkspaceRoleView,
} from "@/lib/workspaceRoles";

export class WorkspaceRolesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message || "Couldn't load workspace roles.");
    this.name = "WorkspaceRolesError";
    this.status = status;
  }
}

export async function listWorkspaceRoles(): Promise<WorkspaceRoleView[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/roles");
  if (res.error) {
    throw new WorkspaceRolesError(res.error.status, res.error.message);
  }
  return normalizeWorkspaceRoles(res.data);
}
