// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import {
  decodeSmsConversations,
  decodeSmsConversationActivity,
  decodeSmsConversationBulkMutation,
  decodeSmsConversationStateMutation,
  decodeSmsConversationTagMutation,
  decodeSmsConversationTags,
  decodeSmsMessages,
  decodeSmsMarkReadResponse,
  isSmsInboxRfc3339,
  type SmsConversationsResponse,
  type SmsConversationActivityResponse,
  type SmsConversationBulkMutationReceipt,
  type SmsConversationStateAction,
  type SmsConversationStateMutationReceipt,
  type SmsConversationTagMutationReceipt,
  type SmsConversationTagsResponse,
  type SmsMessagesResponse,
  type SmsMarkReadResponse,
} from "./sms-inbox-contract";
import {
  decodeSmsSuppressionRow,
  decodeSmsSuppressions,
  SMS_SUPPRESSION_REASONS,
  type SmsSuppressionReason,
  type SmsSuppressionRow,
  type SmsSuppressionsPage,
} from "./sms-suppression-contract";
import {
  canonicalSmsKeyword,
  decodeSmsKeywordDeleteReceipt,
  decodeSmsKeywordResponse,
  decodeSmsKeywordResponseList,
  requireSmsKeywordId,
  requireSmsKeywordTenant,
  requireSmsKeywordVersion,
  SMS_AUTO_REPLY_DISPATCH_RELEASE_HELD_CODE,
  type SmsKeywordDeleteReceipt,
  type SmsKeywordResponse,
  type SmsKeywordResponseInput,
} from "./sms-keyword-contract";
import {
  decodeSmsConversationContext,
  decodeSmsConversationSearch,
  parseSmsConversationsExportTruth,
  smsConversationsCsvMatchesTruth,
  smsConversationsExportFilename,
  smsExportReasonProblem,
  isSmsOpaqueCursor,
  smsSearchQueryProblem,
  SMS_SEARCH_MAX_LIMIT,
  type SmsConversationContext,
  type SmsConversationSearchPage,
  type SmsConversationsExportTruth,
} from "./sms-conversation-lookup-contract";

export type {
  SmsConversationMessage,
  SmsConversationSummary,
  SmsConversationActivityResponse,
  SmsConversationBulkMutationReceipt,
  SmsConversationStateAction,
  SmsConversationStateMutationReceipt,
  SmsConversationTag,
  SmsConversationTagMutationReceipt,
  SmsConversationTagsResponse,
  SmsConversationsResponse,
  SmsMessagesResponse,
} from "./sms-inbox-contract";
export type {
  SmsKeywordAction,
  SmsKeywordDeleteReceipt,
  SmsKeywordResponse,
  SmsKeywordResponseInput,
} from "./sms-keyword-contract";

export const SMS_EVIDENCE_READ_RELEASE_HELD_CODE =
  "sms_evidence_read_release_held" as const;
export const SMS_A2P_REGISTRATION_RELEASE_HELD_CODE =
  "sms_a2p_registration_release_held" as const;
export const SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE =
  "sms_financial_ledger_release_held" as const;
export const SMS_MMS_READINESS_RELEASE_HELD_CODE =
  "sms_mms_readiness_release_held" as const;
export const SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE =
  "sms_registration_evidence_authority_required" as const;

export class SmsEvidenceReadReleaseHeldError extends Error {
  readonly code = SMS_EVIDENCE_READ_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "Confidential SMS evidence reads are release-held until the audited bounded contract is available.",
    );
    this.name = "SmsEvidenceReadReleaseHeldError";
  }
}

function heldSmsEvidenceRead<T>(): Promise<T> {
  return Promise.reject(new SmsEvidenceReadReleaseHeldError());
}

function heldSmsEvidencePath(): never {
  throw new SmsEvidenceReadReleaseHeldError();
}

export class SmsA2PRegistrationReleaseHeldError extends Error {
  readonly code = SMS_A2P_REGISTRATION_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "SMS A2P registration is release-held until durable idempotency, reconciliation, and minimized receipts are deployed.",
    );
    this.name = "SmsA2PRegistrationReleaseHeldError";
  }
}

function heldSmsA2PRegistration<T>(): Promise<T> {
  return Promise.reject(new SmsA2PRegistrationReleaseHeldError());
}

export class SmsFinancialLedgerReleaseHeldError extends Error {
  readonly code = SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "The authoritative SMS financial ledger, balance, usage, quote, and checkout surfaces are release-held.",
    );
    this.name = "SmsFinancialLedgerReleaseHeldError";
  }
}

export class SmsMmsReadinessReleaseHeldError extends Error {
  readonly code = SMS_MMS_READINESS_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "End-to-end MMS readiness is release-held until inbound media and provider receipt evidence are durable.",
    );
    this.name = "SmsMmsReadinessReleaseHeldError";
  }
}

function heldSmsFinancialLedger<T>(): Promise<T> {
  return Promise.reject(new SmsFinancialLedgerReleaseHeldError());
}

function heldSmsMmsReadiness<T>(): Promise<T> {
  return Promise.reject(new SmsMmsReadinessReleaseHeldError());
}

export class SmsRegistrationEvidenceAuthorityRequiredError extends Error {
  readonly code = SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE;
  readonly status = 409;

  constructor() {
    super(
      "Carrier registration identifiers and authoritative status require durable provider-bound evidence.",
    );
    this.name = "SmsRegistrationEvidenceAuthorityRequiredError";
  }
}

