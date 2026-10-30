/**
 * api/listsHygiene.ts — transport for the sunset (list-hygiene) policy
 * surface. Parsers, validation and the role note live in lib/listHygiene.ts.
 *
 * Server: apps/api/internal/sunset/handlers.go (mounted, no release gate).
 * Policies list/create/update are ADMIN; executions viewer.
 *
 * THERE IS NO RUN CALL HERE ON PURPOSE: the run endpoint exists server-side
 * but the desktop anchor deliberately withholds it (draft mode — see
 * lib/listHygiene.ts header), so mobile ships definitions and evidence
 * without an execution affordance. Create/update are ONLINE-ONLY and never
 * the offline outbox — a policy definition materialising hours after it was
 * typed would start suppressing people at a moment nobody chose.
 */
import { rawRequest } from "@/api/request";
import {
  parseSunsetExecutions,
  parseSunsetPolicies,
  parseSunsetPolicy,
  sunsetPolicyBody,
  type SunsetExecution,
  type SunsetPolicy,
  type SunsetPolicyDraft,
} from "@/lib/listHygiene";

const BASE = "/api/v1/sunset/policies";

function throwEnvelope(
  error: { message?: string; status?: number },
  fallback: string,
): never {
  throw Object.assign(new Error(error.message || fallback), error);
}

export async function fetchSunsetPolicies(): Promise<SunsetPolicy[]> {
  const res = await rawRequest<unknown>("GET", BASE);
  if (res.error) throwEnvelope(res.error, "Couldn't load sunset policies.");
  return parseSunsetPolicies(res.data);
}

export async function createSunsetPolicy(
  draft: SunsetPolicyDraft,
): Promise<SunsetPolicy | null> {
  const res = await rawRequest<unknown>("POST", BASE, sunsetPolicyBody(draft));
  if (res.error) throwEnvelope(res.error, "Couldn't create the policy.");
  return parseSunsetPolicy(res.data);
}

export async function updateSunsetPolicy(
  id: string,
  draft: SunsetPolicyDraft,
): Promise<SunsetPolicy | null> {
  const res = await rawRequest<unknown>(
    "PUT",
    `${BASE}/${encodeURIComponent(id)}`,
    sunsetPolicyBody(draft),
  );
  if (res.error) throwEnvelope(res.error, "Couldn't save the policy.");
  return parseSunsetPolicy(res.data);
}

export async function fetchSunsetExecutions(
  id: string,
  limit = 50,
): Promise<SunsetExecution[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/executions?limit=${limit}`,
  );
  if (res.error) throwEnvelope(res.error, "Couldn't load the run history.");
  return parseSunsetExecutions(res.data);
}
