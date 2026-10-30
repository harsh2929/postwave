// SPDX-License-Identifier: AGPL-3.0-only
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { toast } from "sonner";

import { fetchTextAuthed } from "@/lib/api";
import { downloadTextFile } from "@/lib/download";
import {
  cancelSmsCampaign,
  createSmsCampaign,
  getSmsCampaignReport,
  pauseSmsCampaign,
  resumeSmsCampaign,
  scheduleSmsCampaign,
  retrySmsCampaignFailed,
  sendSmsCampaign,
  updateSmsCampaign,
  smsCampaignReportExportPath,
  type SmsCampaign,
  type SmsCampaignReport,
  type SmsCreditBalance,
  type SmsCreditPreview,
  type SmsCreditTopUpQuote,
  type SmsDiscountCode,
  type SmsSenderProfile,
  type SmsSetupStatus,
  type SmsTemplate,
} from "@/lib/sms-api";
import {
  DEFAULT_AB_VARIANTS,
  appendSentence,
  campaignActionLabel,
  formatMicros,
  smsCredits,
  smsSegments,
} from "./page-helpers";
import type {
  SmsAbVariantDraft,
  SmsCampaignDraft,
  SmsSendTiming,
} from "./sms-campaign-drafts-card";

// restoreAbVariants rebuilds the composer A/B state from a reopened campaign's
// metadata. A non-A/B campaign must clear any variants left by another draft.
function restoreAbVariants(
  metadata: Record<string, unknown> | undefined,
  fallback: SmsAbVariantDraft[],
): Partial<Pick<SmsCampaignDraft, "ab_enabled" | "ab_variants">> {
  const raw = metadata?.ab_variants;
  if (!Array.isArray(raw) || raw.length < 2)
    return {
      ab_enabled: false,
      ab_variants: DEFAULT_AB_VARIANTS.map((variant) => ({ ...variant })),
    };
  const variants: SmsAbVariantDraft[] = raw.map((item, i) => {
    const v = (item ?? {}) as Record<string, unknown>;
    return {
      label:
        typeof v.label === "string" && v.label.trim()
          ? v.label
          : String.fromCharCode(65 + i),
      body: typeof v.body === "string" ? v.body : "",
      weight:
        typeof v.weight === "number"
          ? String(v.weight)
          : String(v.weight ?? ""),
    };
  });
  return {
    ab_enabled: true,
    ab_variants: variants.length >= 2 ? variants : fallback,
  };
}

interface UseSmsCampaignActionsArgs {
  activeSender?: SmsSenderProfile;
  campaignCreditPreview: SmsCreditPreview | null;
  campaignDraft: SmsCampaignDraft;
  campaignSender?: SmsSenderProfile;
  reports: Record<string, SmsCampaignReport>;
  refresh: () => Promise<void>;
  setCampaignDraft: Dispatch<SetStateAction<SmsCampaignDraft>>;
  setPending: Dispatch<SetStateAction<string | null>>;
  setReports: Dispatch<SetStateAction<Record<string, SmsCampaignReport>>>;
  setup: SmsSetupStatus | null;
  smsCreditBalance: SmsCreditBalance | null;
  smsDiscountCodes: SmsDiscountCode[];
  smsTopUpQuote: SmsCreditTopUpQuote | null;
}