export interface SmsSenderProfile {
  id: string;
  provider: "twilio" | "telnyx" | "bandwidth";
  country: "US" | "CA" | string;
  sender_type: "10dlc" | "toll_free" | "short_code" | string;
  phone_number?: string;
  messaging_service_sid?: string;
  brand_registration_sid?: string;
  campaign_registration_sid?: string;
  registration_status:
    | "not_started"
    | "draft"
    | "pending"
    | "approved"
    | "rejected"
    | "suspended";
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SmsSetupStatus {
  senders: SmsSenderProfile[];
  can_send: boolean;
  blocking_reasons: string[];
}

export interface SmsComplianceItem {
  key: string;
  label: string;
  complete: boolean;
  detail?: string;
}

export interface SmsComplianceStatus {
  can_send: boolean;
  senders: SmsSenderProfile[];
  items: SmsComplianceItem[];
}

export interface SmsPilotReadinessItem {
  key: string;
  label: string;
  status: "pass" | "warning" | "blocker";
  detail?: string;
  evidence?: string;
}

export interface SmsPilotReadiness {
  can_pilot: boolean;
  counts: Record<string, number>;
  items: SmsPilotReadinessItem[];
}

export interface SmsSenderPilotCertification {
  sender: SmsSenderProfile;
  can_pilot: boolean;
  generated_at: string;
  items: SmsPilotReadinessItem[];
  callback_url?: string;
  status_url?: string;
}

export interface SmsList {
  id: string;
  name: string;
  description: string;
  keyword?: string;
  sender_profile_id?: string;
  created_at: string;
  updated_at: string;
  recipient_count?: number;
}

export interface SmsListInput {
  name: string;
  description?: string;
  keyword?: string;
  sender_profile_id?: string;
}

export interface SmsSenderInput {
  provider?: SmsSenderProfile["provider"];
  country?: SmsSenderProfile["country"];
  sender_type?: SmsSenderProfile["sender_type"];
  phone_number?: string;
  messaging_service_sid?: string;
  brand_registration_sid?: string;
  campaign_registration_sid?: string;
  registration_status?: SmsSenderProfile["registration_status"];
  metadata?: Record<string, unknown>;
}

export interface TwilioBrandRegistrationInput {
  customer_profile_bundle_sid: string;
  a2p_profile_bundle_sid: string;
  brand_type?: string;
  skip_automatic_sec_vet?: boolean;
}

export interface A2PBrandRegistrationInput extends Partial<TwilioBrandRegistrationInput> {
  entity_type?: string;
  display_name?: string;
  company_name?: string;
  ein?: string;
  phone?: string;
  street?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  email?: string;
  website?: string;
  vertical?: string;
  alt_business_id?: string;
  alt_business_id_type?: string;
  stock_symbol?: string;
  stock_exchange?: string;
  brand_relationship?: string;
  business_contact_email?: string;
  is_main?: boolean;
}

export interface TwilioCampaignRegistrationInput {
  brand_registration_sid?: string;
  usecase?: string;
  description: string;
  message_flow: string;
  message_samples: string[];
  subscriber_opt_in?: boolean;
  has_embedded_links?: boolean;
  has_embedded_phone?: boolean;
  age_gated?: boolean;
  direct_lending?: boolean;
  opt_in_keywords?: string;
  opt_in_message?: string;
  opt_out_keywords?: string;
  opt_out_message?: string;
  help_keywords?: string;
  help_message?: string;
}

export interface A2PCampaignRegistrationInput extends Partial<TwilioCampaignRegistrationInput> {
  vertical?: string;
  sub_usecases?: string[];
  number_pool?: boolean;
  affiliate_marketing?: boolean;
  auto_renewal?: boolean;
  terms_and_conditions_link?: string;
  privacy_policy_link?: string;
}

export interface SmsRegistrationResource {
  sid?: string;
  status?: string;
  raw?: Record<string, unknown>;
}

export interface A2PRegistrationResult {
  sender: SmsSenderProfile;
  brand?: SmsRegistrationResource;
  campaign?: SmsRegistrationResource;
  message?: string;
}

export interface SmsConsentInput {
  list_id?: string;
  phone_e164: string;
  action: "revoked";
  source: "manual";
  proof_text: string;
}

export interface SmsConsentRevocationReceipt {
  ok: true;
  tenantId: string;
  phoneE164: string;
  action: "revoked";
  source: "manual";
  provider: "product";
}

export interface SmsCampaign {
  id: string;
  sender_profile_id?: string;
  list_id?: string;
  name: string;
  body: string;
  media_url?: string;
  status:
    | "draft"
    | "scheduled"
    | "sending"
    | "sent"
    | "paused"
    | "failed"
    | "cancelled";
  scheduled_at?: string;
  sent_at?: string;
  stats?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SmsCampaignInput {
  sender_profile_id?: string;
  list_id?: string;
  name: string;
  body: string;
  media_url?: string;
  status?: "draft" | "scheduled" | "paused";
  scheduled_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SmsBroadcastInput {
  limit?: number;
  link_tracking?: boolean;
}

export interface SmsBroadcastResult {
  campaign: SmsCampaign;
  recipients: number;
  queued: number;
  // SMS-037: recipients deferred to a future per-recipient send time
  // (included in queued).
  scheduled?: number;
  accepted: number;
  blocked: number;
  failed: number;
  segments: number;
  cost_micros: number;
  estimated_cost_micros?: number;
  cost_cap_micros?: number;
  link_tracking: boolean;
  blocking_codes?: string[];
}

export interface SmsCampaignReport {
  campaign: SmsCampaign;
  recipients: number;
  queued: number;
  sending: number;
  sent: number;
  blocked: number;
  failed: number;
  cancelled: number;
  delivered: number;
  undelivered: number;
  clicks: number;
  unique_clickers: number;
  segments: number;
  cost_micros: number;
  status_counts: Record<string, number>;
  link_clicks?: SmsLinkClickSummary[];
  recent_clicks?: SmsLinkClickEvent[];
}

export interface SmsLinkClickSummary {
  url: string;
  clicks: number;
  unique_clickers: number;
  last_clicked_at: string;
}

export interface SmsLinkClickEvent {
  phone_e164: string;
  message_id?: string;
  url: string;
  clicked_at: string;
}

export interface SmsSendInput {
  sender_profile_id: string;
  list_id: string;
  to: string;
  body: string;
  media_url?: string;
}

export interface SmsGateDecision {
  allowed: boolean;
  reason?: string;
  segments: number;
}

export interface SmsMessage {
  id: string;
  phone_e164: string;
  provider: string;
  provider_message_id?: string;
  direction: "outbound" | "inbound";
  body: string;
  segments: number;
  status: string;
  error_code?: string;
  error_message?: string;
  cost_micros: number;
  created_at: string;
}

export interface SmsMmsProviderSupport {
  provider: string;
  supports_mms: boolean;
  supports_media_url: boolean;
  smoke_test_required?: boolean;
  detail: string;
}

export interface SmsMmsSenderReadiness {
  sender_id: string;
  provider: string;
  country: string;
  sender_type: string;
  registration_status: string;
  ready: boolean;
  live_smoke_status?: string;
  live_smoke_required?: boolean;
  last_smoke_at?: string;
  warnings?: string[];
}

export interface SmsMmsReadiness {
  ready: boolean;
  supported_countries: string[];
  providers: SmsMmsProviderSupport[];
  senders: SmsMmsSenderReadiness[];
  live_smoke_required?: boolean;
  smoke_test_contract?: Record<string, unknown>;
  warnings?: string[];
}

export interface SmsCreditPreviewInput {
  body: string;
  media_url?: string;
  country?: string;
  sender_type?: string;
  recipient_count?: number;
}

export interface SmsCreditLineItem {
  label: string;
  credits: number;
  count: number;
  total: number;
}

export interface SmsCreditPreview {
  channel: "sms" | "mms" | string;
  country: string;
  region_status: string;
  mms: boolean;
  mms_supported: boolean;
  segments: number;
  recipient_count: number;
  per_recipient_credits: number;
  total_credits: number;
  credit_value_micros: number;
  estimated_cost_micros: number;
  estimated_duration_seconds: number;
  send_duration_label: string;
  line_items: SmsCreditLineItem[];
  balance_after_credits?: number;
  entitlement_status?: string;
  top_up_recommended?: boolean;
  warnings?: string[];
}

export interface SmsCreditBalance {
  tenant_id?: string;
  plan: string;
  included_credits: number;
  purchased_credits: number;
  used_credits: number;
  available_credits: number;
  period_start: string;
  period_end: string;
  entitlements: Record<string, unknown>;
  ledger_mode: string;
  warnings?: string[];
}

export interface SmsCreditTopUpQuote {
  credits: number;
  unit_price_micros: number;
  subtotal_micros: number;
  bonus_credits: number;
  total_credits: number;
  checkout_mode: string;
  entitlement_preview: SmsCreditBalance;
  line_items: SmsCreditLineItem[];
  warnings?: string[];
}

export interface SmsCreditTopUpCheckout {
  status: string;
  checkout_url?: string;
  quote: SmsCreditTopUpQuote;
  metadata?: Record<string, unknown>;
}

export interface SmsProgramRegion {
  country: string;
  label: string;
  status: "active" | "planned" | "unsupported" | string;
  supports_sms: boolean;
  supports_mms: boolean;
  sms_credits: number;
  mms_credits?: number;
  default_sender_types: string[];
  compliance_summary: string;
  provider_requirements?: string[];
  live_sending_enabled?: boolean;
  launch_phase?: string;
  required_setup?: string[];
}

export interface SmsTemplate {
  id: string;
  name: string;
  category: string;
  body: string;
  media_allowed: boolean;
  merge_fields: string[];
  tags: string[];
}

export interface SmsDiscountCode {
  id: string;
  code: string;
  label: string;
  percent_off?: number;
  amount_off_cents?: number;
  currency?: string;
  applies_to: string;
  max_redemptions?: number;
  times_redeemed: number;
  expires_at?: string;
  currently_redeemable: boolean;
  source?: string;
  sync_status?: string;
  store_provider?: string;
  created_at: string;
}

type SmsReadOptions = { signal?: AbortSignal };

export function getSmsSetup(
  opts: SmsReadOptions = {},
): Promise<SmsSetupStatus> {
  return api.get<SmsSetupStatus>("/api/v1/sms/setup", opts);
}

export function getSmsCompliance(
  opts: SmsReadOptions = {},
): Promise<SmsComplianceStatus> {
  return api.get<SmsComplianceStatus>("/api/v1/sms/compliance", opts);
}

export function getSmsPilotReadiness(
  opts: SmsReadOptions = {},
): Promise<SmsPilotReadiness> {
  return api.get<SmsPilotReadiness>("/api/v1/sms/pilot-readiness", opts);
}

export function getSmsMmsReadiness(
  _opts: SmsReadOptions = {},
): Promise<SmsMmsReadiness> {
  return heldSmsMmsReadiness();
}

export function previewSmsCredits(
  _input: SmsCreditPreviewInput,
  _opts: SmsReadOptions = {},
): Promise<SmsCreditPreview> {
  return heldSmsFinancialLedger();
}

export function getSmsCreditBalance(
  _opts: SmsReadOptions = {},
): Promise<SmsCreditBalance> {
  return heldSmsFinancialLedger();
}

/** One day's SMS credit consumption (SMS-045). */
export interface SmsCreditUsagePoint {
  date: string;
  used_credits: number;
}

export function getSmsCreditUsageSeries(
  _days = 30,
): Promise<SmsCreditUsagePoint[]> {
  return heldSmsFinancialLedger();
}

export function quoteSmsCreditTopUp(
  _input: { credits: number; plan?: string },
  _opts: SmsReadOptions = {},
): Promise<SmsCreditTopUpQuote> {
  return heldSmsFinancialLedger();
}

export function checkoutSmsCreditTopUp(_input: {
  credits: number;
  plan?: string;
}): Promise<SmsCreditTopUpCheckout> {
  return heldSmsFinancialLedger();
}

export function getSmsProgramRegions(opts: SmsReadOptions = {}): Promise<{
  items: SmsProgramRegion[];
}> {
  return api.get<{ items: SmsProgramRegion[] }>("/api/v1/sms/regions", opts);
}

export function getSmsTemplates(
  opts: SmsReadOptions = {},
): Promise<{ items: SmsTemplate[] }> {
  return api.get<{ items: SmsTemplate[] }>("/api/v1/sms/templates", opts);
}

/**
 * Custom, tenant-authored SMS templates (SMS-035). Reuses the mounted
 * quick-replies CRUD as the store — a quick reply IS a saved custom template.
 */
export interface SmsQuickReply {
  id: string;
  label: string;
  body: string;
  useCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function listSmsQuickReplies(
  opts: SmsReadOptions = {},
): Promise<SmsQuickReply[]> {
  return api
    .get<{ replies: SmsQuickReply[] }>("/api/v1/sms/quick-replies", opts)
    .then((r) => r.replies ?? []);
}

export function createSmsQuickReply(input: {
  label: string;
  body: string;
}): Promise<SmsQuickReply> {
  return api.post<SmsQuickReply>("/api/v1/sms/quick-replies", input);
}

export function updateSmsQuickReply(
  id: string,
  input: { label: string; body: string },
): Promise<SmsQuickReply> {
  return api.patch<SmsQuickReply>(
    `/api/v1/sms/quick-replies/${encodeURIComponent(id)}`,
    input,
  );
}

export function deleteSmsQuickReply(id: string): Promise<unknown> {
  return api.delete(`/api/v1/sms/quick-replies/${encodeURIComponent(id)}`);
}

export function getSmsDiscountCodes(
  query?: string,
  opts: SmsReadOptions = {},
): Promise<{
  items: SmsDiscountCode[];
}> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("q", query.trim());
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api.get<{ items: SmsDiscountCode[] }>(
    `/api/v1/sms/discount-codes${suffix}`,
    opts,
  );
}

export function getSmsSenderPilotCertification(
  senderId: string,
): Promise<SmsSenderPilotCertification> {
  return api.get<SmsSenderPilotCertification>(
    `/api/v1/sms/senders/${encodeURIComponent(senderId)}/pilot-certification`,
  );
}

// listSmsSenderPilotCertifications fetches every sender's cert in one
// round-trip. Closes the N+1 the SMS page used to fire on refresh.
export function listSmsSenderPilotCertifications(
  opts: SmsReadOptions = {},
): Promise<{
  items: SmsSenderPilotCertification[];
}> {
  return api.get<{ items: SmsSenderPilotCertification[] }>(
    "/api/v1/sms/senders/pilot-certifications",
    opts,
  );
}

export function listSmsLists(
  opts: SmsReadOptions = {},
): Promise<{ items: SmsList[] }> {
  return api.get<{ items: SmsList[] }>("/api/v1/sms/lists", opts);
}

export function createSmsList(input: SmsListInput): Promise<SmsList> {
  return api.post<SmsList>("/api/v1/sms/lists", input);
}

/** Edit an SMS list's metadata in place (SMS-004). */
export function updateSmsList(
  id: string,
  input: SmsListInput,
): Promise<SmsList> {
  return api.patch<SmsList>(
    `/api/v1/sms/lists/${encodeURIComponent(id)}`,
    input,
  );
}

/** Delete an SMS list (SMS-004). Referencing campaigns keep their history. */
export function deleteSmsList(id: string): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(
    `/api/v1/sms/lists/${encodeURIComponent(id)}`,
  );
}

/** One member of an SMS list's roster (SMS-004). */
export interface SmsListMember {
  phone_e164: string;
  status: string;
  source?: string;
  subscriber_email?: string;
  consent_at?: string;
}

export function listSmsListMembers(id: string): Promise<SmsListMember[]> {
  void id;
  return heldSmsEvidenceRead();
}

export function listSmsSenders(): Promise<{ items: SmsSenderProfile[] }> {
  return api.get<{ items: SmsSenderProfile[] }>("/api/v1/sms/senders");
}

export function upsertSmsSender(
  input: SmsSenderInput,
): Promise<SmsSenderProfile> {
  const status = input.registration_status?.trim().toLowerCase() ?? "";
  if (
    input.brand_registration_sid?.trim() ||
    input.campaign_registration_sid?.trim() ||
    (status !== "" && status !== "not_started" && status !== "draft")
  ) {
    return Promise.reject(new SmsRegistrationEvidenceAuthorityRequiredError());
  }
  return api.post<SmsSenderProfile>("/api/v1/sms/senders", input);
}

export function pauseSmsSender(
  senderId: string,
  reason?: string,
): Promise<SmsSenderProfile> {
  return api.post<SmsSenderProfile>(
    `/api/v1/sms/senders/${encodeURIComponent(senderId)}/pause`,
    { reason },
  );
}

export function resumeSmsSender(senderId: string): Promise<SmsSenderProfile> {
  return api.post<SmsSenderProfile>(
    `/api/v1/sms/senders/${encodeURIComponent(senderId)}/resume`,
    {},
  );
}

export function submitSmsBrandRegistration(
  senderId: string,
  input: A2PBrandRegistrationInput,
): Promise<A2PRegistrationResult> {
  void senderId;
  void input;
  return heldSmsA2PRegistration();
}

export function submitSmsCampaignRegistration(
  senderId: string,
  input: A2PCampaignRegistrationInput,
): Promise<A2PRegistrationResult> {
  void senderId;
  void input;
  return heldSmsA2PRegistration();
}

export function pollSmsA2PRegistration(
  senderId: string,
): Promise<A2PRegistrationResult> {
  void senderId;
  return heldSmsA2PRegistration();
}

export function recordSmsConsent(
  input: SmsConsentInput,
  expectedTenantId: string,
): Promise<SmsConsentRevocationReceipt> {
  if (!SMS_TENANT_UUID.test(expectedTenantId)) {
    throw new Error("SMS consent requires a canonical lowercase tenant UUID");
  }
  const candidate = input as unknown as Record<string, unknown>;
  const consentInputKeys = new Set([
    "list_id",
    "phone_e164",
    "action",
    "source",
    "proof_text",
  ]);
  if (Object.keys(candidate).some((key) => !consentInputKeys.has(key))) {
    throw Object.assign(
      new Error("SMS consent input contains unsupported evidence"),
      {
        code: "invalid_consent",
        status: 400,
      },
    );
  }
  if (candidate.action !== "revoked") {
    throw Object.assign(
      new Error(
        candidate.action === "granted"
          ? "Manual/API consent cannot restore carrier opt-in; a verified START or UNSTOP event is required."
          : "The operator endpoint accepts only action=revoked.",
      ),
      {
        code:
          candidate.action === "granted"
            ? "carrier_resubscribe_authority_required"
            : "invalid_consent_action",
        status: candidate.action === "granted" ? 409 : 400,
      },
    );
  }
  if (candidate.source !== "manual") {
    throw Object.assign(
      new Error("SMS operator revocations require source=manual"),
      {
        code: "invalid_consent_source",
        status: 400,
      },
    );
  }
  if (
    typeof candidate.phone_e164 !== "string" ||
    !SMS_NANP.test(input.phone_e164)
  ) {
    throw Object.assign(
      new Error("SMS consent requires an exact US/Canada number"),
      {
        code: "invalid_phone",
        status: 400,
      },
    );
  }
  const proof =
    typeof candidate.proof_text === "string" ? candidate.proof_text.trim() : "";
  if (
    !proof ||
    Array.from(proof).length > 500 ||
    /[\p{Cc}\p{Cf}]/u.test(proof) ||
    !hasOnlyUnicodeScalars(proof)
  ) {
    throw Object.assign(
      new Error("A safe operator revocation reason is required"),
      {
        code: "consent_reason_required",
        status: 400,
      },
    );
  }
  if (input.list_id !== undefined && !SMS_UUID_V4.test(input.list_id)) {
    throw Object.assign(
      new Error("SMS consent requires a canonical list UUIDv4"),
      {
        code: "invalid_list_id",
        status: 400,
      },
    );
  }
  return api
    .post<unknown>("/api/v1/sms/consent", {
      ...input,
      proof_text: proof,
    })
    .then((raw) =>
      decodeSmsConsentRevocationReceipt(
        raw,
        expectedTenantId,
        input.phone_e164,
      ),
    );
}

function decodeSmsConsentRevocationReceipt(
  raw: unknown,
  expectedTenantId: string,
  expectedPhone: string,
): SmsConsentRevocationReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid SMS consent revocation receipt");
  }
  const row = raw as Record<string, unknown>;
  const expectedKeys = new Set([
    "ok",
    "tenantId",
    "phoneE164",
    "action",
    "source",
    "provider",
  ]);
  if (
    Object.keys(row).length !== expectedKeys.size ||
    Object.keys(row).some((key) => !expectedKeys.has(key)) ||
    row.ok !== true ||
    row.tenantId !== expectedTenantId ||
    row.phoneE164 !== expectedPhone ||
    row.action !== "revoked" ||
    row.source !== "manual" ||
    row.provider !== "product"
  ) {
    throw new Error("Invalid SMS consent revocation receipt");
  }
  return row as unknown as SmsConsentRevocationReceipt;
}

