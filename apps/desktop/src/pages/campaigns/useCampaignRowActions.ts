import type { Campaign } from "../../lib/api-client";
import { api, campaignCloneApi, resendUnopenedApi } from "../../lib/api-client";
import { toast } from "../../components/Toast";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../../lib/campaign-operational-availability";
import {
  defaultResendSubject,
  validateResendSubject,
} from "../campaigns-row-actions";
import type { CampaignsData } from "./useCampaignsData";
import type { CampaignsState } from "./useCampaignsState";

export function createCampaignRowActions(
  state: CampaignsState,
  data: CampaignsData,
  authority: {
    readonly current: {
      canMutateCampaignSnapshot: boolean;
      canAdminMutateCampaignSnapshot: boolean;
    };
  },
) {
  const createFolder = async (): Promise<void> => {
    if (!authority.current.canMutateCampaignSnapshot) return;
    const name = state.newFolderName.trim();
    if (!name) return;
    const response = await api.createCampaignFolder(name);
    if (response.error) {
      toast.error(`Couldn't create folder: ${response.error.message}`);
      return;
    }
    state.setNewFolderName("");
    await data.loadFolders();
  };

  const moveCampaign = async (): Promise<void> => {
    if (!authority.current.canMutateCampaignSnapshot || !state.moveTarget?.id)
      return;
    const response = await api.moveCampaignToFolder(
      state.moveTarget.id,
      state.movePick,
    );
    if (response.error) {
      toast.error(`Couldn't move: ${response.error.message}`);
      return;
    }
    state.setMoveTarget(null);
    await Promise.all([data.load(), data.loadFolders()]);
    toast.success("Campaign moved");
  };

  const cloneCampaign = async (campaign: Campaign): Promise<void> => {
    if (
      !authority.current.canAdminMutateCampaignSnapshot ||
      campaign.id == null
    )
      return;
    const label = campaign.name ?? campaign.subject ?? "campaign";
    state.setCloningId(String(campaign.id));
    const response = await campaignCloneApi.clone(campaign.id);
    state.setCloningId(null);
    if (response.error) {
      toast.error(`Couldn't clone "${label}": ${response.error.message}`);
      return;
    }
    toast.success(`Cloned as "${response.data.name}"`);
    const list = await data.load();
    const clone = list?.find(
      (candidate) => String(candidate.id) === String(response.data.id),
    );
    if (clone) {
      state.setSelected(clone);
    } else if (list) {
      toast.error(
        "Clone created, but it isn't visible after a complete refresh. It may still be processing; refresh and search by name.",
      );
    }
  };

  const openResend = (campaign: Campaign): void => {
    if (!authority.current.canAdminMutateCampaignSnapshot) return;
    state.setResendTarget(campaign);
    state.setResendSubject(defaultResendSubject(campaign.subject));
    state.setResendErr(null);
  };

  const submitResend = async (): Promise<void> => {
    if (
      !authority.current.canAdminMutateCampaignSnapshot ||
      !state.resendTarget?.id
    )
      return;
    const validation = validateResendSubject(
      state.resendSubject,
      state.resendTarget.subject,
    );
    if (validation) {
      state.setResendErr(validation);
      return;
    }
    state.setResendBusy(true);
    state.setResendErr(null);
    const response = await resendUnopenedApi.resend(state.resendTarget.id, {
      subject: state.resendSubject.trim(),
    });
    state.setResendBusy(false);
    if (response.error) {
      state.setResendErr(response.error.message);
      return;
    }
    state.setResendTarget(null);
    toast.success({
      message: `Resend campaign created (id ${response.data.id})`,
      detail: `"${response.data.name}" targets ${response.data.audience_size.toLocaleString()} non-openers, sending ≥${response.data.send_after_hours}h after the original.`,
    });
    await data.load();
  };

  const openCampaignById = async (campaignId: string): Promise<void> => {
    if (
      state.selected?.id != null &&
      String(state.selected.id) !== String(campaignId)
    ) {
      toast.error({
        message: "Close the open campaign before opening another one",
        detail:
          "This protects unsaved campaign work. Close the current campaign, then try again.",
      });
      return;
    }
    const list = await data.load();
    const match = list?.find(
      (campaign) => String(campaign.id) === String(campaignId),
    );
    if (match) {
      state.setSelected(match);
    } else if (list) {
      toast.error(
        "Draft created, but it isn't visible after a complete refresh. It may still be processing; refresh and search by name.",
      );
    }
  };

  const rescheduleFromCalendar = async (
    campaign: Campaign,
    isoDate: string,
  ): Promise<boolean> => {
    if (!authority.current.canMutateCampaignSnapshot || campaign.id == null)
      return false;
    // The calendar drag is a schedule entry point, and it was the only one that
    // did not consult this gate — campaign-operational-availability.ts asks that
    // every entry point share it "so one surface cannot overstate what the
    // delivery system can currently guarantee".
    //
    // Nothing enforced it here except a server 422 that named a lifecycle
    // endpoint which did not exist, so the drag failed with a message about the
    // wrong thing. The honest reason is the one the schedule modal already
    // shows.
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      toast.info({
        message: "Scheduling is unavailable",
        detail: CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
      });
      return false;
    }
    const previousReference = campaign.scheduled_at ?? campaign.sent_at ?? null;
    const previous = previousReference
      ? new Date(previousReference)
      : new Date();
    const [year, month, day] = isoDate.split("-").map(Number);
    const next = new Date(previous);
    // Carry the wall-clock time, not the elapsed offset. setFullYear on a local
    // Date preserves local hours/minutes across a DST boundary, so a 09:00 send
    // dragged over a transition stays 09:00 instead of silently becoming 08:00
    // or 10:00 — which is what "same time, different day" has to mean when the
    // gesture is dropping a card on another square.
    next.setFullYear(year, (month ?? 1) - 1, day);
    // POST /schedule, not PATCH. PATCH refuses `scheduled_at` with 422
    // `campaign_dispatch_state_owned`, so this drag never once succeeded.
    const response = await api.scheduleCampaign(
      campaign.id,
      next.toISOString(),
    );
    if (response.error) {
      toast.error(`Couldn't reschedule: ${response.error.message}`);
      return false;
    }
    if (response.queued) {
      toast.info({
        message: "Reschedule is pending server confirmation",
        detail:
          "The calendar keeps the confirmed server time until sync completes.",
      });
      return true;
    }
    toast.success(
      `"${campaign.name ?? campaign.subject ?? "Campaign"}" rescheduled`,
    );
    try {
      await data.load();
    } catch {
      // The schedule is already committed. A refresh failure must not report
      // the reschedule as retryable and invite a misleading second request.
      toast.info({
        message: "Campaign rescheduled; refresh the calendar to confirm it",
        detail:
          "Moosewave saved the new date, but the latest calendar data could not be loaded.",
      });
    }
    return true;
  };

  return {
    cloneCampaign,
    createFolder,
    moveCampaign,
    openCampaignById,
    openResend,
    rescheduleFromCalendar,
    submitResend,
  };
}

export type CampaignRowActions = ReturnType<typeof createCampaignRowActions>;
