// SPDX-License-Identifier: AGPL-3.0-only

/** Public SMS release truth shared by active marketing surfaces. */
export const SMS_RELEASE_VERDICT = "HOLD / NO-GO" as const;

export const SMS_RELEASE_HOLD_CODES = {
  reply: "sms_reply_dispatch_release_held",
  broadcast: "sms_broadcast_dispatch_release_held",
  campaign: "sms_campaign_dispatch_release_held",
  campaignSchedule: "sms_campaign_schedule_release_held",
  test: "sms_test_dispatch_release_held",
  a2p: "sms_a2p_registration_release_held",
  autoReply: "sms_auto_reply_dispatch_release_held",
  providerCallback: "sms_provider_callback_release_held",
  clickResolver: "sms_click_resolver_release_held",
  financial: "sms_financial_ledger_release_held",
  mms: "sms_mms_readiness_release_held",
  evidence: "sms_evidence_read_release_held",
} as const;

export const SMS_RELEASE_STATUS_COPY =
  "HOLD / NO-GO: Moosewave currently exposes source, draft, consent, suppression, and bounded inbox presentation surfaces. Live reply, test, campaign and broadcast dispatch or scheduling, A2P submit/poll, hosted provider callbacks and tracked-click resolution, financial/MMS evidence, and outbound auto-replies are structurally release-held. Do not configure customer traffic or provider credentials for hosted SMS.";

export const SMS_PRESENTATION_SCOPE_COPY =
  "Desktop, web, and mobile may present route-specific, tenant-bound records; those views are not proof of complete provider history, delivery, cost, consent authority, or deployment readiness.";