export function listSmsCampaigns(
  opts: SmsReadOptions = {},
): Promise<{ items: SmsCampaign[] }> {
  return api.get<{ items: SmsCampaign[] }>("/api/v1/sms/campaigns", opts);
}

export function createSmsCampaign(
  input: SmsCampaignInput,
): Promise<SmsCampaign> {
  return api.post<SmsCampaign>("/api/v1/sms/campaigns", input);
}

/** Edit an existing draft/scheduled/paused SMS campaign in place (SMS-008). */
export function updateSmsCampaign(
  id: string,
  input: SmsCampaignInput,
): Promise<SmsCampaign> {
  return api.patch<SmsCampaign>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}`,
    input,
  );
}

export function getSmsCampaignReport(id: string): Promise<SmsCampaignReport> {
  void id;
  return heldSmsEvidenceRead();
}

// SMS-036: per-variant A/B send outcomes.
export interface SmsCampaignVariantStat {
  variant: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  segments: number;
  cost_micros: number;
}

export function listSmsCampaignVariants(
  id: string,
  signal?: AbortSignal,
): Promise<SmsCampaignVariantStat[]> {
  if (!id.trim() || id.length > 160) {
    return Promise.reject(new Error("Invalid SMS campaign id"));
  }
  return api
    .get<unknown>(`/api/v1/sms/campaigns/${encodeURIComponent(id)}/variants`, {
      signal,
    })
    .then((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid SMS campaign variants response");
      }
      const items = (value as Record<string, unknown>).items;
      // The server's A/B contract permits at most five variants. Accepting a
      // wider response would make a contract violation look like a real test.
      if (!Array.isArray(items) || items.length > 5) {
        throw new Error("Invalid SMS campaign variants response");
      }
      const seen = new Set<string>();
      return items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("Invalid SMS campaign variant");
        }
        const row = item as Record<string, unknown>;
        const variant =
          typeof row.variant === "string" ? row.variant.trim() : "";
        if (!variant || variant.length > 64 || seen.has(variant)) {
          throw new Error("Invalid SMS campaign variant identity");
        }
        seen.add(variant);
        const metric = (field: keyof SmsCampaignVariantStat): number => {
          const metricValue = row[field];
          if (
            typeof metricValue !== "number" ||
            !Number.isSafeInteger(metricValue) ||
            metricValue < 0
          ) {
            throw new Error(`Invalid SMS campaign variant ${field}`);
          }
          return metricValue;
        };
        const decoded = {
          variant,
          total: metric("total"),
          sent: metric("sent"),
          failed: metric("failed"),
          blocked: metric("blocked"),
          segments: metric("segments"),
          cost_micros: metric("cost_micros"),
        };
        if (decoded.sent + decoded.failed + decoded.blocked > decoded.total) {
          throw new Error("Invalid SMS campaign variant outcome totals");
        }
        return decoded;
      });
    });
}

export function smsCampaignReportExportPath(
  id: string,
  status: "all" | "blocked" | "failed" | "problems" | "undelivered" = "all",
): string {
  void id;
  void status;
  return heldSmsEvidencePath();
}

export function sendSmsCampaign(
  id: string,
  input: SmsBroadcastInput,
): Promise<SmsBroadcastResult> {
  return api.post<SmsBroadcastResult>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/send`,
    input,
  );
}

