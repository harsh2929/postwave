/**
 * api/assuranceLegalHolds.ts — place, list and release an assurance legal hold.
 *
 * ASSURE#6 / VERB#8. All three routes are mounted at
 * apps/api/internal/assurancelegalholdapi/handlers.go:61-63 behind
 * rbac.PermAuditConfigure, and the generated manifest floors all three at `admin`
 * (reviewed). They had no client on ANY surface.
 *
 * `campaign_id` is optional and omitting it places a TENANT-WIDE hold, so it is
 * omitted deliberately rather than sent empty — the two are the same on the wire,
 * but the caller should have to mean it.
 */
import { rawRequest } from "@/api/request";
import {
  parseAssuranceLegalHolds,
  type AssuranceLegalHold,
} from "@/lib/assuranceLegalHold";

const BASE = "/api/v1/assurance/legal-holds";

export async function fetchAssuranceLegalHolds(): Promise<AssuranceLegalHold[]> {
  const res = await rawRequest<unknown>("GET", BASE);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseAssuranceLegalHolds(res.data);
}

export async function placeAssuranceLegalHold(input: {
  reason: string;
  /** Omit for a tenant-wide hold. */
  campaignId?: string;
}): Promise<void> {
  const campaignId = input.campaignId?.trim() ?? "";
  const res = await rawRequest<unknown>("POST", BASE, {
    reason: input.reason.trim(),
    ...(campaignId ? { campaign_id: campaignId } : {}),
  });
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}

export async function releaseAssuranceLegalHold(input: {
  holdId: string;
  reason: string;
}): Promise<void> {
  const holdId = input.holdId.trim();
  if (!holdId) throw new Error("hold id is required");
  const res = await rawRequest<unknown>(
    "POST",
    `${BASE}/${encodeURIComponent(holdId)}/release`,
    { reason: input.reason.trim() },
  );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}
