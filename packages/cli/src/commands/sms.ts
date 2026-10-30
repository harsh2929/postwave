// SPDX-License-Identifier: MIT

import type {
  SmsBroadcastInput,
  SmsCampaign,
  SmsCampaignInput,
  SmsCampaignReport,
  SmsConsentInput,
  SmsCountry,
  SmsList,
  SmsListInput,
  SmsProvider,
  SmsRegistrationStatus,
  SmsSuppressionReason,
  SmsSendInput,
  SmsSenderInput,
  SmsSenderProfile,
  SmsSenderType,
} from "@postwave/sdk";
import { createClient, type ClientOpts } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

export interface SmsOpts extends ClientOpts {
  output?: OutputFormat;
  provider?: string;
  country?: string;
  senderType?: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
  brandRegistrationSid?: string;
  campaignRegistrationSid?: string;
  registrationStatus?: string;
  capabilities?: string;
  metadata?: string;
  payload?: string;
  name?: string;
  description?: string;
  keyword?: string;
  senderProfileId?: string;
  listId?: string;
  phone?: string;
  email?: string;
  action?: string;
  source?: string;
  proofText?: string;
  providerEventId?: string;
  body?: string;
  mediaUrl?: string;
  status?: string;
  scheduledAt?: string;
  limit?: string | number;
  linkTracking?: string | boolean;
  reason?: string;
  exportStatus?: string;
  cursor?: string;
  tenantUuid?: string;
  yes?: boolean;
}

type RowValue = string | number | boolean | null | undefined;
type TableRow = Record<string, RowValue>;