export function useSmsCampaignActions({
  campaignCreditPreview,
  campaignDraft,
  reports,
  refresh,
  setCampaignDraft,
  setPending,
  setReports,
  smsDiscountCodes,
}: UseSmsCampaignActionsArgs) {
  const saveCampaign = async (e: FormEvent) => {
    e.preventDefault();
    // A scheduled draft must carry a future send time. scheduleCampaignFromDraft
    // already enforces this on the row action; mirror it here so a draft can't
    // persist as status=scheduled with an empty/past time (SMS-019).
    if (campaignDraft.status === "scheduled") {
      const when = campaignDraft.scheduled_at
        ? new Date(campaignDraft.scheduled_at).getTime()
        : NaN;
      if (Number.isNaN(when)) {
        toast.error("Pick a schedule time for a scheduled draft.");
        return;
      }
      if (when <= Date.now()) {
        toast.error("Schedule time must be in the future.");
        return;
      }
    }
    setPending("campaign");
    try {
      const input = {
        sender_profile_id: campaignDraft.sender_profile_id || undefined,
        list_id: campaignDraft.list_id || undefined,
        name: campaignDraft.name,
        body: campaignDraft.body,
        media_url: campaignDraft.media_url.trim() || undefined,
        status: campaignDraft.status as "draft" | "scheduled" | "paused",
        scheduled_at:
          campaignDraft.status === "scheduled" && campaignDraft.scheduled_at
            ? new Date(campaignDraft.scheduled_at).toISOString()
            : undefined,
        metadata: {
          link_tracking: campaignDraft.link_tracking,
          ...(campaignDraft.cost_cap_dollars.trim()
            ? { cost_cap_usd: campaignDraft.cost_cap_dollars.trim() }
            : {}),
          // SMS-037: send-time optimization rides on metadata (no migration).
          // Only stamped when non-fixed so fixed sends keep their existing
          // immediate-send shape.
          ...(campaignDraft.send_timing !== "fixed"
            ? {
                schedule_mode: campaignDraft.send_timing,
                ...(campaignDraft.send_timing === "recipient_tz"
                  ? {
                      local_time: campaignDraft.local_time || "09:00",
                      fallback_tz: campaignDraft.fallback_tz || "UTC",
                    }
                  : {}),
              }
            : {}),
          // SMS-036: A/B variants ride on metadata (no migration). Only
          // stamped when the toggle is on and at least two variants have a
          // body, so single-body sends keep their existing shape.
          ...(() => {
            if (!campaignDraft.ab_enabled) return {};
            const variants = campaignDraft.ab_variants
              .filter((v) => v.body.trim())
              .map((v, i) => ({
                label: v.label.trim() || String.fromCharCode(65 + i),
                body: v.body.trim(),
                weight: Number(v.weight) >= 0 ? Number(v.weight) || 0 : 0,
              }));
            return variants.length >= 2 ? { ab_variants: variants } : {};
          })(),
        },
      };
      // SMS-008: reopened drafts edit in place instead of creating a duplicate.
      const editingId = campaignDraft.editing_id;
      const created = editingId
        ? await updateSmsCampaign(editingId, input)
        : await createSmsCampaign(input);
      const createdSegments = smsSegments(created.body);
      toast.success(
        editingId ? "SMS campaign draft updated" : "SMS campaign draft saved",
        {
          description: `${createdSegments} segment${createdSegments === 1 ? "" : "s"}`,
        },
      );
      setCampaignDraft((s) => ({
        ...s,
        name: "",
        body: "",
        media_url: "",
        cost_cap_dollars: "",
        discount_code: "",
        status: "draft",
        scheduled_at: "",
        send_timing: "fixed",
        local_time: "09:00",
        fallback_tz: "UTC",
        ab_enabled: false,
        ab_variants: DEFAULT_AB_VARIANTS.map((variant) => ({ ...variant })),
        editing_id: undefined,
      }));
      await refresh();
    } catch (err) {
      toast.error("Could not save SMS campaign", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  // Load an existing campaign into the composer; editing_id saves through PATCH.
  const seedComposerFrom = (
    campaign: SmsCampaign,
    opts: { editing: boolean },
  ) => {
    setCampaignDraft((s) => ({
      ...s,
      sender_profile_id: campaign.sender_profile_id || s.sender_profile_id,
      list_id: campaign.list_id || s.list_id,
      name: opts.editing ? campaign.name : `${campaign.name} (copy)`,
      body: campaign.body,
      media_url: campaign.media_url ?? "",
      status: "draft",
      scheduled_at: "",
      link_tracking: campaign.metadata?.link_tracking !== false,
      cost_cap_dollars:
        typeof campaign.metadata?.cost_cap_usd === "string"
          ? (campaign.metadata.cost_cap_usd as string)
          : "",
      discount_code: "",
      // SMS-037: restore the send-timing mode from metadata so a reopened
      // draft keeps its recipient-tz / STO choice instead of silently
      // reverting to fixed.
      send_timing:
        campaign.metadata?.schedule_mode === "recipient_tz" ||
        campaign.metadata?.schedule_mode === "sto"
          ? (campaign.metadata.schedule_mode as SmsSendTiming)
          : "fixed",
      local_time:
        typeof campaign.metadata?.local_time === "string"
          ? (campaign.metadata.local_time as string)
          : s.local_time,
      fallback_tz:
        typeof campaign.metadata?.fallback_tz === "string"
          ? (campaign.metadata.fallback_tz as string)
          : s.fallback_tz,
      // SMS-036: restore A/B variants from metadata on reopen.
      ...restoreAbVariants(campaign.metadata, s.ab_variants),
      editing_id: opts.editing ? campaign.id : undefined,
    }));
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    toast.info(
      opts.editing
        ? "Draft loaded into the composer"
        : "Campaign copied into the composer",
    );
  };

  const editCampaign = (campaign: SmsCampaign) =>
    seedComposerFrom(campaign, { editing: true });
  const duplicateCampaign = (campaign: SmsCampaign) =>
    seedComposerFrom(campaign, { editing: false });

  // Authenticated CSV export (SMS-031/040): fetch via the api client so
  // X-Postwave-Client/Version headers ride along and a failure surfaces in-app
  // instead of a raw browser error page from a bare anchor navigation.
  const exportReport = async (
    campaign: SmsCampaign,
    status: "all" | "problems" | "undelivered" | "blocked" | "failed",
  ) => {
    setPending(`export:${campaign.id}`);
    try {
      const csv = await fetchTextAuthed(
        smsCampaignReportExportPath(campaign.id, status),
      );
      downloadTextFile(
        `sms-campaign-${campaign.id}-${status}.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
      toast.success("Export downloaded");
    } catch (err) {
      toast.error("Could not export report", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const draftSmsWithAI = async () => {
    setPending("campaign-ai");
    try {
      const { runInlineAI } = await import("@/lib/mailchimp-compat-api");
      const prompt =
        campaignDraft.body.trim() ||
        campaignDraft.name.trim() ||
        "Write a concise opted-in marketing SMS with a clear offer and opt-out language.";
      const res = await runInlineAI({
        channel: "sms",
        mode: "sms",
        text: prompt,
        tone: "clear",
        context: {
          surface: "sms_campaign_builder",
          list_id: campaignDraft.list_id,
          sender_profile_id: campaignDraft.sender_profile_id,
          has_mms_media: campaignDraft.media_url.trim() !== "",
          estimated_segments: smsSegments(campaignDraft.body),
          estimated_credits:
            campaignCreditPreview?.total_credits ??
            smsCredits(campaignDraft.body, campaignDraft.media_url),
        },
      });
      const nextBody = res.text || res.variants[0] || prompt;
      setCampaignDraft((s) => ({ ...s, body: nextBody }));
      const nextSegments = smsSegments(nextBody);
      toast.success("SMS draft generated", {
        description: `${nextSegments} segment${nextSegments === 1 ? "" : "s"}`,
      });
      if (res.warnings?.length) {
        toast.info(res.warnings[0]);
      }
    } catch (err) {
      toast.error("Could not generate SMS copy", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  // Placeholder → sample copy used when seeding the composer from a template.
  // The discount code is resolved separately because it comes from live data.
  const SMS_TEMPLATE_SAMPLE_VALUES: Record<string, string> = {
    "{{product_name}}": "your favorite item",
    "{{event_name}}": "your event",
    "{{time}}": "tomorrow",
    "{{date}}": "Friday",
    "{{link}}": "https://example.com",
  };

  const applySmsTemplate = (template: SmsTemplate) => {
    const fallbackCode =
      campaignDraft.discount_code ||
      smsDiscountCodes.find((item) => item.currently_redeemable)?.code ||
      "SAVE20";
    setCampaignDraft((s) => ({
      ...s,
      name: s.name || template.name,
      // replaceAll, not replace: a string pattern substitutes only the FIRST
      // match, so a template that used a placeholder twice left the second one
      // as a literal "{{discount_code}}" in an outgoing SMS. The function form
      // also stops a "$&"-style sequence inside a discount code from being
      // treated as a replacement pattern.
      body: Object.entries(SMS_TEMPLATE_SAMPLE_VALUES).reduce(
        (body, [token, value]) => body.replaceAll(token, () => value),
        template.body.replaceAll("{{discount_code}}", () => fallbackCode),
      ),
    }));
  };

  const insertDiscountCode = (selectedCode?: string) => {
    const code = (selectedCode ?? campaignDraft.discount_code).trim();
    if (!code) {
      toast.error("Add a discount code first");
      return;
    }
    setCampaignDraft((s) => ({
      ...s,
      discount_code: code,
      body: appendSentence(s.body, `Use code ${code} at checkout.`),
    }));
  };

  const startSmsTopUpCheckout = async () => {
    toast.error("SMS credit checkout is release-held.", {
      description:
        "sms_financial_ledger_release_held — no quote, balance, entitlement, or purchase request was made.",
    });
  };

  const recordMmsSmokePass = async () => {
    toast.error("MMS readiness certification is release-held.", {
      description:
        "sms_mms_readiness_release_held — metadata cannot certify carrier, inbound-media, delivery, callback, or cost evidence.",
    });
  };

  const broadcastCampaign = async (campaign: SmsCampaign) => {
    setPending(`broadcast:${campaign.id}`);
    try {
      const res = await sendSmsCampaign(campaign.id, {
        link_tracking: Boolean(campaign.metadata?.link_tracking),
      });
      const description = `${res.queued}/${res.recipients} queued · ${res.segments} segment${
        res.segments === 1 ? "" : "s"
      }${res.scheduled ? ` · ${res.scheduled} time-optimized` : ""}${
        res.estimated_cost_micros
          ? ` · est. ${formatMicros(res.estimated_cost_micros)}`
          : ""
      }${formatBlockingCodes(res.blocking_codes)}`;
      if (res.queued === 0 && res.blocked > 0) {
        toast.error("SMS broadcast blocked", { description });
      } else if (res.blocked > 0 || res.failed > 0) {
        toast.warning("SMS broadcast partially queued", { description });
      } else {
        toast.success("SMS broadcast queued", { description });
      }
      await refresh();
    } catch (err) {
      toast.error("Could not send SMS campaign", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const setCampaignLifecycle = async (
    campaign: SmsCampaign,
    action: "pause" | "resume" | "cancel" | "schedule",
    scheduledAt?: string,
  ) => {
    setPending(`${action}:${campaign.id}`);
    try {
      if (action === "pause") await pauseSmsCampaign(campaign.id);
      if (action === "resume") await resumeSmsCampaign(campaign.id);
      if (action === "cancel") await cancelSmsCampaign(campaign.id);
      if (action === "schedule") {
        const when = scheduledAt ?? campaignDraft.scheduled_at;
        if (!when) throw new Error("Pick a schedule time first.");
        await scheduleSmsCampaign(campaign.id, new Date(when).toISOString());
      }
      toast.success(`SMS campaign ${campaignActionLabel(action)}`);
      await refresh();
      if (reports[campaign.id]) {
        const nextReport = await getSmsCampaignReport(campaign.id);
        setReports((s) => ({ ...s, [campaign.id]: nextReport }));
      }
    } catch (err) {
      toast.error("Could not update SMS campaign", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const scheduleCampaignFromDraft = (campaign: SmsCampaign) => {
    const when = campaignDraft.scheduled_at;
    if (!when) {
      toast.error("Pick a schedule time in the form above first.");
      return;
    }
    if (new Date(when).getTime() <= Date.now()) {
      toast.error("Schedule time must be in the future.");
      return;
    }
    void setCampaignLifecycle(
      campaign,
      "schedule",
      new Date(when).toISOString(),
    );
  };

  const loadCampaignReport = async (campaign: SmsCampaign) => {
    if (reports[campaign.id]) {
      setReports((s) => {
        const next = { ...s };
        delete next[campaign.id];
        return next;
      });
      return;
    }
    setPending(`report:${campaign.id}`);
    try {
      const report = await getSmsCampaignReport(campaign.id);
      setReports((s) => ({ ...s, [campaign.id]: report }));
    } catch (err) {
      toast.error("Could not load SMS report", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  // SMS-034: re-queue failed/undelivered recipients, then refresh the report.
  const retryFailedRecipients = async (campaign: SmsCampaign) => {
    setPending(`retry:${campaign.id}`);
    try {
      const res = await retrySmsCampaignFailed(campaign.id);
      toast.success(
        res.requeued > 0
          ? `Re-queued ${res.requeued} recipient${res.requeued === 1 ? "" : "s"} for another attempt.`
          : "No failed recipients to re-queue.",
      );
      const report = res.report ?? (await getSmsCampaignReport(campaign.id));
      setReports((s) => ({ ...s, [campaign.id]: report }));
    } catch (err) {
      toast.error("Could not re-queue failed recipients", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const campaignSegments = smsSegments(campaignDraft.body);
  const campaignCredits =
    campaignCreditPreview?.total_credits ??
    smsCredits(campaignDraft.body, campaignDraft.media_url);
  const campaignSendDuration =
    campaignCreditPreview?.send_duration_label ?? "preview";

  return {
    applySmsTemplate,
    broadcastCampaign,
    campaignCredits,
    campaignSegments,
    campaignSendDuration,
    draftSmsWithAI,
    duplicateCampaign,
    editCampaign,
    exportReport,
    insertDiscountCode,
    loadCampaignReport,
    retryFailedRecipients,
    recordMmsSmokePass,
    saveCampaign,
    scheduleCampaignFromDraft,
    setCampaignLifecycle,
    startSmsTopUpCheckout,
  };
}

function formatBlockingCodes(codes: string[] | undefined): string {
  if (!codes?.length) return "";
  return ` · blocked: ${codes.map((code) => code.replaceAll("_", " ")).join(", ")}`;
}
