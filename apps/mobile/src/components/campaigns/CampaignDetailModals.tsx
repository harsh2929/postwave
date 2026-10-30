/**
 * CampaignDetailModals — the seven sheets the campaign detail screen can open,
 * and the ONE place their access terms live.
 *
 * Lifted out of the route for two reasons. The mechanical one is that the
 * route's render had grown past the cyclomatic budget, mostly on this stack of
 * `visible={x && access.canX}` conjunctions. The real one is that those terms
 * are a security surface: schedule / subject / send / test / resend need
 * `canMutate`, save-as-template needs `canAdmin` because the gateway mounts it
 * behind ScopeAdmin, and preview-as needs NEITHER because it is read-scope and
 * the reviewer who can only read is exactly who needs it. Scattered across a
 * 250-line render those distinctions are invisible; here they are a list you
 * can check against the server's own route mounts.
 *
 * The `visible &&` conjunction matters rather than merely disabling the
 * button: a sheet can be opened by a deep link or by a race with a role change
 * mid-session, so the SHEET is the gate, not only the affordance that opens it.
 */
import type { ReturnFocusRef } from "@/components/KeyboardFormSheet";
import { CampaignFeedbackModal } from "@/components/campaigns/CampaignFeedbackModal";
import { CampaignPreviewAsModal } from "@/components/campaigns/CampaignPreviewAsModal";
import { CampaignResendModal } from "@/components/campaigns/CampaignResendModal";
import { CampaignSaveTemplateModal } from "@/components/campaigns/CampaignSaveTemplateModal";
import { CampaignScheduleModal } from "@/components/campaigns/CampaignScheduleModal";
import { CampaignSendModal } from "@/components/campaigns/CampaignSendModal";
import { CampaignSubjectModal } from "@/components/campaigns/CampaignSubjectModal";
import { CampaignTestSendModal } from "@/components/campaigns/CampaignTestSendModal";
import type { CampaignDetail } from "@/hooks/useCampaigns";
import type { CampaignAccess } from "@/lib/campaignAccess";
import { campaignBodyForPrediction } from "@/lib/campaignBody";
import type { CampaignFieldsDraft } from "@/lib/campaignFields";
import { campaignFromEmailValue } from "@/lib/campaignSenderEdit";

/** Which sheet, if any, is open. One at a time — they are all page sheets. */
export type CampaignSheet =
  | "schedule"
  | "subject"
  | "send"
  | "test"
  | "resend"
  | "previewAs"
  | "saveTemplate"
  | "feedback";

export interface CampaignDetailModalsProps {
  campaign: CampaignDetail;
  access: CampaignAccess;
  open: CampaignSheet | null;
  onOpen: (sheet: CampaignSheet) => void;
  onClose: () => void;
  /**
   * The control that opened the sheet now on screen, so dismissing it returns
   * VoiceOver focus there instead of to the top of a screen whose action row
   * is eleven buttons wide. Resolved by the route from `useSheetTriggerRefs`;
   * undefined when the sheet was reached some other way (a deep link), which
   * is the honest answer — there is nowhere to go back to.
   */
  returnFocusRef?: ReturnFocusRef | undefined;
  /**
   * The durable-draft plumbing for the ONE sheet that holds unsaved work
   * (ECO-03). Passed through rather than owned here: the checkpoint state
   * belongs to the route, because the resume offer has to be visible on the
   * detail screen — nobody opens a sheet to discover that a draft exists.
   */
  draftSeed?: CampaignFieldsDraft | undefined;
  onDraftChange?: ((draft: CampaignFieldsDraft | null) => void) | undefined;
}

export function CampaignDetailModals({
  campaign,
  access,
  open,
  onOpen,
  onClose,
  returnFocusRef,
  draftSeed,
  onDraftChange,
}: CampaignDetailModalsProps) {
  const mutating = (sheet: CampaignSheet): boolean =>
    open === sheet && access.canMutate;

  return (
    <>
      <CampaignScheduleModal
        visible={mutating("schedule")}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaign={campaign}
      />
      <CampaignSubjectModal
        visible={mutating("subject")}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaign={campaign}
        seed={draftSeed}
        onDraftChange={onDraftChange}
      />
      <CampaignSendModal
        visible={mutating("send")}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaignId={campaign.id}
        campaignName={campaign.name ?? campaign.subject}
        subject={campaign.subject ?? ""}
        bodyHtml={campaignBodyForPrediction(campaign)}
        fromLine={[campaign.from_name, campaignFromEmailValue(campaign)]
          .filter(Boolean)
          .join(" ")}
        onImproveSubject={() => onOpen("subject")}
      />
      <CampaignTestSendModal
        visible={mutating("test")}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaign={campaign}
      />
      <CampaignResendModal
        visible={mutating("resend")}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaign={campaign}
      />
      {/* Read-scope on the gateway (compose.go / preview_as.go), so it is NOT
          gated on canMutate. */}
      <CampaignPreviewAsModal
        visible={open === "previewAs"}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaignId={campaign.id}
        bodyHtml={campaign.body_html ?? ""}
      />
      {/* READ-scope to list (feedback.go:61), write-scope to post or resolve
          (:63,:67). So the sheet opens for anyone — the viewer who was asked to
          review the draft is exactly who needs to read the thread — and the
          composer inside it is what `canComment` gates. */}
      <CampaignFeedbackModal
        visible={open === "feedback"}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaignId={campaign.id}
        canComment={access.canMutate}
        {...(access.notice ? { blockedReason: access.notice } : {})}
      />
      {/* Admin-scope on the gateway (campaign_to_template.go:69). */}
      <CampaignSaveTemplateModal
        visible={open === "saveTemplate" && access.canAdmin}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        campaignId={campaign.id}
        campaignName={campaign.name ?? campaign.subject ?? "Untitled campaign"}
      />
    </>
  );
}
