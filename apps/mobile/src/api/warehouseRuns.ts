/**
 * api/warehouseRuns.ts — the warehouse sync-run monitor's five calls.
 *
 * AUTHORIZATION, READ OFF BOTH GUARDS RATHER THAN OFF EITHER ONE.
 *
 * There are TWO independent gates on every one of these routes and a session
 * has to clear both. Reading only the first is how this surface nearly shipped
 * open to viewers:
 *
 *  1. The per-route middleware in `warehouse.MountRoutes`
 *     (apps/api/internal/warehouse/warehouse.go:179-198):
 *       read  := apikeys.RequireScope(apikeys.ScopeReadReports)
 *       admin := apikeys.RequireScope(apikeys.ScopeAdmin)
 *     GET /runs (:196), /runs/{id} (:197), /runs/{id}/errors (:198),
 *     /connections (:183) and /connections/{id}/health (:185) all take `read`.
 *     `ScopeReadReports` is in the `readOnlyScopes` allow-list
 *     (apikeys/middleware.go:332-337), so on the SESSION path RequireScope
 *     admits any authenticated role. On that guard alone these are viewer
 *     routes.
 *
 *  2. `routeauth.Middleware`, mounted on the whole authenticated group
 *     (main.go:2247, and `warehouse.MountRoutes` is inside that group at
 *     main.go:3539). It evaluates the GENERATED manifest independently of the
 *     per-route scope. Every `/api/v1/warehouse/*` row in
 *     apps/api/internal/routeauth/manifest.json — including the four reads
 *     above — carries `"session_minimum_role": "admin"`,
 *     `"api_key_scopes": ["admin"]`, `"policy_source": "family:admin"`,
 *     `"review_status": "reviewed"`. `roleAllows` (routeauth/middleware.go:94)
 *     is a strict rank comparison with no custom-role escape hatch, and
 *     `ValidateRouterExact` (main.go:5414) fails startup if an authenticated
 *     route bypasses the middleware — so this is not theoretical.
 *
 * EFFECTIVE POLICY: every route in this file is owner/admin-only for a session
 * and needs the `admin` scope for an API key. A `read:reports` key is refused.
 * The screen gates on that BEFORE issuing a request, because a query that can
 * only ever answer 403 is a request the device should not pay for.
 *
 * ONE PARAMETER DELIBERATELY NOT SENT. `/connections/{id}/health` accepts
 * `?provider_check=1`, which makes the server open a live Snowflake session
 * and execute statements (warehouse.go:313). That is a probe with real
 * side-effects and a multi-second tail; a phone glancing at sync health must
 * never trigger it, so the health call here is always the cheap, cached form.
 */
import {
  normalizeWarehouseRowErrors,
  type WarehouseRowError,
} from "@/lib/warehouseRunErrors";
import {
  normalizeWarehouseConnectionHealth,
  normalizeWarehouseConnections,
  normalizeWarehouseRuns,
  type WarehouseConnection,
  type WarehouseConnectionHealth,
  type WarehouseRun,
} from "@/lib/warehouseRuns";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many runs one glance reads.
 *
 * `queryLimit(r, "limit", 25, 500)` (warehouse.go:404) would give 25 unasked.
 * 50 is chosen so the "newest run per connection" derivation in
 * `lib/warehouseVerdict` has a fighting chance of covering every connection —
 * and the verdict still discloses when the window came back full, because 50
 * is a bigger sample, not a proof.
 */
export const WAREHOUSE_RUNS_PAGE_SIZE = 50;

/** Keeps the HTTP status so the UI can tell a 403 from a 404 from a 500. */
export class WarehouseRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "WarehouseRequestError";
  }
}

async function warehouseRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new WarehouseRequestError(res.error, label);
  return res.data;
}

/**
 * True for the "your role cannot see this" answer from either guard.
 *
 * routeauth writes `insufficient_role` and RequireScope writes
 * `insufficient_scope`/`insufficient_role`; all three are the same fact to a
 * reader, and all three arrive as a 403. Branching on the status alone is
 * enough and does not depend on which guard fired first.
 */
export function isWarehouseRoleDenied(error: unknown): boolean {
  return (
    error instanceof WarehouseRequestError
      ? error.status === 403
      : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403
  );
}

export async function listWarehouseRuns(
  limit: number = WAREHOUSE_RUNS_PAGE_SIZE,
): Promise<WarehouseRun[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await warehouseRequest<unknown>(
    "GET",
    `/api/v1/warehouse/runs?${params.toString()}`,
    "Loading warehouse runs",
  );
  return normalizeWarehouseRuns(raw);
}

/**
 * The connection list exists here only to NAME the runs and to say which of
 * them are on a schedule. It is never the primary read: a connection roster is
 * configuration, and configuration belongs on the desktop.
 */
export async function listWarehouseConnections(): Promise<
  WarehouseConnection[]
> {
  const raw = await warehouseRequest<unknown>(
    "GET",
    "/api/v1/warehouse/connections",
    "Loading warehouse connections",
  );
  return normalizeWarehouseConnections(raw);
}

export async function listWarehouseRunErrors(
  runId: string,
): Promise<WarehouseRowError[]> {
  const id = (runId ?? "").trim();
  if (!id) throw new Error("A run id is required to read its errors.");
  const raw = await warehouseRequest<unknown>(
    "GET",
    `/api/v1/warehouse/runs/${encodeURIComponent(id)}/errors`,
    "Loading run errors",
  );
  return normalizeWarehouseRowErrors(raw);
}

export async function fetchWarehouseConnectionHealth(
  connectionId: string,
): Promise<WarehouseConnectionHealth> {
  const id = (connectionId ?? "").trim();
  if (!id) throw new Error("A connection id is required to read its health.");
  // No `provider_check` — see the module note. This is the cached read.
  const raw = await warehouseRequest<unknown>(
    "GET",
    `/api/v1/warehouse/connections/${encodeURIComponent(id)}/health`,
    "Loading connection health",
  );
  return normalizeWarehouseConnectionHealth(raw);
}

/**
 * Stop a connection from being picked up by the scheduler.
 *
 * `PauseConnection` (warehouse.go:458) is a straight
 * `SetConnectionStatus(..., "paused")` and answers 200 with the updated
 * connection — so unlike a 202 "accepted", the result IS the new state and the
 * screen may state it as done. It is still never queued offline: an offline
 * pause would fire on reconnect against a world that has moved on, and the
 * whole point of pausing is that it happens NOW, while the operator is
 * watching the failure.
 */
export async function pauseWarehouseConnection(
  connectionId: string,
): Promise<WarehouseConnection | null> {
  const id = (connectionId ?? "").trim();
  if (!id) throw new Error("A connection id is required to pause it.");
  const raw = await warehouseRequest<unknown>(
    "POST",
    `/api/v1/warehouse/connections/${encodeURIComponent(id)}/pause`,
    "Pausing the connection",
    {},
  );
  const [connection] = normalizeWarehouseConnections({ items: [raw] });
  return connection ?? null;
}

/** The human sentence for a failed pause, by what the server actually said. */
export function pauseErrorMessage(error: unknown): string {
  const status =
    error instanceof WarehouseRequestError
      ? error.status
      : typeof error === "object" && error !== null
        ? Number((error as { status?: unknown }).status ?? 0)
        : 0;
  if (status === 403) {
    return "Pausing a warehouse connection needs an owner or admin session.";
  }
  if (status === 404) {
    return "That connection no longer exists — someone may have deleted it.";
  }
  if (status === 0) {
    return "Couldn't reach the server, so nothing was paused.";
  }
  return "The server refused the pause. Nothing was changed.";
}
