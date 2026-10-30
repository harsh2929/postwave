// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { CampaignPollReceiptsPanel } from "@/components/campaigns/campaign-poll-receipts-panel";
import { HoldoutLiftPanel } from "@/components/campaigns/holdout-lift-panel";
import { VanityPathsPanel } from "@/components/campaigns/vanity-paths-panel";
import type { RoleKey } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";

import { CampaignAssurancePanel } from "./campaign-assurance-panel";

export function CampaignOperationalPanels({
  campaignId,
  tenantId,
  role,
  identity,
  canOverride,
  canEdit,
  canApply,
  campaignETag,
  canConfigureHoldout,
  canConfigureVanity,
  hasSemanticPoll,
  canConfigurePolls,
  pollConfigurationBlockedReason,
}: {
  campaignId: string;
  tenantId: string;
  role: RoleKey;
  identity: MeResponse | null | undefined;
  canOverride: boolean;
  canEdit: boolean;
  canApply: boolean;
  campaignETag: string | null;
  canConfigureHoldout: boolean;
  canConfigureVanity: boolean;
  hasSemanticPoll: boolean;
  canConfigurePolls: boolean;
  pollConfigurationBlockedReason?: string;
}) {
  return (
    <>
      <CampaignAssurancePanel
        campaignId={campaignId}
        tenantId={tenantId}
        role={role}
        canOverride={canOverride}
        canEdit={canEdit}
        canApply={canApply}
        campaignETag={campaignETag}
        identity={identity}
      />
      <HoldoutLiftPanel
        campaignId={campaignId}
        tenantId={tenantId}
        role={role}
        canConfigure={canConfigureHoldout}
        identity={identity}
      />
      <VanityPathsPanel
        campaignId={campaignId}
        tenantId={tenantId}
        role={role}
        canConfigure={canConfigureVanity}
        identity={identity}
      />
      <CampaignPollReceiptsPanel
        campaignId={campaignId}
        tenantId={tenantId}
        role={role}
        hasSemanticPoll={hasSemanticPoll}
        canConfigure={canConfigurePolls}
        configurationBlockedReason={pollConfigurationBlockedReason}
        identity={identity}
      />
    </>
  );
}
