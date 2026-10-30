/**
 * api/aiRegressionRuns.ts — the regression evidence workspace's reads.
 *
 *   GET /api/v1/ai-regression/runs[?limit=]     read:reports (viewer)
 *   GET /api/v1/ai-regression/runs/{id}         read:reports (viewer)
 *   GET /api/v1/ai-regression/runs/{id}/results read:reports (viewer)
 *
 * Mounted at apps/api/internal/ai_regression/handlers.go:70-73.
 *
 * `limit` is parsed by parseLimit, which returns 0 for anything non-numeric —
 * so only a plain positive integer is ever sent.
 *
 * Payloads are `unknown`: the list and results are `{items}` envelopes while
 * the single run is a bare object, and lib/aiRegressionRuns owns that.
 */
import { rawRequest, type AIApiResult } from "./request";

export async function listRegressionRuns(
  limit?: number,
): Promise<AIApiResult<unknown>> {
  const safe =
    typeof limit === "number" && Number.isInteger(limit) && limit > 0
      ? `?limit=${limit}`
      : "";
  return rawRequest<unknown>("GET", `/api/v1/ai-regression/runs${safe}`);
}

export async function getRegressionRun(
  id: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "GET",
    `/api/v1/ai-regression/runs/${encodeURIComponent(id)}`,
  );
}

export async function getRegressionRunResults(
  id: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "GET",
    `/api/v1/ai-regression/runs/${encodeURIComponent(id)}/results`,
  );
}