/** Re-queue a campaign's failed/undelivered recipients (SMS-034). */
export function retrySmsCampaignFailed(
  id: string,
): Promise<{ requeued: number; report?: SmsCampaignReport }> {
  return api.post<{ requeued: number; report?: SmsCampaignReport }>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/retry-failed`,
  );
}

export function scheduleSmsCampaign(
  id: string,
  scheduledAt: string,
): Promise<SmsCampaign> {
  return api.post<SmsCampaign>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/schedule`,
    { scheduled_at: scheduledAt },
  );
}

export function pauseSmsCampaign(id: string): Promise<SmsCampaign> {
  return api.post<SmsCampaign>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/pause`,
    {},
  );
}

export function resumeSmsCampaign(id: string): Promise<SmsCampaign> {
  return api.post<SmsCampaign>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/resume`,
    {},
  );
}

export function cancelSmsCampaign(id: string): Promise<SmsCampaign> {
  return api.post<SmsCampaign>(
    `/api/v1/sms/campaigns/${encodeURIComponent(id)}/cancel`,
    {},
  );
}

export function sendSmsTest(
  input: SmsSendInput,
): Promise<{ gate: SmsGateDecision; message: SmsMessage }> {
  return api.post<{ gate: SmsGateDecision; message: SmsMessage }>(
    "/api/v1/sms/test-send",
    input,
  );
}

// --- SMS suppressions (opt-out roster) --------------------------------------
// Wire shape mirrors apps/api/internal/sms/suppressions.go (SuppressionRow).
// The page subtitle promises "suppressions"; these endpoints back that promise.
export type { SmsSuppressionRow } from "./sms-suppression-contract";

const SMS_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Tenant UUIDs are authoritative values returned by /auth/me. Legacy and
// development tenants may predate UUIDv4 generation (the demo workspace is a
// canonical non-v4 UUID), so tenant binding must validate canonical UUID
// syntax and exact equality without inventing a UUID-version requirement.
const SMS_TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SMS_NANP = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const SMS_CURSOR = /^v1\.[A-Za-z0-9_-]+$/u;

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function listSmsSuppressions(input: {
  tenantId: string;
  limit?: number;
  cursor?: string;
  reason?: SmsSuppressionReason;
  phone?: string;
  signal?: AbortSignal;
}): Promise<SmsSuppressionsPage> {
  if (!SMS_TENANT_UUID.test(input.tenantId)) {
    throw new Error(
      "SMS suppressions require a canonical lowercase tenant UUID",
    );
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("SMS suppression limit must be an integer from 1 to 200");
  }
  if (
    input.cursor !== undefined &&
    (input.cursor.length < 1 ||
      input.cursor.length > 4_096 ||
      !SMS_CURSOR.test(input.cursor))
  ) {
    throw new Error("SMS suppression cursor is invalid");
  }
  if (
    input.reason !== undefined &&
    !SMS_SUPPRESSION_REASONS.includes(input.reason)
  ) {
    throw new Error("SMS suppression reason is unsupported");
  }
  if (input.phone !== undefined && !SMS_NANP.test(input.phone)) {
    throw new Error("SMS suppression phone must be exact US/Canada E.164");
  }
  if (input.phone !== undefined && input.cursor !== undefined) {
    throw new Error("Exact SMS suppression lookup cannot continue a cursor");
  }
  if (input.phone !== undefined && input.limit !== undefined) {
    throw new Error("Exact SMS suppression lookup does not accept a limit");
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.reason) params.set("reason", input.reason);
  const request = input.phone
    ? api.post<unknown>(
        "/api/v1/sms/suppressions/query",
        {
          phone: input.phone,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        {
          idempotencyKey: null,
          requireOnline: true,
          signal: input.signal,
        },
      )
    : api.get<unknown>(`/api/v1/sms/suppressions?${params.toString()}`, {
        signal: input.signal,
      });
  return request.then((raw) =>
    decodeSmsSuppressions(
      raw,
      input.tenantId,
      input.phone ? 1 : limit,
      input.reason,
      input.phone,
    ),
  );
}

/** One recorded SMS consent event (SMS-006). */
export interface SmsConsentEventRow {
  id: string;
  phone_e164: string;
  subscriber_email?: string;
  action: string;
  source: string;
  proof_text?: string;
  provider?: string;
  created_at: string;
}

export function listSmsConsent(
  action?: string,
  phone?: string,
): Promise<{ items: SmsConsentEventRow[]; total: number }> {
  void action;
  void phone;
  return heldSmsEvidenceRead();
}

/** Same-origin CSV export path for the consent log (SMS-006). */
export function smsConsentExportPath(action?: string, phone?: string): string {
  void action;
  void phone;
  return heldSmsEvidencePath();
}

export function addSmsSuppression(
  input: {
    phone: string;
    reason: "manual";
  },
  signal?: AbortSignal,
): Promise<SmsSuppressionRow> {
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(input.phone)) {
    throw new Error("SMS suppression requires an exact US/Canada number");
  }
  return api
    .post<unknown>("/api/v1/sms/suppressions", input, { signal })
    .then((raw) => {
      const row = decodeSmsSuppressionRow(raw);
      if (
        row.phone_e164 !== input.phone ||
        row.reason !== "manual" ||
        row.source !== "manual" ||
        row.reversible !== true
      ) {
        throw new Error("Invalid SMS suppression creation receipt identity");
      }
      return row;
    });
}

export function removeSmsSuppression(
  id: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; tenantId: string; id: string }> {
  if (!SMS_UUID_V4.test(id)) {
    throw new Error("SMS suppression removal requires a canonical UUIDv4");
  }
  if (!SMS_TENANT_UUID.test(expectedTenantId)) {
    throw new Error("SMS suppression removal requires a canonical tenant UUID");
  }
  return api
    .delete<unknown>(`/api/v1/sms/suppressions/${encodeURIComponent(id)}`, {
      signal,
    })
    .then((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).some(
          (key) => key !== "ok" && key !== "tenantId" && key !== "id",
        ) ||
        Object.keys(raw).length !== 3 ||
        (raw as { ok?: unknown }).ok !== true ||
        (raw as { tenantId?: unknown }).tenantId !== expectedTenantId ||
        (raw as { id?: unknown }).id !== id
      ) {
        throw new Error("Invalid SMS suppression removal receipt");
      }
      return { ok: true, tenantId: expectedTenantId, id };
    });
}

