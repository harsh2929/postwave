// SPDX-License-Identifier: AGPL-3.0-only
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  createSmsList,
  deleteSmsList,
  recordSmsConsent,
  sendSmsTest,
  updateSmsList,
  type SmsListInput,
} from "@/lib/sms-api";
import { isE164 } from "./page-helpers";
import type { SmsCampaignDraft } from "./sms-campaign-drafts-card";
import type { SmsConsentDraft } from "./sms-consent-card";
import type { SmsListDraft } from "./sms-lists-card";
import type { SmsTestSendDraft } from "./sms-test-send-card";

interface UseSmsAudienceActionsArgs {
  consent: SmsConsentDraft;
  tenantId: string;
  listDraft: SmsListDraft;
  refresh: () => Promise<void>;
  setCampaignDraft: Dispatch<SetStateAction<SmsCampaignDraft>>;
  setConsent: Dispatch<SetStateAction<SmsConsentDraft>>;
  setListDraft: Dispatch<SetStateAction<SmsListDraft>>;
  setPending: Dispatch<SetStateAction<string | null>>;
  setTestSend: Dispatch<SetStateAction<SmsTestSendDraft>>;
  testSend: SmsTestSendDraft;
}

export function useSmsAudienceActions({
  consent,
  tenantId,
  listDraft,
  refresh,
  setCampaignDraft,
  setConsent,
  setListDraft,
  setPending,
  setTestSend,
  testSend,
}: UseSmsAudienceActionsArgs) {
  const createList = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending("list");
    try {
      const created = await createSmsList(listDraft);
      toast.success("SMS list saved");
      setListDraft({ name: "", description: "", keyword: "" });
      setConsent((s) => ({ ...s, list_id: created.id }));
      setTestSend((s) => ({ ...s, list_id: created.id }));
      setCampaignDraft((s) => ({ ...s, list_id: created.id }));
      await refresh();
    } catch (err) {
      toast.error("Could not save SMS list", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const recordOptOut = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (consent.action !== "revoked" || consent.source !== "manual") {
      toast.error(
        "Only manual SMS opt-out recording is available; no request was sent",
      );
      return;
    }
    // Validate phone in E.164 before the round-trip; keep the typed value so
    // the user can correct it instead of getting only a server error toast.
    if (!isE164(consent.phone_e164)) {
      toast.error(
        "Enter a valid phone number in E.164 format, e.g. +14155551212",
      );
      return;
    }
    const reason = consent.proof_text.trim();
    if (!reason) {
      toast.error("Enter an operator revocation reason");
      return;
    }
    setPending("consent");
    try {
      await recordSmsConsent(
        {
          list_id: consent.list_id || undefined,
          phone_e164: consent.phone_e164,
          action: "revoked",
          source: "manual",
          proof_text: reason,
        },
        tenantId,
      );
      toast.success("SMS opt-out recorded", {
        description: consent.phone_e164,
      });
      // Clear identifying fields after the definitive receipt. Never prefill
      // a send target from an opted-out recipient.
      setConsent((s) => ({
        ...s,
        phone_e164: "",
        proof_text: "",
      }));
    } catch (err) {
      toast.error("Could not record consent", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const sendTest = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Validate recipient phone in E.164 before sending; keep input on failure.
    if (!isE164(testSend.to)) {
      toast.error("Enter a valid recipient in E.164 format, e.g. +14155551212");
      return;
    }
    setPending("send");
    try {
      const res = await sendSmsTest(testSend);
      toast.success("SMS accepted", {
        description: `${res.message.status} · ${res.gate.segments} segment${
          res.gate.segments === 1 ? "" : "s"
        }`,
      });
      // Clear the composed message on success (as createList resets its form)
      // so a confirmed send isn't accidentally re-fired (SMS-043).
      setTestSend((s) => ({ ...s, body: "", media_url: "" }));
    } catch (err) {
      toast.error("SMS was not sent", {
        description: smsTestSendErrorMessage(err),
      });
    } finally {
      setPending(null);
    }
  };

  const editList = async (id: string, input: SmsListInput) => {
    setPending(`list-edit:${id}`);
    try {
      await updateSmsList(id, input);
      toast.success("SMS list updated");
      await refresh();
    } catch (err) {
      toast.error("Could not update SMS list", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  const removeList = async (id: string) => {
    setPending(`list-delete:${id}`);
    try {
      await deleteSmsList(id);
      toast.success("SMS list deleted");
      await refresh();
    } catch (err) {
      toast.error("Could not delete SMS list", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPending(null);
    }
  };

  return {
    createList,
    editList,
    recordOptOut,
    removeList,
    sendTest,
  };
}

export function smsTestSendErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    const body = err.body;
    if (body && typeof body === "object") {
      const gate = (body as { gate?: unknown }).gate;
      if (gate && typeof gate === "object") {
        const reason = (gate as { reason?: unknown }).reason;
        if (typeof reason === "string" && reason.trim()) return reason.trim();
      }
    }
  }
  return err instanceof Error ? err.message : "Unknown error";
}
