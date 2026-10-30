/**
 * api/campaignPreviewAs.ts — "what does ONE recipient actually get?"
 *
 * Both endpoints are read-scope and mutate nothing (compose.go:64,
 * preview_as.go:50), so a viewer may use them.
 */
import { rawRequest, type AIApiResult } from "./request";

import type {
  CampaignPreviewAsResponse,
  CampaignRegionsResponse,
} from "@/lib/campaignPreviewAs";

/** GET /api/v1/campaigns/{id}/regions */
export async function getCampaignRegions(
  campaignId: string,
): Promise<AIApiResult<CampaignRegionsResponse>> {
  return rawRequest<CampaignRegionsResponse>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/regions`,
  );
}

/** POST /api/v1/campaigns/{id}/preview-as */
export async function previewCampaignAsSubscriber(
  campaignId: string,
  subscriberEmail: string,
): Promise<AIApiResult<CampaignPreviewAsResponse>> {
  return rawRequest<CampaignPreviewAsResponse>(
    "POST",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/preview-as`,
    { subscriber_email: subscriberEmail },
  );
}
