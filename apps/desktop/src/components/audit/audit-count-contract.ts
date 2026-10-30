import type { AuditCountResponse } from "../../lib/api-client";

/**
 * API generics describe the expected payload at compile time, but a proxy,
 * stale server, or partial rollout can still return a successful JSON body
 * with a different shape. Keep invalid estimates out of renderer state so
 * formatting and export decisions never operate on `undefined` or NaN.
 */
export function parseAuditCount(value: unknown): AuditCountResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.totalEstimate !== "number" ||
    !Number.isFinite(candidate.totalEstimate) ||
    candidate.totalEstimate < 0 ||
    (candidate.confidence !== "exact" &&
      candidate.confidence !== "approximate")
  ) {
    return null;
  }
  return candidate as unknown as AuditCountResponse;
}
