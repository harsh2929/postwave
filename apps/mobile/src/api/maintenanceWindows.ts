/**
 * api/maintenanceWindows.ts — the tenant-admin CRUD for maintenance windows.
 *
 *   GET    /api/v1/maintenance-windows        manifest viewer
 *   POST   /api/v1/maintenance-windows        admin → 201 {id}
 *   PATCH  /api/v1/maintenance-windows/{id}   admin → {updated: true}
 *   DELETE /api/v1/maintenance-windows/{id}   admin → {cancelled: true} (soft)
 *
 * The Go mount wraps every verb in RequireScope(ScopeAdmin), which floors a
 * SESSION at admin too (apikeys/middleware.go requireAdminRoleForScopes), so a
 * viewer's GET answers 403 despite the manifest — the card treats that as
 * "not this reader's to see" and hides, the same policy api/platformConfig.ts
 * records.
 *
 * Mounted at apps/api/internal/maintenance/maintenance.go:65.
 */
import { rawRequest, type AIApiResult } from "./request";

import {
  normalizeMaintenanceWindows,
  type MaintenanceCreateBody,
  type MaintenanceStatus,
  type MaintenanceWindowView,
} from "@/lib/maintenanceWindows";

const PATH = "/api/v1/maintenance-windows";

export async function listMaintenanceWindows(): Promise<
  AIApiResult<MaintenanceWindowView[]>
> {
  const res = await rawRequest<unknown>("GET", PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeMaintenanceWindows(res.data), error: null };
}

export async function createMaintenanceWindow(
  body: MaintenanceCreateBody,
): Promise<AIApiResult<{ id: string }>> {
  return rawRequest<{ id: string }>("POST", PATH, body);
}

export async function setMaintenanceWindowStatus(
  id: string,
  status: MaintenanceStatus,
): Promise<AIApiResult<{ updated: boolean }>> {
  return rawRequest<{ updated: boolean }>(
    "PATCH",
    `${PATH}/${encodeURIComponent(id)}`,
    { status },
  );
}

export async function cancelMaintenanceWindow(
  id: string,
): Promise<AIApiResult<{ cancelled: boolean }>> {
  return rawRequest<{ cancelled: boolean }>(
    "DELETE",
    `${PATH}/${encodeURIComponent(id)}`,
  );
}
