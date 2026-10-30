// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Campaign scheduling release policy — the compile-time flag desktop gates
 * every schedule entry point behind.
 *
 * Keep this synchronized with:
 *   - apps/desktop/src/lib/campaign-operational-availability.ts
 *   - CAMPAIGN_SCHEDULING_RELEASE_HOLD in src/lib/campaigns-api.ts (the
 *     sentence every held web adapter rejects with)
 *
 * Scheduling stays unavailable in client builds until the server has a
 * release-qualified, recoverable scheduler contract. Keep this shared with
 * every schedule entry point so one surface cannot overstate what the
 * delivery system can currently guarantee.
 */
export const CAMPAIGN_SCHEDULING_AVAILABLE: boolean = false;

export const CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON =
  "Scheduling is temporarily unavailable while durable delivery and recovery are being verified. You can keep drafting and reviewing this campaign.";