// --- Keyword auto-responses -------------------------------------------------
// Custom keyword rows project only current reply_only/opt_out actions. Only
// provider-authenticated START / UNSTOP owns opt-in authority.
export function listSmsKeywordResponses(
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<{
  tenantId: string;
  items: SmsKeywordResponse[];
}> {
  requireSmsKeywordTenant(expectedTenantId);
  return api
    .get<unknown>("/api/v1/sms/keyword-responses", { signal })
    .then((raw) => decodeSmsKeywordResponseList(raw, expectedTenantId));
}

export function createSmsKeywordResponse(
  input: SmsKeywordResponseInput,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsKeywordResponse> {
  requireSmsKeywordTenant(expectedTenantId);
  assertSafeSmsKeywordAction(input.action);
  assertSmsKeywordAutoReplyMutationAvailable(input, true);
  const expectedKeyword = canonicalSmsKeyword(input.keyword);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(input.keyword) || !expectedKeyword) {
    throw new Error("Invalid SMS keyword");
  }
  return api
    .post<unknown>("/api/v1/sms/keyword-responses", input, { signal })
    .then((raw) => {
      const row = decodeSmsKeywordResponse(raw, expectedTenantId);
      if (
        row.keyword !== expectedKeyword ||
        row.action !== input.action ||
        row.enabled !== (input.enabled ?? true) ||
        (input.action === "opt_out" &&
          row.response_body !==
            "You are unsubscribed from SMS marketing messages from this sender.")
      ) {
        throw new Error("Invalid SMS keyword creation receipt identity");
      }
      return row;
    });
}

export function updateSmsKeywordResponse(
  id: string,
  input: Partial<SmsKeywordResponseInput>,
  expectedUpdatedAt: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsKeywordResponse> {
  requireSmsKeywordId(id);
  requireSmsKeywordTenant(expectedTenantId);
  const version = requireSmsKeywordVersion(expectedUpdatedAt);
  if (input.action !== undefined) assertSafeSmsKeywordAction(input.action);
  assertSmsKeywordAutoReplyMutationAvailable(input, false);
  const expectedKeyword =
    input.keyword === undefined
      ? undefined
      : canonicalSmsKeyword(input.keyword);
  if (
    input.keyword !== undefined &&
    (!/^[A-Za-z0-9_.:-]+$/u.test(input.keyword) || !expectedKeyword)
  ) {
    throw new Error("Invalid SMS keyword");
  }
  return api
    .patch<unknown>(
      `/api/v1/sms/keyword-responses/${encodeURIComponent(id)}`,
      { ...input, expected_updated_at: version },
      { signal },
    )
    .then((raw) => {
      const row = decodeSmsKeywordResponse(raw, expectedTenantId);
      if (
        row.id !== id ||
        (expectedKeyword !== undefined && row.keyword !== expectedKeyword) ||
        (input.action !== undefined && row.action !== input.action) ||
        (input.enabled !== undefined && row.enabled !== input.enabled) ||
        (input.response_body !== undefined &&
          row.response_body !== input.response_body)
      ) {
        throw new Error("Invalid SMS keyword update receipt identity");
      }
      return row;
    });
}

export { SMS_AUTO_REPLY_DISPATCH_RELEASE_HELD_CODE };

export class SmsAutoReplyDispatchReleaseHeldError extends Error {
  readonly code = SMS_AUTO_REPLY_DISPATCH_RELEASE_HELD_CODE;
  readonly status = 503;

  constructor() {
    super(
      "Custom and HELP automatic reply dispatch is release-held; no outbound confirmation mutation was sent.",
    );
    this.name = "SmsAutoReplyDispatchReleaseHeldError";
  }
}

function assertSmsKeywordAutoReplyMutationAvailable(
  input: Partial<SmsKeywordResponseInput>,
  creating: boolean,
): void {
  const action: unknown = input.action;
  if (
    action === "reply_only" ||
    (creating && action !== "opt_out") ||
    (input.response_body !== undefined &&
      input.response_body !==
        "You are unsubscribed from SMS marketing messages from this sender.")
  ) {
    throw new SmsAutoReplyDispatchReleaseHeldError();
  }
}

function assertSafeSmsKeywordAction(
  action: unknown,
): asserts action is "opt_out" {
  if (action === "reply_only" || action === undefined) {
    throw new SmsAutoReplyDispatchReleaseHeldError();
  }
  if (action !== "opt_out") {
    throw Object.assign(
      new Error(
        "Custom opt-in keywords are disabled; only verified provider START or UNSTOP events may restore consent.",
      ),
      { code: "validation_failed", status: 422 },
    );
  }
}

export function deleteSmsKeywordResponse(
  id: string,
  expectedUpdatedAt: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsKeywordDeleteReceipt> {
  requireSmsKeywordId(id);
  requireSmsKeywordTenant(expectedTenantId);
  const version = requireSmsKeywordVersion(expectedUpdatedAt);
  return api
    .delete<unknown>(
      `/api/v1/sms/keyword-responses/${encodeURIComponent(id)}`,
      { body: { expected_updated_at: version }, signal },
    )
    .then((raw) => decodeSmsKeywordDeleteReceipt(raw, expectedTenantId, id));
}

// --- Two-way conversation inbox / per-message log ---------------------------
// Mirrors apps/api/internal/sms/inbox.go. NOTE: the conversations list is
// camelCase (ConversationSummary json tags) while the message rows are
// snake_case (Message json tags) — matched here to the live handlers.
export function listSmsConversations(opts: {
  tenantId: string;
  limit?: number;
  cursor?: string;
  filter?: "all" | "unread" | "unknown";
  sort?: "recent" | "oldest_unread";
  status?: "active" | "snoozed" | "archived" | "any";
  signal?: AbortSignal;
}): Promise<SmsConversationsResponse> {
  if (!SMS_TENANT_UUID.test(opts.tenantId)) {
    throw new Error("SMS inbox requires a canonical lowercase tenant UUID");
  }
  const filter = opts.filter ?? "all";
  const sort = opts.sort ?? "recent";
  const status = opts.status ?? "active";
  if (
    !["all", "unread", "unknown"].includes(filter) ||
    !["recent", "oldest_unread"].includes(sort) ||
    !["active", "snoozed", "archived", "any"].includes(status)
  ) {
    throw new Error("SMS inbox query identity is invalid");
  }
  const params = new URLSearchParams({ filter, sort, status });
  if (opts.limit !== undefined) {
    if (
      !Number.isSafeInteger(opts.limit) ||
      opts.limit < 1 ||
      opts.limit > 100
    ) {
      throw new Error("SMS inbox limit must be an integer from 1 to 100");
    }
    params.set("limit", String(opts.limit));
  }
  if (opts?.cursor !== undefined) {
    if (
      opts.cursor.length < 1 ||
      opts.cursor.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(opts.cursor)
    ) {
      throw new Error("SMS inbox cursor is invalid");
    }
    params.set("cursor", opts.cursor);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api
    .get<unknown>(
      `/api/v1/sms/conversations${suffix}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    )
    .then((raw) =>
      decodeSmsConversations(raw, {
        tenantId: opts.tenantId,
        query: { filter, sort, status },
      }),
    );
}

export function listSmsConversationMessages(
  phone: string,
  tenantId: string,
  opts?: { limit?: number; cursor?: string; signal?: AbortSignal },
): Promise<SmsMessagesResponse> {
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
    throw new Error("SMS thread requires an exact US/Canada number");
  }
  if (!SMS_TENANT_UUID.test(tenantId)) {
    throw new Error("SMS thread requires a canonical lowercase tenant UUID");
  }
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) {
    if (
      !Number.isSafeInteger(opts.limit) ||
      opts.limit < 1 ||
      opts.limit > 100
    ) {
      throw new Error("SMS thread limit must be an integer from 1 to 100");
    }
    params.set("limit", String(opts.limit));
  }
  if (opts?.cursor !== undefined) {
    if (
      opts.cursor.length < 1 ||
      opts.cursor.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(opts.cursor)
    ) {
      throw new Error("SMS thread cursor is invalid");
    }
    params.set("cursor", opts.cursor);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api
    .get<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(phone)}/messages${suffix}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    )
    .then((raw) => decodeSmsMessages(raw, { tenantId, phoneE164: phone }));
}

export function markSmsConversationRead(
  phone: string,
  messageIds: readonly string[],
  opts?: { signal?: AbortSignal },
): Promise<SmsMarkReadResponse> {
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
    throw new Error("SMS read boundary requires an exact US/Canada number");
  }
  if (
    messageIds.length < 1 ||
    messageIds.length > 500 ||
    new Set(messageIds).size !== messageIds.length ||
    messageIds.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          id,
        ),
    )
  ) {
    throw new Error("SMS read boundary requires 1–500 unique message UUIDs");
  }
  return api
    .post<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(phone)}/mark-read`,
      { message_ids: [...messageIds] },
      opts?.signal ? { signal: opts.signal } : undefined,
    )
    .then((raw) => decodeSmsMarkReadResponse(raw, messageIds.length));
}

function requireSmsInboxIdentity(phone: string, tenantId: string): void {
  if (!SMS_NANP.test(phone)) {
    throw new Error("SMS inbox state requires an exact US/Canada number");
  }
  if (!SMS_TENANT_UUID.test(tenantId)) {
    throw new Error(
      "SMS inbox state requires a canonical lowercase tenant UUID",
    );
  }
}

function requireSmsStateVersion(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length < 20 ||
    value.length > 64 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !isSmsInboxRfc3339(value)
  ) {
    throw new Error(
      "SMS inbox mutation requires the exact loaded stateUpdatedAt value",
    );
  }
  return value;
}

interface SmsStateMutationInput {
  tenantId: string;
  phoneE164: string;
  action: SmsConversationStateAction;
  expectedUpdatedAt: string | null;
  until?: string;
  assigneeUserId?: string | null;
  signal?: AbortSignal;
}

function mutateSmsConversationState(
  input: SmsStateMutationInput,
): Promise<SmsConversationStateMutationReceipt> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  const expectedUpdatedAt = requireSmsStateVersion(input.expectedUpdatedAt);
  const body: Record<string, unknown> = { expectedUpdatedAt };
  if (input.action === "snooze") {
    if (
      !input.until ||
      !isSmsInboxRfc3339(input.until) ||
      Date.parse(input.until) <= Date.now()
    ) {
      throw new Error("SMS snooze requires a future RFC3339 timestamp");
    }
    body.until = input.until;
  }
  if (input.action === "assign") {
    const assignee = input.assigneeUserId ?? "";
    if (assignee !== "" && !SMS_UUID_V4.test(assignee)) {
      throw new Error("SMS assignment requires a canonical member UUIDv4");
    }
    body.userId = assignee;
  }
  return api
    .post<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/${input.action}`,
      body,
      {
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationStateMutation(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
        action: input.action,
        ...(input.until ? { snoozeUntil: input.until } : {}),
        ...(input.action === "assign"
          ? { assigneeUserId: input.assigneeUserId ?? null }
          : {}),
      }),
    );
}

export function snoozeSmsConversation(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  until: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  return mutateSmsConversationState({ ...input, action: "snooze" });
}

export function unsnoozeSmsConversation(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  return mutateSmsConversationState({ ...input, action: "unsnooze" });
}

export function archiveSmsConversation(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  return mutateSmsConversationState({ ...input, action: "archive" });
}

export function unarchiveSmsConversation(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  return mutateSmsConversationState({ ...input, action: "unarchive" });
}

export function assignSmsConversation(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  assigneeUserId: string | null;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  return mutateSmsConversationState({ ...input, action: "assign" });
}

/**
 * Server contract for internal conversation notes (internal/sms
 * inbox_extras.go SetConversationNotes): at most 4,000 Unicode scalars, no
 * leading/trailing whitespace, and no control or invisible format characters
 * (so no line breaks). An empty string clears the notes. Returns the reason a
 * value is refused, or null when it is sendable.
 */
export function smsConversationNotesProblem(notes: string): string | null {
  if (notes.trim() !== notes) {
    return "Remove leading and trailing spaces from the notes.";
  }
  if (Array.from(notes).length > 4000) {
    return "Keep notes to 4,000 characters or fewer.";
  }
  if (/[\p{Cc}\p{Cf}]/u.test(notes) || !hasOnlyUnicodeScalars(notes)) {
    return "Notes must be a single line without hidden or control characters.";
  }
  return null;
}

/**
 * POST /api/v1/sms/conversations/{phone}/notes — overwrite the internal
 * operator notes. Compare-and-set on the loaded stateUpdatedAt, one attempt,
 * never queued offline: a stale write gets the server's 409 instead of
 * silently replacing someone else's newer notes.
 */
export function setSmsConversationNotes(input: {
  tenantId: string;
  phoneE164: string;
  expectedUpdatedAt: string | null;
  notes: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateMutationReceipt> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  const expectedUpdatedAt = requireSmsStateVersion(input.expectedUpdatedAt);
  const problem = smsConversationNotesProblem(input.notes);
  if (problem) throw new Error(problem);
  return api
    .post<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/notes`,
      { notes: input.notes, expectedUpdatedAt },
      {
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationStateMutation(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
        action: "notes",
      }),
    );
}

export function listSmsConversationTags(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<SmsConversationTagsResponse> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  return api
    .get<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/tags`,
      input.signal ? { signal: input.signal } : undefined,
    )
    .then((raw) =>
      decodeSmsConversationTags(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
      }),
    );
}

function requireSmsConversationTag(tag: string): string {
  if (
    tag.length < 1 ||
    Array.from(tag).length > 64 ||
    new TextEncoder().encode(tag).byteLength > 256 ||
    tag.trim() !== tag ||
    /[\p{Cc}\p{Cf}]/u.test(tag) ||
    !hasOnlyUnicodeScalars(tag)
  ) {
    throw new Error(
      "SMS conversation tag must be 1–64 visible characters without surrounding whitespace",
    );
  }
  return tag;
}

export function addSmsConversationTag(input: {
  tenantId: string;
  phoneE164: string;
  tag: string;
  signal?: AbortSignal;
}): Promise<SmsConversationTagMutationReceipt> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  const tag = requireSmsConversationTag(input.tag);
  return api
    .post<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/tags`,
      { tag, expectedAbsent: true },
      {
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationTagMutation(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
        tag,
        action: "add",
      }),
    );
}

