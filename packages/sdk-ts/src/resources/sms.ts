// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";
import { PostwaveError, ServerError } from "../errors.js";

export const SMS_EVIDENCE_READ_RELEASE_HELD_CODE =
  "sms_evidence_read_release_held" as const;
export const SMS_A2P_REGISTRATION_RELEASE_HELD_CODE =
  "sms_a2p_registration_release_held" as const;
export const SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE =
  "sms_registration_evidence_authority_required" as const;
export const SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE =
  "sms_campaign_dispatch_release_held" as const;
export const SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE =
  "sms_campaign_schedule_release_held" as const;
export const SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE =
  "sms_campaign_resume_release_held" as const;
export const SMS_TEST_DISPATCH_RELEASE_HELD_CODE =
  "sms_test_dispatch_release_held" as const;

function smsEvidenceReadReleaseHeld(): ServerError {
  return new ServerError({
    status: 503,
    code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
    message:
      "Confidential SMS evidence reads are release-held until the audited bounded contract is available.",
  });
}

function smsOperationReleaseHeld(code: string, operation: string): ServerError {
  return new ServerError({
    status: 503,
    code,
    message: `${operation} is release-held until its durable provider and reconciliation contract is available.`,
  });
}

function validatedSmsSenderInput(input: SmsSenderInput): SmsSenderInput {
  const raw = input as unknown as Record<string, unknown>;
  const hasPrivateEvidence =
    Object.prototype.hasOwnProperty.call(raw, "brand_registration_sid") ||
    Object.prototype.hasOwnProperty.call(raw, "campaign_registration_sid");
  const status = raw.registration_status;
  if (
    hasPrivateEvidence ||
    (status !== undefined &&
      status !== "" &&
      status !== "not_started" &&
      status !== "draft")
  ) {
    throw new PostwaveError(
      "Caller-supplied SMS registration evidence and provider-certified status are unavailable.",
      {
        status: 409,
        code: SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE,
      },
    );
  }
  return input;
}

function validatedSmsCampaignDraftInput(
  input: SmsCampaignInput,
): SmsCampaignInput {
  const raw = input as unknown as Record<string, unknown>;
  if (
    raw.status === "scheduled" ||
    Object.prototype.hasOwnProperty.call(raw, "scheduled_at")
  ) {
    throw smsOperationReleaseHeld(
      SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
      "SMS campaign scheduling",
    );
  }
  return input;
}

const SMS_CONSENT_KEYS = new Set([
  "action",
  "list_id",
  "phone_e164",
  "proof_text",
  "source",
]);
const SMS_NANP_E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const SMS_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SMS_CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SMS_CURSOR_UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SMS_RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const SMS_SUPPRESSION_CURSOR = /^v1\.[A-Za-z0-9_-]+$/u;

export const SMS_SUPPRESSION_REASONS = [
  "manual",
  "stop_keyword",
  "help_keyword",
  "carrier_block",
  "complaint",
  "quiet_hours",
  "expired",
] as const;
export const SMS_SUPPRESSION_SOURCES = [
  "twilio",
  "telnyx",
  "bandwidth",
  "manual",
  "api",
  "import",
] as const;
export const SMS_SUPPRESSION_LOCKED_REASON =
  "carrier_or_system_authority" as const;

export type SmsSuppressionReason = (typeof SMS_SUPPRESSION_REASONS)[number];
export type SmsSuppressionSource = (typeof SMS_SUPPRESSION_SOURCES)[number];

export interface SmsSuppressionRow {
  id: string;
  phone_e164: string;
  reason: SmsSuppressionReason;
  source: SmsSuppressionSource;
  created_at: string;
  reversible: boolean;
  locked_reason?: typeof SMS_SUPPRESSION_LOCKED_REASON;
}

export interface SmsSuppressionsPage {
  tenantId: string;
  items: SmsSuppressionRow[];
  total: number;
  snapshotAt: string;
  nextCursor?: string;
}

