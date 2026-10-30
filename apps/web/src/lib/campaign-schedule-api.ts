// SPDX-License-Identifier: AGPL-3.0-only
//
// The campaign calendar's reschedule verb (desktop parity campaigns-24). Kept
// out of campaigns-api.ts on purpose: that module sits in the shared chunk of
// every page that lists campaigns, and this verb is only reachable from the
// calendar, which loads on demand.

import { api } from "./api";
import { CAMPAIGN_SCHEDULING_AVAILABLE } from "./campaign-operational-availability";
import { rejectCampaignScheduling, type Campaign } from "./campaigns-api";

/**
 * POST /api/v1/campaigns/{id}/schedule — move a draft or scheduled campaign
 * to a fixed instant. Gated on the shared CAMPAIGN_SCHEDULING_AVAILABLE flag:
 * while it is false the adapter rejects before transport with
 * `campaign_scheduling_unqualified`, the same code the server's release lock
 * answers with (503).
 */
export function rescheduleCampaign(
  id: string,
  scheduledAt: string,
): Promise<Campaign> {
  if (!CAMPAIGN_SCHEDULING_AVAILABLE) return rejectCampaignScheduling();
  return api.post<Campaign>(
    `/api/v1/campaigns/${encodeURIComponent(id)}/schedule`,
    { scheduled_at: scheduledAt },
    { requireOnline: true, maxAttempts: 1 },
  );
}