export function removeSmsConversationTag(input: {
  tenantId: string;
  phoneE164: string;
  tag: string;
  expectedCreatedAt: string;
  signal?: AbortSignal;
}): Promise<SmsConversationTagMutationReceipt> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  const tag = requireSmsConversationTag(input.tag);
  if (!isSmsInboxRfc3339(input.expectedCreatedAt)) {
    throw new Error("SMS tag removal requires its exact loaded createdAt");
  }
  return api
    .delete<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/tags`,
      {
        body: { tag, expectedCreatedAt: input.expectedCreatedAt },
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationTagMutation(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
        tag,
        action: "remove",
        createdAt: input.expectedCreatedAt,
      }),
    );
}

export function getSmsConversationActivity(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<SmsConversationActivityResponse> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  return api
    .get<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/activity`,
      input.signal ? { signal: input.signal } : undefined,
    )
    .then((raw) =>
      decodeSmsConversationActivity(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
      }),
    );
}

export function bulkMutateSmsConversations(input: {
  tenantId: string;
  action: "archive" | "unarchive" | "snooze" | "unsnooze";
  conversations: ReadonlyArray<{
    phoneE164: string;
    expectedUpdatedAt: string | null;
  }>;
  until?: string;
  signal?: AbortSignal;
}): Promise<SmsConversationBulkMutationReceipt> {
  if (
    input.conversations.length < 1 ||
    input.conversations.length > 200 ||
    new Set(input.conversations.map((row) => row.phoneE164)).size !==
      input.conversations.length
  ) {
    throw new Error("SMS bulk mutation requires 1–200 unique conversations");
  }
  for (const row of input.conversations) {
    requireSmsInboxIdentity(row.phoneE164, input.tenantId);
    requireSmsStateVersion(row.expectedUpdatedAt);
  }
  if (
    input.action === "snooze" &&
    (!input.until ||
      !isSmsInboxRfc3339(input.until) ||
      Date.parse(input.until) <= Date.now())
  ) {
    throw new Error("SMS bulk snooze requires a future RFC3339 timestamp");
  }
  const conversations = input.conversations.map((row) => ({
    phoneE164: row.phoneE164,
    expectedUpdatedAt: row.expectedUpdatedAt,
  }));
  return api
    .post<unknown>(
      "/api/v1/sms/conversations/bulk",
      {
        conversations,
        action: input.action,
        ...(input.until ? { until: input.until } : {}),
      },
      {
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationBulkMutation(raw, {
        tenantId: input.tenantId,
        action: input.action,
        conversations: conversations.map((row) => ({
          phoneE164: row.phoneE164,
          ...(input.until ? { snoozeUntil: input.until } : {}),
        })),
      }),
    );
}

// --- SMS broadcasts (one-to-many sends) --------------------------------------
// Wire shape mirrors apps/api/internal/sms/{broadcasts,broadcast_handlers}.go.
// Every route is owner/admin-only (broadcastAdmin = RequireExactTenantAdmin).
// Dispatch (POST …/send) is release-held server-side today (503
// `sms_broadcast_dispatch_release_held`); the list payload reports readiness
// as `broadcastDispatchAvailable` and the page disables Send/Schedule on that
// verdict. `sendSmsBroadcast` below is the full transport for when it lifts.

export const SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE =
  "sms_broadcast_dispatch_release_held" as const;

export type SmsBroadcastStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "cancelled";

export interface SmsBroadcast {
  id: string;
  tenant_id?: string;
  sender_profile_id?: string;
  campaign_id?: string;
  name: string;
  body: string;
  list_ids: string[];
  segment_id?: string;
  tag?: string;
  /** Known statuses plus anything newer the server starts emitting (render, don't switch). */
  status: SmsBroadcastStatus | (string & {});
  scheduled_at?: string | null;
  sent_count: number;
  failed_count: number;
  held_count: number;
  /** Server-side SegmentCount of the stored body (GSM-7 160/153, UCS-2 70/67). */
  segments_per_message: number;
  created_at: string;
  updated_at: string;
}

/**
 * POST/PATCH body. Every field is sent explicitly: the server applies each
 * non-nil field, so a PATCH that omitted the unchosen audience dimensions
 * would leave a stale second audience behind and trip 422 `invalid_audience`.
 */
export interface SmsBroadcastUpsert {
  name: string;
  body: string;
  sender_profile_id: string;
  list_ids: string[];
  segment_id: string;
  tag: string;
  /** RFC3339 or null to clear. */
  scheduled_at: string | null;
}

export interface SmsBroadcastProgress {
  status: string;
  sent: number;
  failed: number;
  held: number;
  total: number;
}

export interface SmsBroadcastsPage {
  tenantId: string;
  items: SmsBroadcast[];
  nextCursor?: string;
  snapshotAt: string;
  broadcastDispatchAvailable: boolean;
  broadcastDispatchUnavailableReason?: string;
}

const SMS_BROADCAST_LIST_LIMIT = 50;

function smsBroadcastRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return raw as Record<string, unknown>;
}

function smsBroadcastText(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`${label} is missing ${field}`);
  }
  return value;
}

function smsBroadcastOptionalText(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} has an invalid ${field}`);
  }
  return value;
}

function smsBroadcastCount(
  record: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} has an invalid ${field}`);
  }
  return value;
}

export function requireSmsBroadcastId(id: string): string {
  if (typeof id !== "string" || !SMS_TENANT_UUID.test(id)) {
    throw new Error("SMS broadcast id must be a canonical lowercase UUID");
  }
  return id;
}

