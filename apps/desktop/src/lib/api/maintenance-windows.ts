// Typed client for scheduled maintenance windows (apps/api/internal/maintenance),
// mounted at /api/v1/maintenance-windows*. A tenant admin schedules a window
// (title, affected components, time range) during which the platform surfaces /
// governs a maintenance state — full CRUD across 4 routes, but no client. Shapes
// verified against internal/maintenance/maintenance.go.
import type { ApiRequester, ApiResult } from "./result";

export interface MaintenanceWindow {
  id: string;
  tenant_id?: string;
  title: string;
  description: string;
  components: string[];
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
}

export interface CreateMaintenanceWindowInput {
  title: string;
  description?: string;
  components?: string[];
  starts_at: string;
  ends_at: string;
}

export interface PatchMaintenanceWindowInput {
  title?: string;
  description?: string;
  status?: string;
  starts_at?: string;
  ends_at?: string;
}

interface WindowsEnvelope {
  windows: MaintenanceWindow[];
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

// createMaintenanceWindowsApi wires the 4 mounted routes.
export function createMaintenanceWindowsApi(request: ApiRequester) {
  return {
    // GET /api/v1/maintenance-windows — the tenant's windows.
    list(): Promise<ApiResult<MaintenanceWindow[]>> {
      return request<WindowsEnvelope>("/api/v1/maintenance-windows").then((res) =>
        res.error ? res : { data: res.data.windows ?? [] },
      );
    },

    // POST /api/v1/maintenance-windows — schedule a window (admin).
    create(input: CreateMaintenanceWindowInput): Promise<ApiResult<{ id: string }>> {
      return request<{ id: string }>("/api/v1/maintenance-windows", jsonInit("POST", input));
    },

    // PATCH /api/v1/maintenance-windows/{id} — edit / change status (admin).
    patch(id: string, input: PatchMaintenanceWindowInput): Promise<ApiResult<{ updated: boolean }>> {
      return request<{ updated: boolean }>(
        `/api/v1/maintenance-windows/${encodeURIComponent(id)}`,
        jsonInit("PATCH", input),
      );
    },

    // DELETE /api/v1/maintenance-windows/{id} — cancel a window (admin).
    cancel(id: string): Promise<ApiResult<{ cancelled: boolean }>> {
      return request<{ cancelled: boolean }>(
        `/api/v1/maintenance-windows/${encodeURIComponent(id)}`,
        jsonInit("DELETE"),
      );
    },
  };
}

export type MaintenanceWindowsApi = ReturnType<typeof createMaintenanceWindowsApi>;