export interface SmsSuppressionListOptions {
  /** Optional exact response binding. Tenant UUIDs are canonical, not v4-only. */
  tenantId?: string;
  reason?: SmsSuppressionReason;
  /** Exact canonical US/Canada E.164 identity; no prefix/substring search. */
  phone?: string;
  cursor?: string;
  limit?: number;
}

export interface SmsSuppressionAddInput {
  phone: string;
  reason: "manual";
}

export interface SmsSuppressionDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

function smsSuppressionContractError(message: string): PostwaveError {
  return new PostwaveError(message, {
    status: 502,
    code: "invalid_sms_suppression_response",
  });
}

function strictSmsText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value ||
    SMS_CURSOR_UNSAFE.test(value)
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  return value;
}

function strictSmsTimestamp(value: unknown): string {
  const text = strictSmsText(value, 64);
  const parts = SMS_RFC3339.exec(text);
  const parsed = Date.parse(text);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 14 ||
    (Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0) ||
    Number(parts[9] ?? 0) > 59
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  return text;
}

function smsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  return value as Record<string, unknown>;
}

function exactSmsKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
}

function decodeSmsSuppressionRow(value: unknown): SmsSuppressionRow {
  const row = smsObject(value);
  exactSmsKeys(row, [
    "id",
    "phone_e164",
    "reason",
    "source",
    "created_at",
    "reversible",
    "locked_reason",
  ]);
  const id = strictSmsText(row.id, 36);
  const phone = strictSmsText(row.phone_e164, 16);
  const reason = strictSmsText(row.reason, 128);
  const source = strictSmsText(row.source, 128);
  const createdAt = strictSmsTimestamp(row.created_at);
  const lockedReason =
    row.locked_reason === undefined
      ? undefined
      : strictSmsText(row.locked_reason, 256);
  const reversible = row.reversible;
  if (
    !SMS_UUID_V4.test(id) ||
    !SMS_NANP_E164.test(phone) ||
    !SMS_SUPPRESSION_REASONS.includes(reason as SmsSuppressionReason) ||
    !SMS_SUPPRESSION_SOURCES.includes(source as SmsSuppressionSource) ||
    typeof reversible !== "boolean" ||
    reversible !== (reason === "manual" && source === "manual") ||
    (reversible && lockedReason !== undefined) ||
    (!reversible && lockedReason !== SMS_SUPPRESSION_LOCKED_REASON)
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  return {
    id,
    phone_e164: phone,
    reason: reason as SmsSuppressionReason,
    source: source as SmsSuppressionSource,
    created_at: createdAt,
    reversible,
    ...(lockedReason
      ? { locked_reason: SMS_SUPPRESSION_LOCKED_REASON }
      : {}),
  };
}

export function decodeSmsSuppressionsPage(
  value: unknown,
  expectedTenantId: string,
  expectedLimit = 100,
  expectedReason?: SmsSuppressionReason,
  expectedPhone?: string,
): SmsSuppressionsPage {
  const envelope = smsObject(value);
  if (
    (expectedReason !== undefined &&
      !SMS_SUPPRESSION_REASONS.includes(expectedReason)) ||
    (expectedPhone !== undefined && !SMS_NANP_E164.test(expectedPhone))
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  exactSmsKeys(envelope, [
    "tenantId",
    "items",
    "total",
    "nextCursor",
    "snapshotAt",
  ]);
  const tenantId = strictSmsText(envelope.tenantId, 36);
  if (!SMS_CANONICAL_UUID.test(tenantId)) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  if (!SMS_CANONICAL_UUID.test(expectedTenantId) || tenantId !== expectedTenantId) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  if (
    !Number.isSafeInteger(expectedLimit) ||
    expectedLimit < 1 ||
    expectedLimit > 200 ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > expectedLimit
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  const total = envelope.total;
  if (!Number.isSafeInteger(total) || (total as number) < envelope.items.length) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  const snapshotAt = strictSmsTimestamp(envelope.snapshotAt);
  const nextCursor =
    envelope.nextCursor === undefined
      ? undefined
      : strictSmsText(envelope.nextCursor, 4096);
  if (nextCursor !== undefined && !SMS_SUPPRESSION_CURSOR.test(nextCursor)) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  const items = envelope.items.map(decodeSmsSuppressionRow);
  const ids = new Set<string>();
  const phones = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const row of items) {
    const at = Date.parse(row.created_at);
    if (
      ids.has(row.id) ||
      phones.has(row.phone_e164) ||
      (expectedReason !== undefined && row.reason !== expectedReason) ||
      (expectedPhone !== undefined && row.phone_e164 !== expectedPhone) ||
      at > Date.parse(snapshotAt) ||
      at > previousAt ||
      (at === previousAt && previousId !== "" && row.id >= previousId)
    ) {
      throw smsSuppressionContractError("Invalid SMS suppression response.");
    }
    ids.add(row.id);
    phones.add(row.phone_e164);
    previousAt = at;
    previousId = row.id;
  }
  if (
    nextCursor &&
    ((total as number) <= items.length || items.length !== expectedLimit)
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  if (
    expectedPhone !== undefined &&
    ((total as number) > 1 || nextCursor !== undefined)
  ) {
    throw smsSuppressionContractError("Invalid SMS suppression response.");
  }
  return {
    tenantId,
    items,
    total: total as number,
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function smsSuppressionListQuery(
  options: SmsSuppressionListOptions,
): Record<string, string | number> {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
  ) {
    throw new Error("SMS suppression limit must be an integer from 1 to 200");
  }
  if (options.tenantId !== undefined && !SMS_CANONICAL_UUID.test(options.tenantId)) {
    throw new Error("SMS suppression tenantId must be a canonical lowercase UUID");
  }
  if (
    options.reason !== undefined &&
    !SMS_SUPPRESSION_REASONS.includes(options.reason)
  ) {
    throw new Error("SMS suppression reason is unsupported");
  }
  if (options.phone !== undefined && !SMS_NANP_E164.test(options.phone)) {
    throw new Error("SMS suppression phone must be canonical US/Canada E.164");
  }
  if (
    options.cursor !== undefined &&
    (options.cursor.length > 4096 ||
      !SMS_SUPPRESSION_CURSOR.test(options.cursor))
  ) {
    throw new Error("SMS suppression cursor is invalid");
  }
  if (options.phone !== undefined && options.cursor !== undefined) {
    throw new Error("Exact SMS suppression lookup cannot continue a cursor");
  }
  if (options.phone !== undefined && options.limit !== undefined) {
    throw new Error("Exact SMS suppression lookup does not accept a limit");
  }
  return {
    limit: options.limit ?? 100,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.phone === undefined ? {} : { phone: options.phone }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
}

function validatedSmsSuppressionAdd(
  input: SmsSuppressionAddInput,
): SmsSuppressionAddInput {
  const raw = input as unknown as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(raw).some((key) => key !== "phone" && key !== "reason") ||
    input.reason !== "manual" ||
    !SMS_NANP_E164.test(input.phone)
  ) {
    throw new Error(
      "SMS suppression add requires an exact US/Canada E.164 phone and reason=manual",
    );
  }
  return { phone: input.phone, reason: "manual" };
}

function smsConsentError(
  status: number,
  code: string,
  message: string,
): PostwaveError {
  return new PostwaveError(message, { status, code });
}

function safeConsentReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > 500) return false;
  for (const point of Array.from(trimmed)) {
    const code = point.codePointAt(0)!;
    if ((code >= 0xd800 && code <= 0xdfff) || /[\p{Cc}\p{Cf}]/u.test(point)) {
      return false;
    }
  }
  return true;
}

function validatedSmsConsentRevocation(raw: SmsConsentInput): SmsConsentInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw smsConsentError(
      400,
      "invalid_consent_request",
      "SMS consent input must be an operator revocation object.",
    );
  }
  const input = raw as unknown as Record<string, unknown>;
  if (input.action === "granted") {
    throw smsConsentError(
      409,
      "carrier_resubscribe_authority_required",
      "Only a verified provider START or UNSTOP event may restore SMS consent.",
    );
  }
  if (input.action !== "revoked") {
    throw smsConsentError(
      400,
      "invalid_consent_action",
      "The operator SMS consent endpoint accepts only action=revoked.",
    );
  }
  if (
    input.source !== "manual" ||
    Object.keys(input).some((key) => !SMS_CONSENT_KEYS.has(key))
  ) {
    throw smsConsentError(
      400,
      "invalid_consent_request",
      "Operator SMS revocations require source=manual and no provider or subscriber evidence fields.",
    );
  }
  if (
    typeof input.phone_e164 !== "string" ||
    !SMS_NANP_E164.test(input.phone_e164)
  ) {
    throw smsConsentError(
      400,
      "invalid_phone",
      "phone_e164 must be a canonical US/Canada number.",
    );
  }
  if (!safeConsentReason(input.proof_text)) {
    throw smsConsentError(
      400,
      "consent_reason_required",
      "proof_text must contain a safe operator revocation reason of at most 500 Unicode code points.",
    );
  }
  if (
    input.list_id !== undefined &&
    (typeof input.list_id !== "string" || !SMS_UUID_V4.test(input.list_id))
  ) {
    throw smsConsentError(
      400,
      "invalid_list_id",
      "list_id must be a canonical lowercase UUIDv4.",
    );
  }
  return {
    ...(typeof input.list_id === "string" ? { list_id: input.list_id } : {}),
    phone_e164: input.phone_e164,
    action: "revoked",
    source: "manual",
    proof_text: input.proof_text.trim(),
  };
}

