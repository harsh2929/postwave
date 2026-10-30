/**
 * Network boundary for the admin-only, online-only mobile SMS inbox.
 *
 * THIS FILE IS THE TRANSPORT HALF. It owns `rawRequest`, `SmsInboxError`, the
 * route strings, and the doc comments recording which mount block and which
 * auth chain each route sits behind. Every argument validator, query builder
 * and receipt decoder lives in the pure sibling `./smsInboxContracts`, which is
 * unit-tested in the node vitest environment without a transport at all. The
 * split follows `eventBus.ts` -> `eventBusStream.ts` / `eventBusConnection.ts`.
 */
import {
  decodeSmsConversationContext,
  decodeSmsConversationsPage,
  decodeSmsMessagesPage,
  decodeSmsReplyResponse,
  decodeSmsSenders,
  isSupportedSmsReplyPhone,
  type SmsConversationContext,
  type SmsConversationFilter,
  type SmsConversationSort,
  type SmsConversationStatus,
  type SmsConversationsPage,
  type SmsMessagesPage,
  type SmsReplyResponse,
  type SmsSenderProfile,
} from "@/lib/smsConversation";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";
import {
  decodeSmsConversationStateReceipt,
  decodeSmsMarkReadReceipt,
  decodeSmsSenderPaused,
  requirePhone,
  requireSmsAssignee,
  requireSmsPauseReason,
  requireSmsReadBoundary,
  requireSmsReplyBody,
  requireSmsReplyIdempotencyKey,
  requireUuid,
  smsConversationsQuery,
  smsMessagesQuery,
  smsSnoozeUntilError,
  type SmsConversationStateReceipt,
} from "./smsInboxContracts";

export type ConversationFilter = SmsConversationFilter;
export type ConversationSort = SmsConversationSort;
export type ConversationStatus = SmsConversationStatus;

// Re-exported so the module's public surface is unchanged by the split.
export {
  MAX_SMS_REPLY_CODE_POINTS,
  SMS_SNOOZE_MAX_MS,
  smsSnoozeUntilError,
  type SmsConversationStateReceipt,
} from "./smsInboxContracts";

export class SmsInboxError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "SmsInboxError";
  }
}

type CallOptions = {
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | undefined;
};

async function call(
  method: string,
  path: string,
  label: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<unknown> {
  const res = await rawRequest<unknown>(method, path, body, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  });
  if (res.error) throw new SmsInboxError(res.error, label);
  if (res.data == null) throw new Error(`${label} returned no data.`);
  return res.data;
}

