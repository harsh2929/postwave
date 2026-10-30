// SPDX-License-Identifier: AGPL-3.0-only

import { type SmsCreditBalance } from "@/lib/sms-api";

type SmsCreditDraft = {
  body: string;
  media_url: string;
};

type SmsSenderCreditContext = {
  country: string;
  sender_type: string;
};

interface UseSmsCreditPreviewsInput {
  activeSender: SmsSenderCreditContext | undefined;
  campaignDraft: SmsCreditDraft;
  campaignSender: SmsSenderCreditContext | undefined;
  debounceMs?: number;
  sender: SmsSenderCreditContext;
  smsCreditBalance: SmsCreditBalance | null;
  testSend: SmsCreditDraft;
  campaignRecipientCount?: number;
}

export function useSmsCreditPreviews({
  activeSender: _activeSender,
  campaignDraft: _campaignDraft,
  campaignSender: _campaignSender,
  debounceMs: _debounceMs = 250,
  sender: _sender,
  smsCreditBalance: _smsCreditBalance,
  testSend: _testSend,
  campaignRecipientCount: _campaignRecipientCount = 1,
}: UseSmsCreditPreviewsInput) {
  // These routes have a stable source hold and never return authoritative
  // financial evidence. Do not create timers or requests that would merely
  // generate recurring 503 noise while the operator edits a draft.
  return {
    campaignCreditPreview: null,
    smsTopUpQuote: null,
    testCreditPreview: null,
  };
}