export type SmsProvider = "twilio" | "telnyx" | "bandwidth";
export type SmsCountry = "US" | "CA";
export type SmsSenderType = "10dlc" | "toll_free" | "short_code";
export type SmsRegistrationStatus =
  | "not_started"
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "suspended";

export interface SmsSenderProfile {
  id: string;
  provider: SmsProvider;
  country: SmsCountry;
  sender_type: SmsSenderType;
  phone_number?: string;
  messaging_service_sid?: string;
  brand_registration_sid?: string;
  campaign_registration_sid?: string;
  registration_status: SmsRegistrationStatus;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SmsSenderInput {
  provider?: SmsProvider;
  country?: SmsCountry;
  sender_type?: SmsSenderType;
  phone_number?: string;
  messaging_service_sid?: string;
  brand_registration_sid?: string;
  campaign_registration_sid?: string;
  registration_status?: SmsRegistrationStatus;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SmsList {
  id: string;
  name: string;
  description: string;
  keyword?: string;
  sender_profile_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SmsListInput {
  name: string;
  description?: string;
  keyword?: string;
  sender_profile_id?: string;
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

export interface SmsA2PBrandRegistrationInput {
  customer_profile_bundle_sid?: string;
  a2p_profile_bundle_sid?: string;
  brand_type?: string;
  skip_automatic_sec_vet?: boolean;
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

export interface SmsA2PCampaignRegistrationInput {
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

export interface SmsA2PRegistrationResult {
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
  campaign_id?: string;
  metadata?: Record<string, unknown>;
}

export interface SmsGateDecision {
  allowed: boolean;
  reason?: string;
  segments: number;
}

export interface SmsMessage {
  id: string;
  campaign_id?: string;
  sender_profile_id?: string;
  phone_e164: string;
  provider: string;
  provider_message_id?: string;
  direction: "outbound" | "inbound";
  body: string;
  media_url?: string;
  segments: number;
  status: string;
  error_code?: string;
  error_message?: string;
  cost_micros: number;
  metadata?: Record<string, unknown>;
  sent_at?: string;
  delivered_at?: string;
  received_at?: string;
  created_at: string;
}

export class SmsResource extends Resource {
  setup(): Promise<SmsSetupStatus> {
    return this.client.request("GET", "/api/v1/sms/setup");
  }

  compliance(): Promise<SmsComplianceStatus> {
    return this.client.request("GET", "/api/v1/sms/compliance");
  }

  pilotReadiness(): Promise<SmsPilotReadiness> {
    return this.client.request("GET", "/api/v1/sms/pilot-readiness");
  }

  senderPilotCertification(
    senderId: string,
  ): Promise<SmsSenderPilotCertification> {
    return this.client.request(
      "GET",
      `/api/v1/sms/senders/${encodeURIComponent(senderId)}/pilot-certification`,
    );
  }

  listLists(): Promise<{ items: SmsList[] }> {
    return this.client.request("GET", "/api/v1/sms/lists");
  }

  createList(input: SmsListInput): Promise<SmsList> {
    return this.client.request("POST", "/api/v1/sms/lists", { body: input });
  }

  listSenders(): Promise<{ items: SmsSenderProfile[] }> {
    return this.client.request("GET", "/api/v1/sms/senders");
  }

  upsertSender(input: SmsSenderInput): Promise<SmsSenderProfile> {
    try {
      return this.client.request("POST", "/api/v1/sms/senders", {
        body: validatedSmsSenderInput(input),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  pauseSender(senderId: string, reason?: string): Promise<SmsSenderProfile> {
    return this.client.request(
      "POST",
      `/api/v1/sms/senders/${encodeURIComponent(senderId)}/pause`,
      { body: { reason } },
    );
  }

  resumeSender(senderId: string): Promise<SmsSenderProfile> {
    return this.client.request(
      "POST",
      `/api/v1/sms/senders/${encodeURIComponent(senderId)}/resume`,
      { body: {} },
    );
  }

  submitBrandRegistration(
    senderId: string,
    input: SmsA2PBrandRegistrationInput,
  ): Promise<SmsA2PRegistrationResult> {
    void senderId;
    void input;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
        "SMS A2P registration",
      ),
    );
  }

  submitCampaignRegistration(
    senderId: string,
    input: SmsA2PCampaignRegistrationInput,
  ): Promise<SmsA2PRegistrationResult> {
    void senderId;
    void input;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
        "SMS A2P registration",
      ),
    );
  }

  pollA2PRegistration(senderId: string): Promise<SmsA2PRegistrationResult> {
    void senderId;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
        "SMS A2P registration",
      ),
    );
  }

  recordConsent(input: SmsConsentInput): Promise<SmsConsentRevocationReceipt> {
    try {
      return this.client.request("POST", "/api/v1/sms/consent", {
        body: validatedSmsConsentRevocation(input),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Read one response-cutoff-bound page of the exact-admin SMS suppression
   * roster. `nextCursor` is opaque: pass it back explicitly to continue; this
   * method never claims or silently fetches complete history.
   */
  async listSuppressions(
    options: SmsSuppressionListOptions = {},
  ): Promise<SmsSuppressionsPage> {
    const expectedTenantId =
      options.tenantId ??
      (this.client.tenantId && SMS_CANONICAL_UUID.test(this.client.tenantId)
        ? this.client.tenantId
        : undefined);
    if (!expectedTenantId) {
      throw new Error(
        "SMS suppression listing requires an expected canonical tenant UUID",
      );
    }
    const query = smsSuppressionListQuery(options);
    const raw = await this.client.request<unknown>(
      options.phone ? "POST" : "GET",
      options.phone
        ? "/api/v1/sms/suppressions/query"
        : "/api/v1/sms/suppressions",
      options.phone
        ? {
            body: {
              phone: options.phone,
              ...(options.reason === undefined
                ? {}
                : { reason: options.reason }),
            },
            idempotencyKey: null,
          }
        : { query },
    );
    return decodeSmsSuppressionsPage(
      raw,
      expectedTenantId,
      options.phone ? 1 : (options.limit ?? 100),
      options.reason,
      options.phone,
    );
  }

  /** Add or reassert only a reversible manual workspace hold. */
  async addSuppression(
    input: SmsSuppressionAddInput,
  ): Promise<SmsSuppressionRow> {
    const raw = await this.client.request<unknown>(
      "POST",
      "/api/v1/sms/suppressions",
      { body: validatedSmsSuppressionAdd(input) },
    );
    const row = decodeSmsSuppressionRow(raw);
    if (
      row.phone_e164 !== input.phone ||
      row.reason !== "manual" ||
      row.source !== "manual" ||
      row.reversible !== true
    ) {
      throw smsSuppressionContractError(
        "SMS suppression creation receipt did not match the requested manual hold.",
      );
    }
    return row;
  }

  /** Remove only an exact reversible manual/manual hold by canonical UUIDv4. */
  async removeSuppression(
    id: string,
    expectedTenantId?: string,
  ): Promise<SmsSuppressionDeleteReceipt> {
    if (!SMS_UUID_V4.test(id)) {
      throw new Error(
        "SMS suppression id must be a canonical lowercase UUIDv4",
      );
    }
    const expectedTenant =
      expectedTenantId ??
      (this.client.tenantId && SMS_CANONICAL_UUID.test(this.client.tenantId)
        ? this.client.tenantId
        : undefined);
    if (
      expectedTenantId !== undefined &&
      !SMS_CANONICAL_UUID.test(expectedTenantId)
    ) {
      throw new Error(
        "SMS suppression tenant id must be a canonical lowercase UUID",
      );
    }
    if (!expectedTenant) {
      throw new Error(
        "SMS suppression removal requires an expected canonical tenant UUID",
      );
    }
    const raw = smsObject(
      await this.client.request<unknown>(
        "DELETE",
        `/api/v1/sms/suppressions/${id}`,
      ),
    );
    exactSmsKeys(raw, ["ok", "tenantId", "id"]);
    const tenantId = strictSmsText(raw.tenantId, 36);
    const receiptId = strictSmsText(raw.id, 36);
    if (
      raw.ok !== true ||
      !SMS_CANONICAL_UUID.test(tenantId) ||
      receiptId !== id ||
      tenantId !== expectedTenant
    ) {
      throw smsSuppressionContractError(
        "Invalid SMS suppression removal receipt.",
      );
    }
    return { ok: true, tenantId, id: receiptId };
  }

  listCampaigns(): Promise<{ items: SmsCampaign[] }> {
    return this.client.request("GET", "/api/v1/sms/campaigns");
  }

  getCampaign(id: string): Promise<SmsCampaign> {
    return this.client.request(
      "GET",
      `/api/v1/sms/campaigns/${encodeURIComponent(id)}`,
    );
  }

  createCampaign(input: SmsCampaignInput): Promise<SmsCampaign> {
    try {
      return this.client.request("POST", "/api/v1/sms/campaigns", {
        body: validatedSmsCampaignDraftInput(input),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  campaignReport(id: string): Promise<SmsCampaignReport> {
    void id;
    return Promise.reject(smsEvidenceReadReleaseHeld());
  }

  exportCampaignReport(
    id: string,
    params: {
      status?: "all" | "blocked" | "failed" | "problems" | "undelivered";
      limit?: number;
    } = {},
  ): Promise<string> {
    void id;
    void params;
    return Promise.reject(smsEvidenceReadReleaseHeld());
  }

  sendCampaign(
    id: string,
    input: SmsBroadcastInput = {},
  ): Promise<SmsBroadcastResult> {
    void id;
    void input;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE,
        "SMS campaign dispatch",
      ),
    );
  }

  scheduleCampaign(id: string, scheduledAt: string): Promise<SmsCampaign> {
    void id;
    void scheduledAt;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
        "SMS campaign scheduling",
      ),
    );
  }

  pauseCampaign(id: string): Promise<SmsCampaign> {
    return this.client.request(
      "POST",
      `/api/v1/sms/campaigns/${encodeURIComponent(id)}/pause`,
      { body: {} },
    );
  }

  resumeCampaign(id: string): Promise<SmsCampaign> {
    void id;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE,
        "SMS campaign resume",
      ),
    );
  }

  cancelCampaign(id: string): Promise<SmsCampaign> {
    return this.client.request(
      "POST",
      `/api/v1/sms/campaigns/${encodeURIComponent(id)}/cancel`,
      { body: {} },
    );
  }

  sendTest(
    input: SmsSendInput,
  ): Promise<{ gate: SmsGateDecision; message: SmsMessage }> {
    void input;
    return Promise.reject(
      smsOperationReleaseHeld(
        SMS_TEST_DISPATCH_RELEASE_HELD_CODE,
        "SMS test dispatch",
      ),
    );
  }
}