export interface ListConversationsOptions {
  tenantId: string;
  filter?: ConversationFilter;
  sort?: ConversationSort;
  status?: ConversationStatus;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export async function listConversations(
  options: ListConversationsOptions,
): Promise<SmsConversationsPage> {
  const tenantId = requireUuid(options.tenantId, "Tenant identity");
  const { filter, sort, status, search } = smsConversationsQuery(options);
  return decodeSmsConversationsPage(
    await call(
      "GET",
      `/api/v1/sms/conversations?${search}`,
      "Loading conversations",
      undefined,
      { signal: options.signal },
    ),
    { tenantId, query: { filter, sort, status } },
  );
}

export async function listConversationMessages(input: {
  phoneE164: string;
  tenantId: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<SmsMessagesPage> {
  const phoneE164 = requirePhone(input.phoneE164);
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const search = smsMessagesQuery(input);
  const raw = await call(
    "GET",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/messages?${search}`,
    "Loading the conversation",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsMessagesPage(raw, { tenantId, phoneE164 });
}

export async function getConversationContext(input: {
  phoneE164: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsConversationContext> {
  const phoneE164 = requirePhone(input.phoneE164);
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const raw = await call(
    "GET",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/context`,
    "Loading consent and suppression",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsConversationContext(raw, { tenantId, phoneE164 });
}

export async function listSmsSenders(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsSenderProfile[]> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const raw = await call(
    "GET",
    "/api/v1/sms/senders",
    "Loading SMS senders",
    undefined,
    {
      signal: input.signal,
    },
  );
  return decodeSmsSenders(raw, tenantId);
}

/**
 * Sender pause / resume.
 *
 * `POST /api/v1/sms/senders/{id}/pause` and `.../resume` are mounted at
 * apps/api/internal/sms/handlers.go:152-153 behind `ScopeAdmin` — the same
 * object whose list at :150 this module already reads. NEITHER IS RELEASE-HELD:
 * the SMS holds are dispatch/registration/callback codes
 * (`smsLegacyDispatchReleaseReady`, `smsDispatchSagaReleaseReady`,
 * `smsA2PRegistrationReleaseReady`, …) and none of them guards `setSenderPaused`
 * (handlers.go:519-544), which goes straight to the store.
 *
 * Pausing is a STOPPING verb, which is why it belongs on a phone at all: it is
 * the one control that makes an in-progress problem smaller, and
 * `isEligibleSmsSender` already refuses to compose a reply from a paused
 * sender, so the effect is visible in this app immediately.
 *
 * The receipt is checked, not assumed — see `decodeSmsSenderPaused`.
 */
export async function setSmsSenderPaused(input: {
  senderId: string;
  tenantId: string;
  paused: boolean;
  reason?: string;
  signal?: AbortSignal;
}): Promise<{ id: string; paused: boolean }> {
  const senderId = requireUuid(input.senderId, "Sender profile");
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const label = input.paused ? "Pausing the sender" : "Resuming the sender";
  const reason = requireSmsPauseReason(input.reason);
  const raw = await call(
    "POST",
    `/api/v1/sms/senders/${encodeURIComponent(senderId)}/${
      input.paused ? "pause" : "resume"
    }`,
    label,
    reason ? { reason } : {},
    { signal: input.signal },
  );
  return decodeSmsSenderPaused(raw, {
    senderId,
    tenantId,
    paused: input.paused,
    label,
  });
}

/**
 * Conversation lifecycle: snooze / unsnooze / archive / unarchive / assign.
 *
 * Every route is mounted in `MountInboxExtraRoutes`
 * (apps/api/internal/sms/inbox_extras.go:54-58) behind the SAME
 * `protectSMSInboxResponse` + `RequireExactTenantAdmin` chain this module
 * already passes for `GET /api/v1/sms/conversations` — so an operator who can
 * SEE the Snoozed and Archived filters can also move a row into them. None of
 * these is release-held: the SMS holds cover dispatch, A2P registration and
 * provider callbacks, and `upsertConversationState`
 * (inbox_extras.go:156-249) carries no readiness guard.
 *
 * The receipt is `{ok, tenantId, phoneE164}` and is checked against the
 * conversation that was asked for by `decodeSmsConversationStateReceipt`.
 */
async function conversationStateCall(input: {
  phoneE164: string;
  tenantId: string;
  action: "unsnooze" | "archive" | "unarchive";
  label: string;
  signal?: AbortSignal | undefined;
}): Promise<SmsConversationStateReceipt> {
  const phoneE164 = requirePhone(input.phoneE164);
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  // These three take `AllowEmptyBody` (inbox_extras.go:100-118), so no body is
  // sent at all rather than an empty object the strict decoder would have to
  // media-type check.
  const raw = await call(
    "POST",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/${input.action}`,
    input.label,
    undefined,
    { signal: input.signal },
  );
  return decodeSmsConversationStateReceipt(
    raw,
    { tenantId, phoneE164 },
    input.label,
  );
}

export async function snoozeConversation(input: {
  phoneE164: string;
  tenantId: string;
  until: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateReceipt> {
  const phoneE164 = requirePhone(input.phoneE164);
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const invalid = smsSnoozeUntilError(input.until);
  if (invalid) throw new Error(invalid);
  const label = "Snoozing the conversation";
  const raw = await call(
    "POST",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/snooze`,
    label,
    { until: new Date(Date.parse(input.until)).toISOString() },
    { signal: input.signal },
  );
  return decodeSmsConversationStateReceipt(raw, { tenantId, phoneE164 }, label);
}

export async function unsnoozeConversation(input: {
  phoneE164: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateReceipt> {
  return conversationStateCall({
    ...input,
    action: "unsnooze",
    label: "Waking the conversation",
  });
}

export async function archiveConversation(input: {
  phoneE164: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateReceipt> {
  return conversationStateCall({
    ...input,
    action: "archive",
    label: "Archiving the conversation",
  });
}

export async function unarchiveConversation(input: {
  phoneE164: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsConversationStateReceipt> {
  return conversationStateCall({
    ...input,
    action: "unarchive",
    label: "Restoring the conversation",
  });
}

/** `userId: null` (or "") unassigns — see `requireSmsAssignee`. */
export async function assignConversation(input: {
  phoneE164: string;
  tenantId: string;
  userId: string | null;
  signal?: AbortSignal;
}): Promise<SmsConversationStateReceipt> {
  const phoneE164 = requirePhone(input.phoneE164);
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const userId = requireSmsAssignee(input.userId);
  const label = userId
    ? "Assigning the conversation"
    : "Unassigning the conversation";
  const raw = await call(
    "POST",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/assign`,
    label,
    { userId },
    { signal: input.signal },
  );
  return decodeSmsConversationStateReceipt(raw, { tenantId, phoneE164 }, label);
}

export async function replyToConversation(input: {
  phoneE164: string;
  tenantId: string;
  senderProfileId: string;
  listId: string;
  body: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SmsReplyResponse> {
  const phoneE164 = requirePhone(input.phoneE164);
  if (!isSupportedSmsReplyPhone(phoneE164)) {
    throw new Error(
      "SMS replies are currently limited to US and Canada (+1) numbers.",
    );
  }
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const senderProfileId = requireUuid(input.senderProfileId, "Sender profile");
  const listId = requireUuid(input.listId, "Opted-in SMS list");
  const body = requireSmsReplyBody(input.body);
  const idempotencyKey = requireSmsReplyIdempotencyKey(input.idempotencyKey);
  const raw = await call(
    "POST",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/reply`,
    "Sending the reply",
    { sender_profile_id: senderProfileId, list_id: listId, body },
    { idempotencyKey, signal: input.signal },
  );
  return decodeSmsReplyResponse(raw, { tenantId, senderProfileId });
}

export async function markConversationRead(input: {
  phoneE164: string;
  messageIds: string[];
  signal?: AbortSignal;
}): Promise<{ ok: true; applied: number }> {
  const phoneE164 = requirePhone(input.phoneE164);
  const messageIds = requireSmsReadBoundary(input.messageIds);
  const raw = await call(
    "POST",
    `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/mark-read`,
    "Marking as read",
    { message_ids: messageIds },
    { signal: input.signal },
  );
  return decodeSmsMarkReadReceipt(raw, messageIds.length);
}