export const SMS_PROVIDERS = [
  "twilio",
  "telnyx",
  "bandwidth",
] as const satisfies readonly SmsProvider[];
export const SMS_COUNTRIES = [
  "US",
  "CA",
] as const satisfies readonly SmsCountry[];
export const SMS_SENDER_TYPES = [
  "10dlc",
  "toll_free",
  "short_code",
] as const satisfies readonly SmsSenderType[];
export const SMS_REGISTRATION_STATUSES = [
  "not_started",
  "draft",
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const satisfies readonly SmsRegistrationStatus[];
export const SMS_CONSENT_ACTIONS = ["revoked"] as const;
export const SMS_CONSENT_SOURCES = ["manual"] as const;
export const SMS_SUPPRESSION_REASONS = [
  "manual",
  "stop_keyword",
  "help_keyword",
  "carrier_block",
  "complaint",
  "quiet_hours",
  "expired",
] as const satisfies readonly SmsSuppressionReason[];
export const SMS_CAMPAIGN_STATUSES = ["draft", "scheduled", "paused"] as const;
export const SMS_REPORT_EXPORT_STATUSES = [
  "all",
  "blocked",
  "failed",
  "problems",
  "undelivered",
] as const;
export const SMS_EVIDENCE_READ_RELEASE_HELD_CODE =
  "sms_evidence_read_release_held" as const;
const SMS_EVIDENCE_READ_RELEASE_HELD_MESSAGE = `${SMS_EVIDENCE_READ_RELEASE_HELD_CODE}: Confidential SMS evidence reads are release-held.`;
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

function holdSmsOperation(code: string, operation: string): void {
  console.error(`${code}: ${operation} is release-held.`);
  process.exitCode = 1;
}

export async function smsSetup(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.setup();
  printWithDefaultTable(opts.output, out, [
    {
      can_send: out.can_send,
      senders: out.senders.length,
      blocking_reasons: summarizeList(out.blocking_reasons),
    },
  ]);
}

export async function smsCompliance(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.compliance();
  printWithDefaultTable(
    opts.output,
    out,
    out.items.map((item) => ({
      key: item.key,
      label: item.label,
      complete: item.complete,
      detail: item.detail ?? "",
    })),
  );
}

export async function smsPilotReadiness(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.pilotReadiness();
  printWithDefaultTable(
    opts.output,
    out,
    out.items.map((item) => ({
      key: item.key,
      label: item.label,
      status: item.status,
      detail: item.detail ?? "",
    })),
  );
}

export async function smsSenderPilotCertification(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  const id = normalizeSmsId(senderId, "sender id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.sms.senderPilotCertification(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsSendersList(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.listSenders();
  printWithDefaultTable(opts.output, out, compactSenderRows(out.items));
}

export async function smsSenderUpsert(opts: SmsOpts = {}): Promise<void> {
  let input: SmsSenderInput;
  try {
    input = senderInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.sms.upsertSender(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsSenderPause(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  const id = normalizeSmsId(senderId, "sender id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.sms.pauseSender(
    id,
    optionalTrimmed(opts.reason) || undefined,
  );
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsSenderResume(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  const id = normalizeSmsId(senderId, "sender id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.sms.resumeSender(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsA2PBrandSubmit(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void senderId;
  void opts;
  holdSmsOperation(
    SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
    "SMS A2P registration",
  );
}

export async function smsA2PCampaignSubmit(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void senderId;
  void opts;
  holdSmsOperation(
    SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
    "SMS A2P registration",
  );
}

export async function smsA2PPoll(
  senderId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void senderId;
  void opts;
  holdSmsOperation(
    SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
    "SMS A2P registration",
  );
}

export async function smsListsList(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.listLists();
  printWithDefaultTable(opts.output, out, compactListRows(out.items));
}

export async function smsListsCreate(opts: SmsOpts = {}): Promise<void> {
  let input: SmsListInput;
  try {
    input = listInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.sms.createList(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsConsentRecord(opts: SmsOpts = {}): Promise<void> {
  let input: SmsConsentInput;
  try {
    input = consentInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.sms.recordConsent(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

/** One exact-admin response-cutoff page; nextCursor remains explicit. */
export async function smsSuppressionsList(opts: SmsOpts = {}): Promise<void> {
  const limit = opts.limit === undefined ? 100 : Number(opts.limit);
  const reasonSupplied = opts.reason !== undefined;
  const reason = optionalTrimmed(opts.reason);
  const phoneSupplied = opts.phone !== undefined;
  const phone = typeof opts.phone === "string" ? opts.phone : undefined;
  const cursorSupplied = opts.cursor !== undefined;
  const cursor = typeof opts.cursor === "string" ? opts.cursor : undefined;
  const tenantId =
    typeof opts.tenantUuid === "string" ? opts.tenantUuid : undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    printCommandError(new Error("--limit must be an integer from 1 to 200"));
    return;
  }
  if (
    reasonSupplied &&
    (!reason ||
      !SMS_SUPPRESSION_REASONS.includes(reason as SmsSuppressionReason))
  ) {
    printCommandError(
      new Error("--reason is not a supported suppression reason"),
    );
    return;
  }
  if (
    phoneSupplied &&
    (!phone || !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone))
  ) {
    printCommandError(
      new Error("--phone must be exact canonical US/Canada E.164"),
    );
    return;
  }
  if (cursorSupplied && (!cursor || !/^v1\.[A-Za-z0-9_-]+$/u.test(cursor))) {
    printCommandError(new Error("--cursor is invalid"));
    return;
  }
  if (phoneSupplied && cursorSupplied) {
    printCommandError(
      new Error("Exact --phone lookup cannot continue a --cursor"),
    );
    return;
  }
  if (phoneSupplied && opts.limit !== undefined) {
    printCommandError(
      new Error("Exact --phone lookup does not accept --limit"),
    );
    return;
  }
  if (
    tenantId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      tenantId,
    )
  ) {
    printCommandError(new Error("--tenant-uuid must be a canonical UUID"));
    return;
  }
  const client = createClient(opts);
  const out = await client.sms.listSuppressions({
    ...(!phoneSupplied ? { limit } : {}),
    ...(reason ? { reason: reason as SmsSuppressionReason } : {}),
    ...(phoneSupplied ? { phone: phone! } : {}),
    ...(cursor ? { cursor } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
  // JSON is the safe default: a rows-only table would discard nextCursor,
  // tenant binding, total, and response cutoff.
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsSuppressionAdd(opts: SmsOpts = {}): Promise<void> {
  const phone = typeof opts.phone === "string" ? opts.phone : undefined;
  if (!phone || !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
    printCommandError(
      new Error("--phone must be exact canonical US/Canada E.164"),
    );
    return;
  }
  const client = createClient(opts);
  const receipt = await client.sms.addSuppression({ phone, reason: "manual" });
  console.log(formatOutput(receipt, opts.output ?? "json"));
}

export async function smsSuppressionRemove(
  id: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  if (!opts.yes) {
    printCommandError(
      new Error(
        "Pass --yes to remove a manual hold; removal does not restore consent.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const tenantId =
    typeof opts.tenantUuid === "string" ? opts.tenantUuid : undefined;
  if (
    !tenantId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      tenantId,
    )
  ) {
    printCommandError(
      new Error(
        "--tenant-uuid is required to bind the destructive removal receipt",
      ),
    );
    return;
  }
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      id,
    )
  ) {
    printCommandError(new Error("suppression id must be a canonical UUIDv4"));
    return;
  }
  const client = createClient(opts);
  const receipt = await client.sms.removeSuppression(id, tenantId);
  console.log(formatOutput(receipt, opts.output ?? "json"));
}

export async function smsCampaignsList(opts: SmsOpts = {}): Promise<void> {
  const client = createClient(opts);
  const out = await client.sms.listCampaigns();
  printWithDefaultTable(opts.output, out, compactCampaignRows(out.items));
}

export async function smsCampaignsGet(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  const id = normalizeSmsId(campaignId, "SMS campaign id");
  if (!id) return;

  const client = createClient(opts);
  const out = await client.sms.getCampaign(id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsCampaignsCreate(opts: SmsOpts = {}): Promise<void> {
  let input: SmsCampaignInput;
  try {
    input = campaignInputFromOptions(opts);
  } catch (err) {
    printCommandError(err);
    return;
  }

  const client = createClient(opts);
  const out = await client.sms.createCampaign(input);
  console.log(formatOutput(out, opts.output ?? "json"));
}

export async function smsCampaignReport(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void campaignId;
  void opts;
  console.error(SMS_EVIDENCE_READ_RELEASE_HELD_MESSAGE);
  process.exitCode = 1;
}

export async function smsCampaignReportExport(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void campaignId;
  void opts;
  console.error(SMS_EVIDENCE_READ_RELEASE_HELD_MESSAGE);
  process.exitCode = 1;
}

export async function smsCampaignSend(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void campaignId;
  void opts;
  holdSmsOperation(
    SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE,
    "SMS campaign dispatch",
  );
}

export async function smsCampaignSchedule(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void campaignId;
  void opts;
  holdSmsOperation(
    SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
    "SMS campaign scheduling",
  );
}

export async function smsCampaignPause(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  await runCampaignAction(campaignId, opts, (client, id) =>
    client.sms.pauseCampaign(id),
  );
}

export async function smsCampaignResume(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  void campaignId;
  void opts;
  holdSmsOperation(
    SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE,
    "SMS campaign resume",
  );
}

export async function smsCampaignCancel(
  campaignId: string | undefined,
  opts: SmsOpts = {},
): Promise<void> {
  await runCampaignAction(campaignId, opts, (client, id) =>
    client.sms.cancelCampaign(id),
  );
}

export async function smsTestSend(opts: SmsOpts = {}): Promise<void> {
  void opts;
  holdSmsOperation(SMS_TEST_DISPATCH_RELEASE_HELD_CODE, "SMS test dispatch");
}

export function senderInputFromOptions(opts: SmsOpts): SmsSenderInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: SmsSenderInput = payload ? { ...payload } : {};
  const provider = optionalEnum(opts.provider, SMS_PROVIDERS, "--provider");
  if (provider) input.provider = provider;
  const country = optionalEnum(
    opts.country,
    SMS_COUNTRIES,
    "--country",
    (value) => value.toUpperCase(),
  );
  if (country) input.country = country;
  const senderType = optionalEnum(
    opts.senderType,
    SMS_SENDER_TYPES,
    "--sender-type",
  );
  if (senderType) input.sender_type = senderType;
  const phoneNumber = optionalTrimmed(opts.phoneNumber);
  if (phoneNumber) input.phone_number = phoneNumber;
  const messagingServiceSid = optionalTrimmed(opts.messagingServiceSid);
  if (messagingServiceSid) input.messaging_service_sid = messagingServiceSid;
  const brandRegistrationSid = optionalTrimmed(opts.brandRegistrationSid);
  if (brandRegistrationSid) input.brand_registration_sid = brandRegistrationSid;
  const campaignRegistrationSid = optionalTrimmed(opts.campaignRegistrationSid);
  if (campaignRegistrationSid)
    input.campaign_registration_sid = campaignRegistrationSid;
  const registrationStatus = optionalEnum(
    opts.registrationStatus,
    SMS_REGISTRATION_STATUSES,
    "--registration-status",
  );
  if (registrationStatus) input.registration_status = registrationStatus;
  const capabilities = parseJsonObjectOption(
    opts.capabilities,
    "--capabilities",
  );
  if (capabilities) input.capabilities = capabilities;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  const raw = input as unknown as Record<string, unknown>;
  const registrationStatusValue = raw.registration_status;
  if (
    Object.prototype.hasOwnProperty.call(raw, "brand_registration_sid") ||
    Object.prototype.hasOwnProperty.call(raw, "campaign_registration_sid") ||
    (registrationStatusValue !== undefined &&
      registrationStatusValue !== "" &&
      registrationStatusValue !== "not_started" &&
      registrationStatusValue !== "draft")
  ) {
    throw new Error(
      `${SMS_REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE}: caller-supplied A2P IDs and provider-certified registration status are unavailable.`,
    );
  }
  if (Object.keys(input).length === 0) {
    throw new Error(
      "Pass --payload or at least one sender field for SMS sender upsert.",
    );
  }
  return input;
}

export function listInputFromOptions(opts: SmsOpts): SmsListInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<SmsListInput> = payload ? { ...payload } : {};
  const name = optionalTrimmed(opts.name);
  if (name) input.name = name;
  const description = optionalTrimmed(opts.description);
  if (description) input.description = description;
  const keyword = optionalTrimmed(opts.keyword);
  if (keyword) input.keyword = keyword;
  const senderProfileId = optionalTrimmed(opts.senderProfileId);
  if (senderProfileId) input.sender_profile_id = senderProfileId;
  if (!input.name) throw new Error("Pass --name for SMS list create.");
  return input as SmsListInput;
}

export function consentInputFromOptions(opts: SmsOpts): SmsConsentInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Record<string, unknown> = payload ? { ...payload } : {};
  const listId = optionalTrimmed(opts.listId);
  if (listId) input.list_id = listId;
  const phone = optionalTrimmed(opts.phone);
  if (phone) input.phone_e164 = phone;
  const action = optionalEnum(opts.action, SMS_CONSENT_ACTIONS, "--action");
  if (action) input.action = action;
  const source = optionalEnum(opts.source, SMS_CONSENT_SOURCES, "--source");
  if (source) input.source = source;
  const proofText = optionalTrimmed(opts.proofText);
  if (proofText) input.proof_text = proofText;
  const allowed = new Set([
    "action",
    "list_id",
    "phone_e164",
    "proof_text",
    "source",
  ]);
  if (
    optionalTrimmed(opts.email) ||
    optionalTrimmed(opts.providerEventId) ||
    optionalTrimmed(opts.provider) ||
    opts.metadata !== undefined ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    throw new Error(
      "SMS consent record accepts only operator revocation fields; provider, subscriber, and metadata evidence is unavailable.",
    );
  }
  if (
    typeof input.phone_e164 !== "string" ||
    !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(input.phone_e164)
  ) {
    throw new Error("Pass --phone for SMS consent record.");
  }
  if (input.action !== "revoked") {
    throw new Error("Pass --action revoked for operator SMS consent record.");
  }
  if (input.source !== "manual") {
    throw new Error("Pass --source manual for operator SMS consent record.");
  }
  if (
    typeof input.proof_text !== "string" ||
    input.proof_text.trim() === "" ||
    Array.from(input.proof_text.trim()).length > 500 ||
    /[\p{Cc}\p{Cf}]/u.test(input.proof_text.trim())
  ) {
    throw new Error(
      "Pass --proof-text with a safe operator revocation reason of at most 500 Unicode code points.",
    );
  }
  if (
    input.list_id !== undefined &&
    (typeof input.list_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        input.list_id,
      ))
  ) {
    throw new Error("Pass --list-id as a canonical lowercase UUIDv4.");
  }
  return {
    ...(typeof input.list_id === "string" ? { list_id: input.list_id } : {}),
    phone_e164: input.phone_e164,
    action: "revoked",
    source: "manual",
    proof_text: input.proof_text.trim(),
  };
}

export function campaignInputFromOptions(opts: SmsOpts): SmsCampaignInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<SmsCampaignInput> = payload ? { ...payload } : {};
  const senderProfileId = optionalTrimmed(opts.senderProfileId);
  if (senderProfileId) input.sender_profile_id = senderProfileId;
  const listId = optionalTrimmed(opts.listId);
  if (listId) input.list_id = listId;
  const name = optionalTrimmed(opts.name);
  if (name) input.name = name;
  const body = optionalTrimmed(opts.body);
  if (body) input.body = body;
  const mediaUrl = optionalTrimmed(opts.mediaUrl);
  if (mediaUrl) input.media_url = mediaUrl;
  const status = optionalEnum(opts.status, SMS_CAMPAIGN_STATUSES, "--status");
  if (status) input.status = status;
  const scheduledAt = optionalTrimmed(opts.scheduledAt);
  if (scheduledAt) input.scheduled_at = scheduledAt;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  if (input.status === "scheduled" || input.scheduled_at !== undefined) {
    throw new Error(
      `${SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE}: SMS campaign scheduling is unavailable. Create a draft without scheduled_at.`,
    );
  }
  if (!input.name) throw new Error("Pass --name for SMS campaign create.");
  if (!input.body) throw new Error("Pass --body for SMS campaign create.");
  return input as SmsCampaignInput;
}

export function broadcastInputFromOptions(opts: SmsOpts): SmsBroadcastInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: SmsBroadcastInput = payload ? { ...payload } : {};
  const limit = positiveIntegerOption(opts.limit, "--limit", 1, 1000000);
  if (limit !== undefined) input.limit = limit;
  const linkTracking = optionalBooleanOption(
    opts.linkTracking,
    "--link-tracking",
  );
  if (linkTracking !== undefined) input.link_tracking = linkTracking;
  return input;
}

export function testSendInputFromOptions(opts: SmsOpts): SmsSendInput {
  const payload = parseJsonObjectOption(opts.payload, "--payload");
  const input: Partial<SmsSendInput> = payload ? { ...payload } : {};
  const senderProfileId = optionalTrimmed(opts.senderProfileId);
  if (senderProfileId) input.sender_profile_id = senderProfileId;
  const listId = optionalTrimmed(opts.listId);
  if (listId) input.list_id = listId;
  const phone = optionalTrimmed(opts.phone);
  if (phone) input.to = phone;
  const body = optionalTrimmed(opts.body);
  if (body) input.body = body;
  const mediaUrl = optionalTrimmed(opts.mediaUrl);
  if (mediaUrl) input.media_url = mediaUrl;
  const metadata = parseJsonObjectOption(opts.metadata, "--metadata");
  if (metadata) input.metadata = metadata;
  if (!input.sender_profile_id)
    throw new Error("Pass --sender-profile-id for SMS test-send.");
  if (!input.list_id) throw new Error("Pass --list-id for SMS test-send.");
  if (!input.to) throw new Error("Pass --phone for SMS test-send.");
  if (!input.body) throw new Error("Pass --body for SMS test-send.");
  return input as SmsSendInput;
}

export function compactSenderRows(items: SmsSenderProfile[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    provider: item.provider,
    country: item.country,
    type: item.sender_type,
    phone_number: item.phone_number ?? "",
    registration_status: item.registration_status,
    updated_at: item.updated_at,
  }));
}

export function compactListRows(items: SmsList[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    keyword: item.keyword ?? "",
    sender_profile_id: item.sender_profile_id ?? "",
    updated_at: item.updated_at,
  }));
}

export function compactCampaignRows(items: SmsCampaign[]): TableRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    list_id: item.list_id ?? "",
    sender_profile_id: item.sender_profile_id ?? "",
    scheduled_at: item.scheduled_at ?? "",
    sent_at: item.sent_at ?? "",
    updated_at: item.updated_at,
  }));
}

export function compactCampaignReportRows(
  report: SmsCampaignReport,
): TableRow[] {
  return [
    {
      campaign_id: report.campaign.id,
      status: report.campaign.status,
      recipients: report.recipients,
      queued: report.queued,
      sent: report.sent,
      delivered: report.delivered,
      failed: report.failed,
      blocked: report.blocked,
      clicks: report.clicks,
      unique_clickers: report.unique_clickers,
      cost_micros: report.cost_micros,
    },
  ];
}

async function runCampaignAction(
  campaignId: string | undefined,
  opts: SmsOpts,
  action: (
    client: ReturnType<typeof createClient>,
    id: string,
  ) => Promise<unknown>,
): Promise<void> {
  const id = normalizeSmsId(campaignId, "SMS campaign id");
  if (!id) return;

  const client = createClient(opts);
  const out = await action(client, id);
  console.log(formatOutput(out, opts.output ?? "json"));
}

function normalizeSmsId(
  value: string | undefined,
  label: string,
): string | null {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    console.error(`Pass a ${label}.`);
    process.exitCode = 1;
    return null;
  }
  const valid = trimmed
    .split("/")
    .every((segment) => /^[a-z0-9][a-z0-9._:-]*$/i.test(segment));
  if (!valid) {
    console.error(
      `Pass a valid ${label} using slash-separated letters, numbers, dots, colons, dashes, or underscores.`,
    );
    process.exitCode = 1;
    return null;
  }
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function parseJsonObjectOption(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function optionalEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
  normalize: (value: string) => string = (item) => item.toLowerCase(),
): T | undefined {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) return undefined;
  const normalized = normalize(trimmed);
  if ((allowed as readonly string[]).includes(normalized))
    return normalized as T;
  throw new Error(`Pass ${label} as one of: ${allowed.join(", ")}.`);
}

function positiveIntegerOption(
  value: string | number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Pass ${label} as an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function optionalBooleanOption(
  value: string | boolean | undefined,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`Pass ${label} as true or false.`);
}

function summarizeList(values: readonly string[], limit = 4): string {
  if (values.length <= limit) return values.join(",");
  return `${values.slice(0, limit).join(",")} +${values.length - limit}`;
}

function printWithDefaultTable(
  output: OutputFormat | undefined,
  full: unknown,
  rows: TableRow[],
): void {
  const format = output ?? "table";
  console.log(formatOutput(format === "table" ? rows : full, format));
}

function printCommandError(err: unknown): void {
  console.error((err as Error).message);
  process.exitCode = 1;
}
