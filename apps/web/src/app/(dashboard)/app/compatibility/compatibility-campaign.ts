// SPDX-License-Identifier: AGPL-3.0-only

import type { Campaign } from "@/lib/campaigns-api";

/**
 * Compatibility report endpoints only have meaningful evidence for campaigns
 * that have actually been sent. The campaign list is newest-first, so simply
 * taking the first row frequently selects a draft or a scheduled campaign and
 * turns a healthy workspace into a burst of expected 404 responses.
 */
export function selectReportableCampaign(
  campaigns: readonly Campaign[],
): Campaign | undefined {
  return campaigns.find(
    (campaign) => campaign.status === "sent" || Boolean(campaign.sent_at),
  );
}
