// SPDX-License-Identifier: AGPL-3.0-only
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { toast } from "sonner";

import {
  pauseSmsSender,
  resumeSmsSender,
  upsertSmsSender,
  type SmsSenderProfile,
  type SmsSetupStatus,
} from "@/lib/sms-api";
import { senderMetadata } from "./page-helpers";
import type { A2PGeneratableField } from "./sms-a2p-campaign-registration-fields";
import type {
  SmsBrandRegistrationDraft,
  SmsCampaignRegistrationDraft,
  SmsSenderDraft,
} from "./sms-registration-drafts";
import { senderRegistrationEvidenceLocked } from "./sms-registration-drafts";

interface UseSmsSenderActionsArgs {
  activeSender?: SmsSenderProfile;
  brandRegistration: SmsBrandRegistrationDraft;
  campaignRegistration: SmsCampaignRegistrationDraft;
  refresh: () => Promise<void>;
  sender: SmsSenderDraft;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
  setPending: Dispatch<SetStateAction<string | null>>;
  setup: SmsSetupStatus | null;
  targetSenderId?: string;
}

const A2P_AI_PROMPTS: Record<A2PGeneratableField, string> = {
  description:
    "Write a concise, carrier-approvable A2P 10DLC campaign description (2-3 sentences) explaining who is messaged, why, and the message content. Plain text only.",
  message_flow:
    "Describe the opt-in message flow for an A2P 10DLC campaign for carrier review: how subscribers give consent (web form, keyword, checkout), what confirmation they receive, and how they opt out with STOP. Plain text only.",
  message_samples:
    "Write 2-3 sample marketing SMS messages for carrier A2P review. Each on its own line, each under 160 characters, each including opt-out language like 'Reply STOP to opt out'. Return only the messages, one per line.",
};

export const SMS_A2P_REGISTRATION_RELEASE_HELD_CODE =
  "sms_a2p_registration_release_held" as const;
export const SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE =
  "sms_registration_evidence_authority_required" as const;

function showA2PRegistrationReleaseHold(): void {
  toast.error("A2P registration automation is release-held", {
    description: `${SMS_A2P_REGISTRATION_RELEASE_HELD_CODE}: nothing was submitted.`,
  });
}

export function useSmsSenderActions({
  activeSender,
  campaignRegistration,
  refresh,
  sender,
  setCampaignRegistration,
  setPending,
}: UseSmsSenderActionsArgs) {
  const saveSender = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (senderRegistrationEvidenceLocked(sender)) {
      toast.error("Carrier registration evidence is read-only", {
        description: `${SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE}: nothing was saved.`,
      });
      return;
    }
    setPending("sender");
    try {
      const metadata = senderMetadata(activeSender?.metadata, sender);
      await upsertSmsSender({
        provider: sender.provider,
        country: sender.country,
        sender_type: sender.sender_type,
        phone_number: sender.phone_number || undefined,
        messaging_service_sid: sender.messaging_service_sid || undefined,
        registration_status:
          sender.registration_status as SmsSenderProfile["registration_status"],
        metadata,
      });
      toast.success("SMS sender saved");
      await refresh();
    } catch (err) {
      toast.error("Could not save sender", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const submitBrand = async () => {
    showA2PRegistrationReleaseHold();
  };

  const submitCampaignRegistration = async () => {
    showA2PRegistrationReleaseHold();
  };

  const pollRegistration = async () => {
    showA2PRegistrationReleaseHold();
  };

  const setSenderKillSwitch = async (
    item: SmsSenderProfile,
    paused: boolean,
  ) => {
    setPending(`${paused ? "pause-sender" : "resume-sender"}:${item.id}`);
    try {
      if (paused) {
        await pauseSmsSender(
          item.id,
          "Paused from SMS operations dashboard before or during pilot.",
        );
      } else {
        await resumeSmsSender(item.id);
      }
      toast.success(paused ? "Sender paused" : "Sender resumed");
      await refresh();
    } catch (err) {
      toast.error(
        paused ? "Could not pause sender" : "Could not resume sender",
        {
          description: err instanceof Error ? err.message : "Unknown error",
        },
      );
    } finally {
      setPending(null);
    }
  };

  const generateA2PField = async (field: A2PGeneratableField) => {
    setPending(`a2p-ai:${field}`);
    try {
      const { runInlineAI } = await import("@/lib/mailchimp-compat-api");
      const existing = campaignRegistration[field].trim();
      const res = await runInlineAI({
        channel: "sms",
        mode: "sms",
        text: existing || A2P_AI_PROMPTS[field],
        prompt: A2P_AI_PROMPTS[field],
        tone: "clear",
        context: {
          surface: "sms_a2p_registration",
          a2p_field: field,
          usecase: campaignRegistration.usecase,
          vertical: campaignRegistration.vertical,
        },
      });
      const next =
        field === "message_samples"
          ? res.variants.length > 1
            ? res.variants.join("\n")
            : res.text || res.variants[0] || existing
          : res.text || res.variants[0] || existing;
      if (!next) {
        toast.info("No suggestion was returned. Try adding a hint first.");
        return;
      }
      setCampaignRegistration((current) => ({ ...current, [field]: next }));
      toast.success("A2P field drafted");
      if (res.warnings?.length) toast.info(res.warnings[0]);
    } catch (err) {
      toast.error("Could not draft A2P field", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  return {
    generateA2PField,
    pollRegistration,
    saveSender,
    setSenderKillSwitch,
    submitBrand,
    submitCampaignRegistration,
  };
}
