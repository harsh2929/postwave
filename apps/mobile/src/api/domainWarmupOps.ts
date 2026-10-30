/**
 * api/domainWarmupOps.ts — starting and removing a warm-up ramp.
 *
 *   POST   /api/v1/domain-warmup            (admin)
 *   DELETE /api/v1/domain-warmup/{domain}   (admin)
 *
 * Mobile already lists, pauses and resumes ramps (useDeliverabilityDiagnostics);
 * these are the missing bookends. Both are ONLINE-ONLY: a queued create starts
 * a multi-week schedule at an unknown later moment, and a queued delete tells
 * the operator a ramp is gone while it keeps raising the daily allowance.
 */
import { rawRequest, type AIApiError } from "./request";

import { numberOr, str } from "@/lib/deliverabilityContracts";

class WarmupOpsError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "WarmupOpsError";
    this.status = error.status;
  }
}

export interface CreatedWarmupPlan {
  id: string;
  domain: string;
  targetDaily: number;
  days: number;
}

export async function createWarmupPlan(input: {
  domain: string;
  targetDaily: number;
  days?: number;
}): Promise<CreatedWarmupPlan> {
  const body: Record<string, unknown> = {
    domain: input.domain,
    target_daily: input.targetDaily,
  };
  if (input.days !== undefined) body.days = input.days;
  const res = await rawRequest<unknown>("POST", "/api/v1/domain-warmup", body);
  if (res.error) {
    throw new WarmupOpsError(res.error, "Couldn't start the warm-up plan.");
  }
  const data = (res.data ?? {}) as Record<string, unknown>;
  return {
    id: str(data.id),
    domain: str(data.domain, input.domain),
    targetDaily: Math.max(0, numberOr(data.target_daily, input.targetDaily)),
    days: Math.max(0, numberOr(data.days, input.days ?? 0)),
  };
}

export async function deleteWarmupPlan(domain: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/domain-warmup/${encodeURIComponent(domain)}`,
  );
  if (res.error) {
    throw new WarmupOpsError(res.error, "Couldn't remove the warm-up plan.");
  }
}
