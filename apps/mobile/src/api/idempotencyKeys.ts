/**
 * api/idempotencyKeys.ts — the idempotency ledger, read-only.
 *
 *   GET /api/v1/idempotency/stats  (admin)
 *   GET /api/v1/idempotency/keys   (admin) — ?state=pending&limit=
 *
 * DELIBERATELY NOT HERE: `DELETE /api/v1/idempotency/keys/{key}`. Deleting a
 * key removes a deduplication guarantee — the next retry of that request
 * EXECUTES instead of replaying — which is the direction that causes the
 * duplicate an operator came here to diagnose. Also not here: the detail and
 * replay routes, whose payloads carry a stored response body.
 */
import { rawRequest, type AIApiError } from "./request";

import {
  toIdempotencyKey,
  toIdempotencyStats,
  type IdempotencyKeyLike,
  type IdempotencyStatsLike,
} from "@/lib/idempotencyKeys";

class IdempotencyError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "IdempotencyError";
    this.status = error.status;
  }
}

export async function fetchIdempotencyStats(): Promise<IdempotencyStatsLike | null> {
  const res = await rawRequest<unknown>("GET", "/api/v1/idempotency/stats");
  if (res.error) {
    throw new IdempotencyError(res.error, "Couldn't load the idempotency ledger.");
  }
  return toIdempotencyStats(res.data);
}

/** Mid-flight keys only — the ones anybody is ever looking for. */
export async function listPendingIdempotencyKeys(
  limit = 25,
): Promise<IdempotencyKeyLike[]> {
  const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 25;
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/idempotency/keys?state=pending&limit=${bounded}`,
  );
  if (res.error) {
    throw new IdempotencyError(res.error, "Couldn't load in-flight requests.");
  }
  const data = res.data as { items?: unknown; keys?: unknown } | unknown[] | null;
  const raw = Array.isArray(data)
    ? data
    : ((data as { items?: unknown })?.items ??
      (data as { keys?: unknown })?.keys ??
      []);
  const list = Array.isArray(raw) ? raw : [];
  const out: IdempotencyKeyLike[] = [];
  for (const entry of list) {
    const row = toIdempotencyKey(entry);
    if (row) out.push(row);
  }
  return out;
}
