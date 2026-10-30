/**
 * api/streamingExportRuns.ts — the streaming-export monitor's one read.
 *
 * ROUTE. `GET /api/v1/warehouse/connections/{id}/streaming/runs`, mounted by
 * `streaming_export.MountRoutes` (apps/api/internal/streaming_export/
 * streaming_export.go:366) behind `apikeys.RequireScope(ScopeReadReports)`;
 * the generated manifest row is `session_minimum_role: viewer`,
 * `api_key_scopes: ["read:reports"]`. The handler (`ListRuns`, :372) reads a
 * fixed 50 newest rows — there is no `limit` parameter to send — and answers
 * `{ items, last_shipped_at }`. It 404s for an unknown connection id
 * (repo.go:376) and, when the package is not mounted at all, the router 404s
 * too; the desktop reads that as "not enabled on this server" and so does
 * this module's caller.
 *
 * WHAT IS NOT HERE, ON PURPOSE. `POST .../streaming/ship` (admin, and in the
 * step-up policy at stepup/policy.go:438) ships a window synchronously. It is
 * the "starting half" the register keeps on the desk: shipping again is a
 * decision that wants the connection's configuration in front of you, and a
 * phone does not have it.
 *
 * MANY CONNECTIONS, ONE QUERY. The dock reads every streaming connection's
 * history in one TanStack query so one pull refreshes all of them; each read
 * SETTLES on its own so a 404 on one connection cannot hide the other's
 * failed window. The per-connection outcome travels as data, not as a thrown
 * error, and the section explains each one in place.
 */
import {
  normalizeStreamingExportHistory,
  type StreamingExportHistory,
} from "@/lib/streamingExportRuns";

import { rawRequest } from "./request";
import { WarehouseRequestError } from "./warehouseRuns";

export async function fetchStreamingExportHistory(
  connectionId: string,
): Promise<StreamingExportHistory> {
  const id = (connectionId ?? "").trim();
  if (!id) {
    throw new Error("A connection id is required to read its shipped windows.");
  }
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/warehouse/connections/${encodeURIComponent(id)}/streaming/runs`,
  );
  if (res.error) {
    throw new WarehouseRequestError(res.error, "Loading shipped windows");
  }
  return normalizeStreamingExportHistory(res.data);
}

export interface StreamingExportHistoryRead {
  connectionId: string;
  history: StreamingExportHistory | null;
  /** HTTP status of a failed read (0 = unreachable); null on success. */
  errorStatus: number | null;
}

function statusOf(error: unknown): number {
  if (error instanceof WarehouseRequestError) return error.status;
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return 0;
}

/**
 * Read every connection's history, settling each one independently.
 *
 * Reads run concurrently: a phone glancing at two or three streaming
 * destinations should not pay for them in series, and the handler's work per
 * call is one indexed SELECT of 50 rows.
 */
export async function loadStreamingExportHistories(
  connectionIds: readonly string[],
): Promise<StreamingExportHistoryRead[]> {
  return Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        const history = await fetchStreamingExportHistory(connectionId);
        return { connectionId, history, errorStatus: null };
      } catch (error) {
        return { connectionId, history: null, errorStatus: statusOf(error) };
      }
    }),
  );
}