export function decodeSmsBroadcast(raw: unknown): SmsBroadcast {
  const label = "SMS broadcast";
  const record = smsBroadcastRecord(raw, label);
  const id = smsBroadcastText(record, "id", label);
  if (!SMS_TENANT_UUID.test(id)) {
    throw new Error(`${label} has an invalid id`);
  }
  const listIdsRaw = record.list_ids;
  const list_ids =
    listIdsRaw === undefined || listIdsRaw === null ? [] : listIdsRaw;
  if (
    !Array.isArray(list_ids) ||
    list_ids.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} has invalid list_ids`);
  }
  const scheduledRaw = record.scheduled_at;
  const scheduled_at =
    scheduledRaw === undefined || scheduledRaw === null
      ? null
      : smsBroadcastText(record, "scheduled_at", label);
  return {
    id,
    tenant_id: smsBroadcastOptionalText(record, "tenant_id", label),
    sender_profile_id: smsBroadcastOptionalText(
      record,
      "sender_profile_id",
      label,
    ),
    campaign_id: smsBroadcastOptionalText(record, "campaign_id", label),
    name: smsBroadcastText(record, "name", label),
    body: smsBroadcastText(record, "body", label),
    list_ids: list_ids as string[],
    segment_id: smsBroadcastOptionalText(record, "segment_id", label),
    tag: smsBroadcastOptionalText(record, "tag", label),
    status: smsBroadcastText(record, "status", label),
    scheduled_at,
    sent_count: smsBroadcastCount(record, "sent_count", label),
    failed_count: smsBroadcastCount(record, "failed_count", label),
    held_count: smsBroadcastCount(record, "held_count", label),
    segments_per_message: smsBroadcastCount(
      record,
      "segments_per_message",
      label,
    ),
    created_at: smsBroadcastText(record, "created_at", label),
    updated_at: smsBroadcastText(record, "updated_at", label),
  };
}

export function decodeSmsBroadcastProgress(raw: unknown): SmsBroadcastProgress {
  const label = "SMS broadcast progress";
  const record = smsBroadcastRecord(raw, label);
  return {
    status: smsBroadcastText(record, "status", label),
    sent: smsBroadcastCount(record, "sent", label),
    failed: smsBroadcastCount(record, "failed", label),
    held: smsBroadcastCount(record, "held", label),
    total: smsBroadcastCount(record, "total", label),
  };
}

export function decodeSmsBroadcastsPage(
  raw: unknown,
  expectedTenantId: string,
): SmsBroadcastsPage {
  const label = "SMS broadcasts";
  const record = smsBroadcastRecord(raw, label);
  const tenantId = smsBroadcastText(record, "tenantId", label);
  if (tenantId !== expectedTenantId) {
    throw new Error(`${label} response is bound to a different tenant`);
  }
  const itemsRaw = record.items;
  const items =
    itemsRaw === undefined || itemsRaw === null ? [] : itemsRaw;
  if (!Array.isArray(items)) {
    throw new Error(`${label} returned invalid items`);
  }
  const nextCursor = smsBroadcastOptionalText(record, "nextCursor", label);
  if (nextCursor !== undefined && nextCursor !== "" && !SMS_CURSOR.test(nextCursor)) {
    throw new Error(`${label} returned an invalid continuation cursor`);
  }
  if (typeof record.broadcastDispatchAvailable !== "boolean") {
    throw new Error(`${label} is missing the dispatch-readiness verdict`);
  }
  return {
    tenantId,
    items: items.map(decodeSmsBroadcast),
    nextCursor: nextCursor ? nextCursor : undefined,
    snapshotAt: smsBroadcastText(record, "snapshotAt", label),
    broadcastDispatchAvailable: record.broadcastDispatchAvailable,
    broadcastDispatchUnavailableReason: smsBroadcastOptionalText(
      record,
      "broadcastDispatchUnavailableReason",
      label,
    ),
  };
}

/** GET /api/v1/sms/broadcasts — one bounded, tenant-bound page (cursor-paginated). */
export function listSmsBroadcasts(input: {
  tenantId: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<SmsBroadcastsPage> {
  if (!SMS_TENANT_UUID.test(input.tenantId)) {
    throw new Error("SMS broadcasts require a canonical lowercase tenant UUID");
  }
  const limit = input.limit ?? SMS_BROADCAST_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("SMS broadcast limit must be an integer from 1 to 200");
  }
  if (
    input.cursor !== undefined &&
    (input.cursor.length < 1 ||
      input.cursor.length > 4_096 ||
      !SMS_CURSOR.test(input.cursor))
  ) {
    throw new Error("SMS broadcast cursor is invalid");
  }
  return api
    .get<unknown>("/api/v1/sms/broadcasts", {
      query: { limit, cursor: input.cursor },
      signal: input.signal,
    })
    .then((raw) => decodeSmsBroadcastsPage(raw, input.tenantId));
}

/** GET /api/v1/sms/broadcasts/{id} */
export function getSmsBroadcast(
  id: string,
  signal?: AbortSignal,
): Promise<SmsBroadcast> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .get<unknown>(`/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}`, {
      signal,
    })
    .then(decodeSmsBroadcast);
}

/** POST /api/v1/sms/broadcasts — creates an editable draft definition only. */
export function createSmsBroadcast(
  input: SmsBroadcastUpsert,
  signal?: AbortSignal,
): Promise<SmsBroadcast> {
  return api
    .post<unknown>("/api/v1/sms/broadcasts", input, {
      requireOnline: true,
      signal,
    })
    .then(decodeSmsBroadcast);
}

/** PATCH /api/v1/sms/broadcasts/{id} — server-enforced draft|scheduled only. */
export function updateSmsBroadcast(
  id: string,
  input: SmsBroadcastUpsert,
  signal?: AbortSignal,
): Promise<SmsBroadcast> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .patch<unknown>(
      `/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}`,
      input,
      { requireOnline: true, signal },
    )
    .then(decodeSmsBroadcast);
}

/** DELETE /api/v1/sms/broadcasts/{id} — refused while sending (409 broadcast_sending). */
export function deleteSmsBroadcast(
  id: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .delete<unknown>(
      `/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}`,
      { requireOnline: true, signal },
    )
    .then((raw) => {
      if (smsBroadcastRecord(raw, "SMS broadcast deletion").ok !== true) {
        throw new Error("Invalid SMS broadcast deletion receipt");
      }
      return { ok: true as const };
    });
}

/** POST /api/v1/sms/broadcasts/{id}/cancel — still-queued recipients are marked cancelled. */
export function cancelSmsBroadcast(
  id: string,
  signal?: AbortSignal,
): Promise<SmsBroadcast> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .post<unknown>(
      `/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}/cancel`,
      undefined,
      { requireOnline: true, signal },
    )
    .then(decodeSmsBroadcast);
}

export interface SmsBroadcastSendResult {
  broadcast: SmsBroadcast;
  progress: SmsBroadcastProgress;
  /** Recipients queued by THIS call; a replayed send reports 0. */
  enqueued: number;
}

export function decodeSmsBroadcastSendResult(raw: unknown): SmsBroadcastSendResult {
  const label = "SMS broadcast send";
  const record = smsBroadcastRecord(raw, label);
  return {
    broadcast: decodeSmsBroadcast(record.broadcast),
    progress: decodeSmsBroadcastProgress(record.progress),
    enqueued: smsBroadcastCount(record, "enqueued", label),
  };
}

/**
 * POST /api/v1/sms/broadcasts/{id}/send — starts (scheduled_at in the past or
 * unset) or arms (scheduled_at in the future) the broadcast. The server claims
 * draft|scheduled → sending exactly once, so a repeated POST replays progress
 * instead of double-enqueueing. Callers gate this on the list payload's
 * `broadcastDispatchAvailable`; the server answers 503
 * `sms_broadcast_dispatch_release_held` while dispatch is held.
 */
export function sendSmsBroadcast(
  id: string,
  signal?: AbortSignal,
): Promise<SmsBroadcastSendResult> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .post<unknown>(
      `/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}/send`,
      undefined,
      { requireOnline: true, signal },
    )
    .then(decodeSmsBroadcastSendResult);
}

/** GET /api/v1/sms/broadcasts/{id}/progress — refreshes counters; lazily finalises sending → sent. */
export function getSmsBroadcastProgress(
  id: string,
  signal?: AbortSignal,
): Promise<SmsBroadcastProgress> {
  const broadcastId = requireSmsBroadcastId(id);
  return api
    .get<unknown>(
      `/api/v1/sms/broadcasts/${encodeURIComponent(broadcastId)}/progress`,
      { signal },
    )
    .then(decodeSmsBroadcastProgress);
}

// --- SMS conversation lookup: server search, context, audited CSV -----------
// Wire contract lives in ./sms-conversation-lookup-contract (mirrors
// apps/api/internal/sms inbox_extras.go + inbox.go). All three routes are
// exact owner/admin (`admin...` middleware) like the rest of the inbox.

export type {
  SmsConversationContext,
  SmsConversationEligibleList,
  SmsConversationSearchPage,
  SmsConversationsExportTruth,
} from "./sms-conversation-lookup-contract";

/**
 * POST /api/v1/sms/conversations/search — server search by phone, subscriber
 * email, or message text. POST so the search text never enters a URL; the
 * cursor is bound server-side to the tenant, normalized query and snapshot.
 * A read: no idempotency key, never queued offline.
 */
export function searchSmsConversations(input: {
  tenantId: string;
  query: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SmsConversationSearchPage> {
  if (!SMS_TENANT_UUID.test(input.tenantId)) {
    throw new Error("SMS search requires a canonical lowercase tenant UUID");
  }
  const query = input.query.trim();
  const problem = smsSearchQueryProblem(query);
  if (problem) throw new Error(problem);
  const limit = input.limit ?? 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SMS_SEARCH_MAX_LIMIT
  ) {
    throw new Error(
      `SMS search limit must be an integer from 1 to ${SMS_SEARCH_MAX_LIMIT}`,
    );
  }
  if (input.cursor !== undefined && !isSmsOpaqueCursor(input.cursor)) {
    throw new Error("SMS search cursor is invalid");
  }
  return api
    .post<unknown>(
      "/api/v1/sms/conversations/search",
      {
        query,
        limit,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      },
      {
        idempotencyKey: null,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then((raw) =>
      decodeSmsConversationSearch(raw, { tenantId: input.tenantId, limit }),
    );
}

/**
 * GET /api/v1/sms/conversations/{phone}/context — linked subscriber, eligible
 * consent lists, suppression category, reply-dispatch availability and the
 * retained message count for one exact US/Canada number.
 */
export function getSmsConversationContext(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<SmsConversationContext> {
  requireSmsInboxIdentity(input.phoneE164, input.tenantId);
  return api
    .get<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/context`,
      input.signal ? { signal: input.signal } : undefined,
    )
    .then((raw) =>
      decodeSmsConversationContext(raw, {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
      }),
    );
}

export interface SmsConversationsExport {
  csv: string;
  filename: string;
  truth: SmsConversationsExportTruth;
}

