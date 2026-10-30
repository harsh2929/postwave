/**
 * lib/campaignDetailGates.ts — which actions a campaign's own STATE allows.
 *
 * Separate from campaignAccess.ts, which answers "may this PERSON act". The
 * two are deliberately independent: a viewer looking at a draft and an admin
 * looking at a sent campaign are denied Send for entirely different reasons,
 * and collapsing them is how the screen ended up gating everything on
 * connectivity alone.
 *
 * Pure, so the matrix is unit-tested instead of being re-derived inline in a
 * 390-line render.
 */
import { isCampaignAbTest, type AbTestCampaignShape } from "@/lib/campaignAbTest";
import { campaignHasBody, type CampaignBodyFields } from "@/lib/campaignBody";

export interface CampaignGateInput extends CampaignBodyFields, AbTestCampaignShape {
  status?: string | undefined;
}

export interface CampaignGates {
  canEdit: boolean;
  canSchedule: boolean;
  canSend: boolean;
  canTest: boolean;
  canResend: boolean;
  canDelete: boolean;
  canViewAbResults: boolean;
  isDraft: boolean;
}

export function campaignGates(
  campaign: CampaignGateInput | null | undefined,
): CampaignGates {
  const status = (campaign?.status ?? "draft").trim().toLowerCase();
  const hasBody = campaignHasBody(campaign);
  const isDraft = status === "draft";
  const canSchedule =
    isDraft || status === "scheduled" || status === "paused";
  return {
    isDraft,
    canEdit: isDraft || status === "scheduled",
    canSchedule,
    // Sending needs an actual body — accept all three persisted forms so an
    // MJML-only draft doesn't lose its send/test affordances.
    canSend: canSchedule && hasBody,
    // Re-checking how a campaign renders in an inbox is valid even after it
    // has sent, so a test only needs a body.
    canTest: hasBody,
    // Resend-to-non-openers needs opens to diff against.
    canResend: status === "sent",
    // Only drafts are deletable; anything further along must be cancelled.
    canDelete: isDraft,
    // Previously shown on EVERY campaign, where it led to "No variants yet".
    canViewAbResults: isCampaignAbTest(campaign),
  };
}
