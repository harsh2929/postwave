// SPDX-License-Identifier: AGPL-3.0-only

import type { MeResponse } from "@/lib/auth-api";

/**
 * What every panel on the campaign activity page needs to know, resolved once
 * by the page: which campaign, the tenant/role-scoped cache key it lives under
 * (`qk.campaign(...)`, so a panel's reads invalidate with the campaign and are
 * never served to another tenant or role), and who is looking.
 *
 * `identityReady` gates every read: a query keyed before identity resolves
 * would be an `anon` cache entry the next signed-in person could be served.
 */
export interface CampaignPanelScope {
  campaignId: string;
  campaignKey: readonly unknown[];
  identity: MeResponse | null;
  identityReady: boolean;
}

/** One place for the panel card chrome so the page reads as one surface. */
export const PANEL_CLASS = "rounded-md border bg-card p-4";
