/**
 * api/campaignSummary.ts — the post-send AI summary read + regenerate.
 *
 * Mounted at apps/api/internal/campaign_summary/campaign_summary.go:90-93:
 *   GET  /api/v1/campaigns/{id}/summary             read scope
 *   POST /api/v1/campaigns/{id}/summary/regenerate  write scope, rate-limited
 *
 * The regenerate POST is throttled by the gateway's shared expensive-tenant
 * limiter, because it triggers a paid voice-service round trip; `force` is
 * admin-only server-side and is deliberately NOT exposed here. A phone should
 * not be able to re-burn the LLM budget on a summary that already exists — the
 * ordinary POST regenerates when stale and is the only thing this surface needs.
 */
import { rawRequest, type AIApiResult } from "./request";
import type { CampaignSummaryWire } from "@/lib/campaignAiSummary";

export async function getCampaignSummary(
  campaignId: string,
): Promise<AIApiResult<CampaignSummaryWire>> {
  return rawRequest<CampaignSummaryWire>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/summary`,
  );
}

export async function regenerateCampaignSummary(
  campaignId: string,
): Promise<AIApiResult<CampaignSummaryWire>> {
  return rawRequest<CampaignSummaryWire>(
    "POST",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/summary/regenerate`,
    {},
  );
}
