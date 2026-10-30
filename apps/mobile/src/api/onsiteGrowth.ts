/**
 * api/onsiteGrowth.ts — transport for one form's onsite-growth configuration.
 *
 * Routes (apps/api/internal/onsite_growth/onsite_growth.go:201-215; mounted
 * ungated at main.go:3352-3356):
 *   GET /api/v1/onsite-growth/forms/{form_id}/targeting     read:campaigns
 *   PUT /api/v1/onsite-growth/forms/{form_id}/targeting     write:campaigns
 *       (admin floor on the session path per the routeauth manifest)
 *   GET /api/v1/onsite-growth/forms/{form_id}/experiments   read:campaigns
 *   GET /api/v1/onsite-growth/forms/{form_id}/spin/rewards  read:campaigns
 *
 * A 404 from the targeting GET is a RESTING STATE — the repo answers
 * ErrNotFound when no row was ever configured — so it maps to null rather
 * than throwing, exactly as the referral programme read treats its 404.
 *
 * Parsing lives in lib/onsiteGrowth (import-free) so the shapes are
 * node-tested; this module is only URLs and envelopes.
 */
import {
  parseOnsiteExperiments,
  parseOnsiteSpinRewards,
  parseOnsiteTargeting,
  type OnsiteExperimentSummary,
  type OnsiteSpinRewardSummary,
  type OnsiteTargeting,
} from "@/lib/onsiteGrowth";

import { checkedApiResult, rawRequest } from "./request";

function onsiteBase(formId: string): string {
  return `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}`;
}

/** Null = never configured (the 404 resting state). Throws on real failures. */
export async function fetchOnsiteTargeting(
  formId: string,
): Promise<OnsiteTargeting | null> {
  const res = await rawRequest<unknown>("GET", `${onsiteBase(formId)}/targeting`);
  if (res.error?.status === 404) return null;
  const checked = await checkedApiResult(Promise.resolve(res));
  return parseOnsiteTargeting(checked.data);
}

export async function fetchOnsiteExperiments(
  formId: string,
): Promise<OnsiteExperimentSummary[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${onsiteBase(formId)}/experiments`),
  );
  return parseOnsiteExperiments(res.data);
}

export async function fetchOnsiteSpinRewards(
  formId: string,
): Promise<OnsiteSpinRewardSummary[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${onsiteBase(formId)}/spin/rewards`),
  );
  return parseOnsiteSpinRewards(res.data);
}

/**
 * The FULL-REPLACE upsert. The body must be `buildTargetingStatusPut(...)` —
 * the whole fetched record with only `status` changed — because the server's
 * `ON CONFLICT … DO UPDATE` overwrites every column with what this says.
 */
export async function putOnsiteTargeting(
  formId: string,
  body: Record<string, unknown>,
): Promise<OnsiteTargeting | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("PUT", `${onsiteBase(formId)}/targeting`, body),
  );
  return parseOnsiteTargeting(res.data);
}