/**
 * GET /api/v1/sms/conversations.csv — tenant-wide conversation summary
 * (server-built, spreadsheet-safe cells). The audit reason travels in the
 * X-Postwave-Audit-Reason header and is recorded with the export audit event,
 * so this is one attempt, online only: a silent retry would record a second
 * export. The file is refused unless the server's row-limit / as-of /
 * row-count / truncation headers are present, consistent, and match the body.
 */
export async function exportSmsConversationsCsv(input: {
  auditReason: string;
  signal?: AbortSignal;
}): Promise<SmsConversationsExport> {
  const reason = input.auditReason.trim();
  const problem = smsExportReasonProblem(reason);
  if (problem) throw new Error(problem);
  let responseHeaders: Headers | null = null;
  const body = await api.get<unknown>("/api/v1/sms/conversations.csv", {
    headers: {
      Accept: "text/csv",
      "X-Postwave-Audit-Reason": reason,
    },
    maxAttempts: 1,
    requireOnline: true,
    cache: "no-store",
    onResponse: (response) => {
      responseHeaders = response.headers;
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const observed = responseHeaders as Headers | null;
  const truth = observed ? parseSmsConversationsExportTruth(observed) : null;
  if (!observed || !truth) {
    throw new Error(
      "The export response omitted or contradicted its row limit, row count, or as-of metadata. Nothing was saved.",
    );
  }
  if (
    typeof body !== "string" ||
    !smsConversationsCsvMatchesTruth(body, truth)
  ) {
    throw new Error(
      "The export body did not match the server's stated header or row count. Nothing was saved.",
    );
  }
  return {
    csv: body,
    filename: smsConversationsExportFilename(
      observed.get("Content-Disposition"),
      truth.asOf,
    ),
    truth,
  };
}

// --- Reply dispatch: POST /api/v1/sms/conversations/{phone}/reply -----------
// Mirrors apps/api/internal/sms/reply_intent.go (ReplyInput / ReplyResponse /
// ReplyReconciliationResponse). Exactly one principal-scoped Idempotency-Key
// per intent — minted and checkpointed by src/lib/sms-reply-recovery.ts before
// the request leaves — one attempt, never queued offline. While the dispatch
// saga is held the server answers 503 `sms_reply_dispatch_release_held`; the
// same verdict arrives up front as `replyDispatchAvailable:false` on the
// conversation context, which is what every composer disables Send on.

import {
  smsReplyBodyConstraint,
  SMS_REPLY_DISPATCH_RELEASE_HELD_CODE,
  type SmsReplyRequest,
} from "./sms-reply-intent";

export { SMS_REPLY_DISPATCH_RELEASE_HELD_CODE };
export type { SmsReplyRequest };

export interface SmsReplyProviderReceipt {
  provider: string;
  providerMessageId?: string;
  status: string;
}

/** Content-minimized message receipt (no phone, body or media). */
export interface SmsReplyMessageReceipt {
  id: string;
  tenant_id: string;
  sender_profile_id: string;
  provider: string;
  provider_message_id: string;
  direction: string;
  segments: number;
  status: string;
  cost_micros: number;
  sent_at?: string;
  created_at: string;
}

export type SmsReplyOutcome =
  | {
      disposition: "persisted";
      message: SmsReplyMessageReceipt;
      providerReceipt: SmsReplyProviderReceipt;
    }
  | {
      disposition: "reconciliation_required";
      code: string;
      intentMessageId: string;
      providerReceipt: SmsReplyProviderReceipt;
    };

function smsReplyRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return raw as Record<string, unknown>;
}

function smsReplyText(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${label} is missing ${field}`);
  return value;
}

function decodeSmsReplyProviderReceipt(raw: unknown): SmsReplyProviderReceipt {
  const label = "SMS reply provider receipt";
  const record = smsReplyRecord(raw, label);
  const providerMessageId = record.providerMessageId;
  if (providerMessageId !== undefined && typeof providerMessageId !== "string") {
    throw new Error(`${label} has an invalid providerMessageId`);
  }
  return {
    provider: smsReplyText(record, "provider", label),
    status: smsReplyText(record, "status", label),
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

export function decodeSmsReplyOutcome(raw: unknown): SmsReplyOutcome {
  const label = "SMS reply";
  const record = smsReplyRecord(raw, label);
  const disposition = smsReplyText(record, "disposition", label);
  if (disposition === "reconciliation_required") {
    return {
      disposition,
      code: smsReplyText(record, "code", label),
      intentMessageId: smsReplyText(record, "intentMessageId", label),
      providerReceipt: decodeSmsReplyProviderReceipt(record.providerReceipt),
    };
  }
  if (disposition !== "persisted") {
    throw new Error(`${label} returned an unknown disposition`);
  }
  const messageLabel = "SMS reply message receipt";
  const message = smsReplyRecord(record.message, messageLabel);
  const id = smsReplyText(message, "id", messageLabel);
  if (!SMS_UUID_V4.test(id)) {
    throw new Error(`${messageLabel} has an invalid id`);
  }
  const segments = message.segments;
  const costMicros = message.cost_micros;
  if (
    typeof segments !== "number" ||
    !Number.isSafeInteger(segments) ||
    segments < 0 ||
    typeof costMicros !== "number" ||
    !Number.isSafeInteger(costMicros) ||
    costMicros < 0
  ) {
    throw new Error(`${messageLabel} has invalid counters`);
  }
  const sentAt = message.sent_at;
  if (sentAt !== undefined && sentAt !== null && typeof sentAt !== "string") {
    throw new Error(`${messageLabel} has an invalid sent_at`);
  }
  return {
    disposition,
    message: {
      id,
      tenant_id: smsReplyText(message, "tenant_id", messageLabel),
      sender_profile_id: smsReplyText(message, "sender_profile_id", messageLabel),
      provider: smsReplyText(message, "provider", messageLabel),
      provider_message_id: smsReplyText(
        message,
        "provider_message_id",
        messageLabel,
      ),
      direction: smsReplyText(message, "direction", messageLabel),
      segments,
      status: smsReplyText(message, "status", messageLabel),
      cost_micros: costMicros,
      ...(typeof sentAt === "string" ? { sent_at: sentAt } : {}),
      created_at: smsReplyText(message, "created_at", messageLabel),
    },
    providerReceipt: decodeSmsReplyProviderReceipt(record.providerReceipt),
  };
}

function smsReplyMediaUrlValid(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * One reply intent = one request with one Idempotency-Key. Refuses locally
 * anything the server would 400 (phone, key, sender/list UUIDs, body
 * boundary, media URL) so a refused draft never spends a key.
 */
export function replySmsConversation(input: {
  phoneE164: string;
  request: SmsReplyRequest;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SmsReplyOutcome> {
  if (!SMS_NANP.test(input.phoneE164)) {
    throw new Error("SMS reply requires an exact US/Canada number");
  }
  const key = input.idempotencyKey;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    new TextEncoder().encode(key).byteLength > 255
  ) {
    throw new Error("SMS reply requires one durable idempotency key");
  }
  const { request } = input;
  if (!SMS_UUID_V4.test(request.sender_profile_id)) {
    throw new Error("SMS reply requires a canonical sender profile UUIDv4");
  }
  if (!SMS_UUID_V4.test(request.list_id)) {
    throw new Error("SMS reply requires one exact eligible list UUIDv4");
  }
  const constraint = smsReplyBodyConstraint(request.body);
  if (constraint.error) throw new Error(constraint.error);
  const mediaUrl = request.media_url?.trim();
  if (mediaUrl && !smsReplyMediaUrlValid(mediaUrl)) {
    throw new Error(
      "SMS reply media_url must be an absolute HTTPS URL without credentials",
    );
  }
  return api
    .post<unknown>(
      `/api/v1/sms/conversations/${encodeURIComponent(input.phoneE164)}/reply`,
      {
        sender_profile_id: request.sender_profile_id,
        body: constraint.trimmed,
        list_id: request.list_id,
        ...(mediaUrl ? { media_url: mediaUrl } : {}),
      },
      {
        idempotencyKey: key,
        maxAttempts: 1,
        requireOnline: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    .then(decodeSmsReplyOutcome);
}

export interface SmsQuickReplyUseReceipt {
  ok: true;
  tenantId: string;
  id: string;
  useCount: number;
  lastUsedAt: string;
}

/**
 * POST /api/v1/sms/quick-replies/{id}/use — bumps use_count + last_used_at
 * after a persisted send whose body came from that saved reply, so the picker
 * can rank most-used first. A counter, not a send: safe to retry.
 */
export function recordSmsQuickReplyUse(
  id: string,
  signal?: AbortSignal,
): Promise<SmsQuickReplyUseReceipt> {
  if (!SMS_UUID_V4.test(id)) {
    throw new Error("SMS quick reply use requires a canonical UUIDv4");
  }
  return api
    .post<unknown>(
      `/api/v1/sms/quick-replies/${encodeURIComponent(id)}/use`,
      undefined,
      { requireOnline: true, ...(signal ? { signal } : {}) },
    )
    .then((raw) => {
      const label = "SMS quick reply use";
      const record = smsReplyRecord(raw, label);
      const useCount = record.useCount;
      if (
        record.ok !== true ||
        record.id !== id ||
        typeof useCount !== "number" ||
        !Number.isSafeInteger(useCount) ||
        useCount < 1
      ) {
        throw new Error(`${label} returned an invalid receipt`);
      }
      return {
        ok: true,
        tenantId: smsReplyText(record, "tenantId", label),
        id,
        useCount,
        lastUsedAt: smsReplyText(record, "lastUsedAt", label),
      };
    });
}
