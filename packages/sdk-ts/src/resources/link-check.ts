import { Resource } from "./_base.js";

export interface LinkCheckResult {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
}

/**
 * Pre-send link checker. POSTs to /api/v1/campaigns/{id}/check-links,
 * which extracts every absolute href from the campaign body and HEAD-
 * requests each one with a 5s timeout.
 *
 * Lives in its own resource (not bolted onto CampaignsResource) so that
 * Domain B's parallel work on `campaigns.ts` does not collide.
 */
export class LinkCheckResource extends Resource {
  check(campaignId: string): Promise<LinkCheckResult[]> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/check-links`,
    );
  }
}
