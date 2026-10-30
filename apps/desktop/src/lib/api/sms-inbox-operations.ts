import type { ApiResult } from "./result";

export interface SmsInboxRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type SmsInboxRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: SmsInboxRequestOptions,
) => Promise<ApiResult<T>>;

export interface SmsInboxOperationsDependencies {
  request: SmsInboxRequester;
  getApiUrl: () => string;
  /** Active authenticated tenant; missing identity makes tenant rows invalid. */
  getTenantId: () => string | null;
}

export type SMSInboxBodyOmittedReason =
  | "body_exceeds_inbox_limit"
  | "legacy_body_unavailable";

export interface SMSConversationSummary {
  phoneE164: string;
  lastMessagePreview: string;
  lastMessagePreviewOmittedReason?: SMSInboxBodyOmittedReason;
  lastMessageAt: string;
  lastDirection: "inbound" | "outbound";
  messageCount: number;
  unreadCount: number;
  /** Earliest inbound message not covered by a read receipt at createdAtBoundary. */
  oldestUnreadAt?: string;
  /** Email of the subscriber linked by phone, if any. */
  subscriberEmail?: string;
  /** Refined SMS Inbox PR 2: lifecycle stamps from sms_conversation_state. */
  snoozeUntil?: string;
  archivedAt?: string;
  assigneeUserId?: string;
  stateUpdatedAt?: string;
  /** True when this phone maps to multiple subscriber identities. */
  identityAmbiguous: boolean;
}

export interface SMSConversationsResponse {
  tenantId: string;
  conversations: SMSConversationSummary[];
  nextCursor?: string;
  /** Database-clock message insertion cutoff; not a repeatable-read snapshot. */
  snapshotAt: string;
  /** Refined SMS Inbox PR 1: tenant-wide counts for filter chip badges.
   *  All three count the full inbox (not just the filtered page) so
   *  the badges don't change when the active chip switches. */
  unreadTotal: number;
  unknownTotal: number;
  totalConversations: number;
  /** Refined SMS Inbox PR 2: per-status totals for the lifecycle
   *  chips (Active / Snoozed / Archived). */
  activeTotal: number;
  snoozedTotal: number;
  archivedTotal: number;
}

export interface SMSMessagesResponse {
  tenantId: string;
  messages: SMSMessage[];
  nextCursor?: string;
  snapshotAt: string;
}

export interface SMSSearchResponse {
  tenantId: string;
  conversations: SMSConversationSummary[];
  nextCursor?: string;
  snapshotAt: string;
}

/** Refined SMS Inbox PR 1: filter / sort enums for the inbox list. */
export type SMSConversationFilter = "all" | "unread" | "unknown";
export type SMSConversationSort = "recent" | "oldest_unread";
/** Refined SMS Inbox PR 2: lifecycle status. */
export type SMSConversationStatus = "active" | "snoozed" | "archived" | "any";

/** Refined SMS Inbox PR 2: one (phone, tag) row from sms_conversation_tags. */
export interface SMSConversationTag {
  tag: string;
  createdAt: string;
}

export interface SMSConversationTagsResponse {
  tenantId: string;
  phoneE164: string;
  tags: SMSConversationTag[];
  snapshotAt: string;
  truncated: boolean;
}

export interface SMSConversationTagMutationResponse {
  ok: true;
  tenantId: string;
  phoneE164: string;
  tag: string;
  createdAt: string;
  action: "add" | "remove";
}

/** Refined SMS Inbox PR 2: one row in the activity timeline. */
export interface SMSActivityEvent {
  kind: string;
  at: string;
  title: string;
  meta?: Record<string, unknown>;
}

export interface SMSActivityResponse {
  tenantId: string;
  phoneE164: string;
  events: SMSActivityEvent[];
  snapshotAt: string;
  truncated: boolean;
  sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"];
  /** False until suppression/operator-state mutation history is included. */
  historyComplete: false;
}

/** Refined SMS Inbox PR 2: saved canned-response template. */
export interface SMSQuickReply {
  id: string;
  label: string;
  body: string;
  useCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SMSQuickRepliesResponse {
  tenantId: string;
  replies: SMSQuickReply[];
  snapshotAt: string;
  truncated: boolean;
}

export interface SMSQuickReplyMutationResponse {
  tenantId: string;
  reply: SMSQuickReply;
}

export interface SMSConversationStateMutationResponse {
  ok: true;
  tenantId: string;
  phoneE164: string;
  action: "snooze" | "unsnooze" | "archive" | "unarchive" | "assign" | "notes";
  snoozeUntil?: string;
  archivedAt?: string;
  assigneeUserId?: string;
  stateUpdatedAt: string;
}

export interface SMSConversationBulkMutationResponse {
  ok: true;
  tenantId: string;
  action: "archive" | "unarchive" | "snooze" | "unsnooze";
  applied: number;
  receipts: SMSConversationStateMutationResponse[];
}

/** Refined SMS Inbox PR 1: subscriber + lifecycle context for one phone,
 *  loaded lazily when a thread opens. Powers the context strip + the
 *  consent posture badge in the thread header. */
export interface SMSConversationContext {
  tenantId: string;
  phoneE164: string;
  subscriberEmail?: string;
  /** Roll-up across every sms_subscriptions row for this phone. */
  consentStatus: "opted_in" | "opted_out" | "pending" | "none";
  consentSource?: string;
  consentAt?: string;
  optOutAt?: string;
  /** Number of distinct lists currently opted-in. */
  subscribedLists: number;
  firstSeenAt?: string;
  totalMessages: number;
  lastReadAt?: string;
  consentMixed: boolean;
  identityAmbiguous: boolean;
  consentEvidenceSufficient: boolean;
  suppressed: boolean;
  suppressionReason?: string;
  suppressionReversible: boolean;
  hasInboundThread: boolean;
  eligibleLists: Array<{
    id: string;
    name: string;
    description: string;
    consentSource?: string;
    consentAt?: string;
  }>;
  /** Composition prerequisite only; consent remains recipient-specific. */
  replyDispatchAvailable: boolean;
  replyDispatchUnavailableReason?: string;
}

/** Narrow shape — only the fields the inbox composer needs. */
export interface SMSSender {
  id: string;
  tenant_id: string;
  phone_number?: string;
  provider?: string;
  label?: string;
  registration_status?: string;
}

export interface SMSSendersResponse {
  tenantId: string;
  items: SMSSender[];
}

export interface SMSMessage {
  id: string;
  tenant_id: string;
  campaign_id?: string;
  sender_profile_id?: string;
  phone_e164: string;
  provider: string;
  provider_message_id?: string;
  direction: "inbound" | "outbound";
  body: string;
  body_omitted_reason?: SMSInboxBodyOmittedReason;
  media_url?: string;
  segments: number;
  status: string;
  error_code?: string;
  error_message?: string;
  cost_micros: number;
  sent_at?: string;
  delivered_at?: string;
  received_at?: string;
  created_at: string;
  dispatch_state?:
    | "reserved"
    | "reconciliation_required"
    | "persisted"
    | "provider_failed";
}

export interface SMSReplyRequest {
  sender_profile_id: string;
  body: string;
  media_url?: string;
  list_id?: string;
}

export interface SMSReplyProviderReceipt {
  provider: "twilio" | "telnyx" | "bandwidth";
  providerMessageId: string;
  status: string;
}

export interface SMSReplyPersistedOutcome {
  disposition: "persisted";
  message: {
    id: string;
    tenant_id: string;
    sender_profile_id: string;
    provider: "twilio" | "telnyx" | "bandwidth";
    provider_message_id: string;
    direction: "outbound";
    segments: number;
    status: string;
    cost_micros: number;
    sent_at?: string;
    created_at: string;
  };
  providerReceipt: SMSReplyProviderReceipt;
}

export interface SMSReplyReconciliationOutcome {
  disposition: "reconciliation_required";
  code: "reply_reconciliation_required";
  intentMessageId: string;
  providerReceipt: Omit<SMSReplyProviderReceipt, "providerMessageId"> & {
    providerMessageId?: string;
  };
}

export type SMSReplyOutcome =
  | SMSReplyPersistedOutcome
  | SMSReplyReconciliationOutcome;

type UnknownRecord = Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const E164_US_CA_RE = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const CURSOR_RE = /^v1\.[A-Za-z0-9_-]+$/u;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const PROVIDERS = new Set(["twilio", "telnyx", "bandwidth"]);
const MESSAGE_STATUSES = new Set([
  "accepted",
  "scheduled",
  "queued",
  "sent",
  "delivered",
  "failed",
  "undelivered",
  "received",
  "read",
  "partially_delivered",
  "canceled",
]);
const DISPATCH_STATES = new Set([
  "reserved",
  "reconciliation_required",
  "persisted",
  "provider_failed",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isBoundedString(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !value.includes("\u0000")
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, 64) &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProvider(
  value: unknown,
): value is SMSReplyProviderReceipt["provider"] {
  return typeof value === "string" && PROVIDERS.has(value);
}

function isOptionalString(
  value: UnknownRecord,
  key: string,
  max: number,
): boolean {
  return value[key] === undefined || isBoundedString(value[key], max);
}

function isOptionalTimestamp(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || isTimestamp(value[key]);
}

function isOptionalUUID(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || isUUID(value[key]);
}

function isCursor(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 4096 && CURSOR_RE.test(value)
  );
}

function compareUTF8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index])
      return (a[index] as number) - (b[index] as number);
  }
  return a.length - b.length;
}

const SUMMARY_KEYS = new Set([
  "phoneE164",
  "lastMessagePreview",
  "lastMessagePreviewOmittedReason",
  "lastMessageAt",
  "lastDirection",
  "messageCount",
  "unreadCount",
  "oldestUnreadAt",
  "subscriberEmail",
  "snoozeUntil",
  "archivedAt",
  "assigneeUserId",
  "stateUpdatedAt",
  "identityAmbiguous",
]);

function isConversationSummary(
  value: unknown,
): value is SMSConversationSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, SUMMARY_KEYS)) return false;
  if (
    typeof value.phoneE164 !== "string" ||
    !E164_US_CA_RE.test(value.phoneE164) ||
    !isBoundedString(value.lastMessagePreview, 512, true) ||
    !isTimestamp(value.lastMessageAt) ||
    (value.lastDirection !== "inbound" && value.lastDirection !== "outbound") ||
    !isNonNegativeInteger(value.messageCount) ||
    !isNonNegativeInteger(value.unreadCount) ||
    typeof value.identityAmbiguous !== "boolean" ||
    !isOptionalTimestamp(value, "oldestUnreadAt") ||
    !isOptionalTimestamp(value, "snoozeUntil") ||
    !isOptionalTimestamp(value, "archivedAt") ||
    !isOptionalTimestamp(value, "stateUpdatedAt") ||
    !isOptionalUUID(value, "assigneeUserId") ||
    !isOptionalString(value, "subscriberEmail", 320)
  ) {
    return false;
  }
  if (
    (value.snoozeUntil !== undefined ||
      value.archivedAt !== undefined ||
      value.assigneeUserId !== undefined) &&
    value.stateUpdatedAt === undefined
  ) {
    return false;
  }
  if (value.unreadCount > 0 !== (value.oldestUnreadAt !== undefined)) {
    return false;
  }
  if (
    value.lastMessagePreviewOmittedReason === undefined
      ? value.lastMessagePreview.trim().length === 0
      : (value.lastMessagePreviewOmittedReason !== "body_exceeds_inbox_limit" &&
          value.lastMessagePreviewOmittedReason !==
            "legacy_body_unavailable") ||
        value.lastMessagePreview !== ""
  ) {
    return false;
  }
  return !(value.identityAmbiguous && value.subscriberEmail !== undefined);
}

const LIST_RESPONSE_KEYS = new Set([
  "tenantId",
  "conversations",
  "nextCursor",
  "snapshotAt",
  "unreadTotal",
  "unknownTotal",
  "totalConversations",
  "activeTotal",
  "snoozedTotal",
  "archivedTotal",
]);

function isConversationsResponse(
  value: unknown,
  tenantId: string,
  opts: {
    limit?: number;
    filter?: SMSConversationFilter;
    sort?: SMSConversationSort;
    status?: SMSConversationStatus;
  },
): value is SMSConversationsResponse {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, LIST_RESPONSE_KEYS) ||
    value.tenantId !== tenantId ||
    !isUUID(tenantId) ||
    !Array.isArray(value.conversations) ||
    !value.conversations.every(isConversationSummary) ||
    (value.nextCursor !== undefined && !isCursor(value.nextCursor)) ||
    !isTimestamp(value.snapshotAt) ||
    !isNonNegativeInteger(value.unreadTotal) ||
    !isNonNegativeInteger(value.unknownTotal) ||
    !isNonNegativeInteger(value.totalConversations) ||
    !isNonNegativeInteger(value.activeTotal) ||
    !isNonNegativeInteger(value.snoozedTotal) ||
    !isNonNegativeInteger(value.archivedTotal)
  )
    return false;
  const rows = value.conversations as SMSConversationSummary[];
  const phones = new Set(rows.map((row) => row.phoneE164));
  if (
    phones.size !== rows.length ||
    rows.some((row) => row.unreadCount > row.messageCount) ||
    value.unreadTotal > value.totalConversations ||
    value.unknownTotal > value.totalConversations ||
    value.activeTotal + value.snoozedTotal + value.archivedTotal !==
      value.totalConversations ||
    rows.length > (opts.limit ?? 50) ||
    (value.nextCursor !== undefined && rows.length !== (opts.limit ?? 50))
  )
    return false;
  if (opts.filter === "unread" && rows.some((row) => row.unreadCount === 0))
    return false;
  if (
    opts.filter === "unknown" &&
    rows.some(
      (row) => row.subscriberEmail !== undefined || row.identityAmbiguous,
    )
  )
    return false;
  const snapshot = Date.parse(value.snapshotAt as string);
  if (
    opts.status === "archived" &&
    rows.some((row) => row.archivedAt === undefined)
  )
    return false;
  if (
    opts.status === "snoozed" &&
    rows.some(
      (row) => row.archivedAt !== undefined || row.snoozeUntil === undefined,
    )
  )
    return false;
  if (
    (opts.status ?? "active") === "active" &&
    rows.some(
      (row) =>
        row.archivedAt !== undefined ||
        (row.snoozeUntil !== undefined &&
          Date.parse(row.snoozeUntil) > snapshot),
    )
  )
    return false;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1] as SMSConversationSummary;
    const current = rows[index] as SMSConversationSummary;
    if ((opts.sort ?? "recent") === "recent") {
      const delta =
        Date.parse(previous.lastMessageAt) - Date.parse(current.lastMessageAt);
      if (
        delta < 0 ||
        (delta === 0 && previous.phoneE164.localeCompare(current.phoneE164) > 0)
      )
        return false;
    } else {
      const previousRank = previous.unreadCount > 0 ? 0 : 1;
      const currentRank = current.unreadCount > 0 ? 0 : 1;
      const previousAt = previous.oldestUnreadAt
        ? Date.parse(previous.oldestUnreadAt)
        : Number.POSITIVE_INFINITY;
      const currentAt = current.oldestUnreadAt
        ? Date.parse(current.oldestUnreadAt)
        : Number.POSITIVE_INFINITY;
      if (
        previousRank > currentRank ||
        (previousRank === currentRank &&
          (previousAt > currentAt ||
            (previousAt === currentAt &&
              previous.phoneE164.localeCompare(current.phoneE164) > 0)))
      )
        return false;
    }
  }
  return true;
}

const MESSAGE_KEYS = new Set([
  "id",
  "tenant_id",
  "campaign_id",
  "sender_profile_id",
  "phone_e164",
  "provider",
  "provider_message_id",
  "direction",
  "body",
  "body_omitted_reason",
  "media_url",
  "segments",
  "status",
  "error_code",
  "error_message",
  "cost_micros",
  "sent_at",
  "delivered_at",
  "received_at",
  "created_at",
  "dispatch_state",
]);

function isMessage(value: unknown): value is SMSMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, MESSAGE_KEYS)) return false;
  if (
    !isUUID(value.id) ||
    !isUUID(value.tenant_id) ||
    !isOptionalUUID(value, "campaign_id") ||
    !isOptionalUUID(value, "sender_profile_id") ||
    typeof value.phone_e164 !== "string" ||
    !E164_US_CA_RE.test(value.phone_e164) ||
    !isProvider(value.provider) ||
    !isOptionalString(value, "provider_message_id", 512) ||
    (value.direction !== "inbound" && value.direction !== "outbound") ||
    typeof value.body !== "string" ||
    value.body.includes("\u0000") ||
    new TextEncoder().encode(value.body).byteLength > 16_384 ||
    Array.from(value.body).length > 4_800 ||
    !isNonNegativeInteger(value.segments) ||
    value.segments < 1 ||
    typeof value.status !== "string" ||
    !MESSAGE_STATUSES.has(value.status) ||
    !isOptionalString(value, "error_code", 64) ||
    !isOptionalString(value, "error_message", 256) ||
    !isNonNegativeInteger(value.cost_micros) ||
    !isOptionalTimestamp(value, "sent_at") ||
    !isOptionalTimestamp(value, "delivered_at") ||
    !isOptionalTimestamp(value, "received_at") ||
    !isTimestamp(value.created_at)
  ) {
    return false;
  }
  if (
    value.body_omitted_reason === undefined
      ? value.body.trim().length === 0
      : (value.body_omitted_reason !== "body_exceeds_inbox_limit" &&
          value.body_omitted_reason !== "legacy_body_unavailable") ||
        value.body !== ""
  ) {
    return false;
  }
  if (value.media_url !== undefined) {
    try {
      const parsed = new URL(value.media_url as string);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        return false;
    } catch {
      return false;
    }
  }
  return (
    value.dispatch_state === undefined ||
    (typeof value.dispatch_state === "string" &&
      DISPATCH_STATES.has(value.dispatch_state))
  );
}

const MESSAGE_RESPONSE_KEYS = new Set([
  "tenantId",
  "messages",
  "nextCursor",
  "snapshotAt",
]);
function isMessagesResponse(
  value: unknown,
  tenantId: string,
  phone: string,
  limit: number,
): value is SMSMessagesResponse {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, MESSAGE_RESPONSE_KEYS) ||
    value.tenantId !== tenantId ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    (value.nextCursor !== undefined && !isCursor(value.nextCursor)) ||
    !isTimestamp(value.snapshotAt)
  )
    return false;
  const rows = value.messages as SMSMessage[];
  if (
    !isUUID(tenantId) ||
    !E164_US_CA_RE.test(phone) ||
    rows.some(
      (row) => row.tenant_id !== tenantId || row.phone_e164 !== phone,
    ) ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.length > limit ||
    (value.nextCursor !== undefined && rows.length !== limit)
  )
    return false;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1] as SMSMessage;
    const current = rows[index] as SMSMessage;
    const delta =
      Date.parse(previous.created_at) - Date.parse(current.created_at);
    if (delta < 0 || (delta === 0 && previous.id.localeCompare(current.id) < 0))
      return false;
  }
  return true;
}

const SEARCH_RESPONSE_KEYS = new Set([
  "tenantId",
  "conversations",
  "nextCursor",
  "snapshotAt",
]);
function isSearchResponse(
  value: unknown,
  tenantId: string,
  limit: number,
): value is SMSSearchResponse {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, SEARCH_RESPONSE_KEYS) ||
    value.tenantId !== tenantId ||
    !isUUID(tenantId) ||
    !Array.isArray(value.conversations) ||
    !value.conversations.every(isConversationSummary) ||
    (value.nextCursor !== undefined && !isCursor(value.nextCursor)) ||
    !isTimestamp(value.snapshotAt)
  )
    return false;
  const rows = value.conversations as SMSConversationSummary[];
  if (
    new Set(rows.map((row) => row.phoneE164)).size !== rows.length ||
    rows.length > limit ||
    (value.nextCursor !== undefined && rows.length !== limit)
  )
    return false;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1] as SMSConversationSummary;
    const current = rows[index] as SMSConversationSummary;
    const delta =
      Date.parse(previous.lastMessageAt) - Date.parse(current.lastMessageAt);
    if (
      delta < 0 ||
      (delta === 0 && previous.phoneE164.localeCompare(current.phoneE164) > 0)
    )
      return false;
  }
  return true;
}

const ELIGIBLE_LIST_KEYS = new Set([
  "id",
  "name",
  "description",
  "consentSource",
  "consentAt",
]);
function isEligibleList(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ELIGIBLE_LIST_KEYS) &&
    isUUID(value.id) &&
    isBoundedString(value.name, 256) &&
    isBoundedString(value.description, 2048, true) &&
    (value.consentSource === undefined ||
      (typeof value.consentSource === "string" &&
        SAFE_TOKEN_RE.test(value.consentSource))) &&
    (value.consentAt === undefined || isTimestamp(value.consentAt))
  );
}

const CONTEXT_KEYS = new Set([
  "tenantId",
  "phoneE164",
  "subscriberEmail",
  "consentStatus",
  "consentSource",
  "consentAt",
  "optOutAt",
  "consentMixed",
  "identityAmbiguous",
  "consentEvidenceSufficient",
  "subscribedLists",
  "firstSeenAt",
  "totalMessages",
  "lastReadAt",
  "suppressed",
  "suppressionReason",
  "suppressionReversible",
  "hasInboundThread",
  "eligibleLists",
  "replyDispatchAvailable",
  "replyDispatchUnavailableReason",
]);
function isConversationContext(
  value: unknown,
  tenantId: string,
  phone: string,
): value is SMSConversationContext {
  if (!isRecord(value) || !hasOnlyKeys(value, CONTEXT_KEYS)) return false;
  if (
    value.tenantId !== tenantId ||
    !isUUID(tenantId) ||
    value.phoneE164 !== phone ||
    typeof value.phoneE164 !== "string" ||
    !E164_US_CA_RE.test(value.phoneE164) ||
    !isOptionalString(value, "subscriberEmail", 320) ||
    !["opted_in", "opted_out", "pending", "none"].includes(
      value.consentStatus as string,
    ) ||
    (value.consentSource !== undefined &&
      (typeof value.consentSource !== "string" ||
        !SAFE_TOKEN_RE.test(value.consentSource))) ||
    !isOptionalTimestamp(value, "consentAt") ||
    !isOptionalTimestamp(value, "optOutAt") ||
    typeof value.consentMixed !== "boolean" ||
    typeof value.identityAmbiguous !== "boolean" ||
    typeof value.consentEvidenceSufficient !== "boolean" ||
    !isNonNegativeInteger(value.subscribedLists) ||
    !isOptionalTimestamp(value, "firstSeenAt") ||
    !isNonNegativeInteger(value.totalMessages) ||
    !isOptionalTimestamp(value, "lastReadAt") ||
    typeof value.suppressed !== "boolean" ||
    !isOptionalString(value, "suppressionReason", 128) ||
    typeof value.suppressionReversible !== "boolean" ||
    typeof value.hasInboundThread !== "boolean" ||
    !Array.isArray(value.eligibleLists) ||
    !value.eligibleLists.every(isEligibleList) ||
    typeof value.replyDispatchAvailable !== "boolean" ||
    !isOptionalString(value, "replyDispatchUnavailableReason", 128)
  ) {
    return false;
  }
  if (value.identityAmbiguous && value.subscriberEmail !== undefined)
    return false;
  if (
    !value.replyDispatchAvailable &&
    value.replyDispatchUnavailableReason === undefined
  )
    return false;
  return true;
}

const ACTIVITY_KEYS = new Set([
  "tenantId",
  "phoneE164",
  "events",
  "snapshotAt",
  "truncated",
  "sourcePlanes",
  "historyComplete",
]);
const ACTIVITY_EVENT_KEYS = new Set(["kind", "at", "title", "meta"]);
function isActivityEvent(value: unknown): value is SMSActivityEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTIVITY_EVENT_KEYS))
    return false;
  if (
    (value.kind !== "consent" && value.kind !== "subscription") ||
    !isTimestamp(value.at) ||
    !isBoundedString(value.title, 256) ||
    !isRecord(value.meta)
  ) {
    return false;
  }
  const metaKeys =
    value.kind === "consent"
      ? new Set(["evidenceId", "source"])
      : new Set(["listId", "source"]);
  if (!hasOnlyKeys(value.meta, metaKeys)) return false;
  if (value.kind === "consent") {
    return (
      isUUID(value.meta.evidenceId) &&
      typeof value.meta.source === "string" &&
      SAFE_TOKEN_RE.test(value.meta.source)
    );
  }
  return (
    isUUID(value.meta.listId) &&
    (value.meta.source === undefined ||
      (typeof value.meta.source === "string" &&
        SAFE_TOKEN_RE.test(value.meta.source)))
  );
}

function isActivityResponse(
  value: unknown,
  tenantId: string,
  phone: string,
): value is SMSActivityResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ACTIVITY_KEYS) ||
    value.tenantId !== tenantId ||
    !isUUID(tenantId) ||
    value.phoneE164 !== phone ||
    !E164_US_CA_RE.test(phone) ||
    !Array.isArray(value.events) ||
    value.events.length > 200 ||
    !value.events.every(isActivityEvent) ||
    !isTimestamp(value.snapshotAt) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.sourcePlanes) ||
    value.sourcePlanes.length !== 2 ||
    value.sourcePlanes[0] !== "sms_consent_events" ||
    value.sourcePlanes[1] !== "sms_subscriptions_current" ||
    value.historyComplete !== false
  ) {
    return false;
  }
  for (let index = 1; index < value.events.length; index += 1) {
    if (
      Date.parse((value.events[index - 1] as SMSActivityEvent).at) <
      Date.parse((value.events[index] as SMSActivityEvent).at)
    ) {
      return false;
    }
  }
  return true;
}

const CONVERSATION_TAGS_RESPONSE_KEYS = new Set([
  "tenantId",
  "phoneE164",
  "tags",
  "snapshotAt",
  "truncated",
]);
const CONVERSATION_TAG_KEYS = new Set(["tag", "createdAt"]);

function isConversationTag(value: unknown): value is SMSConversationTag {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, CONVERSATION_TAG_KEYS) &&
    typeof value.tag === "string" &&
    value.tag.length > 0 &&
    value.tag === value.tag.trim() &&
    Array.from(value.tag).length <= 64 &&
    new TextEncoder().encode(value.tag).byteLength <= 256 &&
    !/[\p{Cc}\p{Cf}]/u.test(value.tag) &&
    isTimestamp(value.createdAt)
  );
}

function isConversationTagsResponse(
  value: unknown,
  tenantId: string,
  phone: string,
): value is SMSConversationTagsResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, CONVERSATION_TAGS_RESPONSE_KEYS) ||
    value.tenantId !== tenantId ||
    value.phoneE164 !== phone ||
    !Array.isArray(value.tags) ||
    value.tags.length > 100 ||
    !value.tags.every(isConversationTag) ||
    !isTimestamp(value.snapshotAt) ||
    typeof value.truncated !== "boolean"
  ) {
    return false;
  }
  const tags = new Set<string>();
  let prior: SMSConversationTag | undefined;
  for (const item of value.tags) {
    if (tags.has(item.tag)) return false;
    tags.add(item.tag);
    if (
      prior &&
      (item.createdAt < prior.createdAt ||
        (item.createdAt === prior.createdAt && item.tag <= prior.tag))
    ) {
      return false;
    }
    prior = item;
  }
  return true;
}

function isConversationTagMutationResponse(
  value: unknown,
  tenantId: string,
  phone: string,
  tag: string,
  action: "add" | "remove",
  expectedCreatedAt?: string,
): value is SMSConversationTagMutationResponse {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "ok",
    "tenantId",
    "phoneE164",
    "tag",
    "createdAt",
    "action",
  ]);
  return (
    hasOnlyKeys(value, allowed) &&
    value.ok === true &&
    value.tenantId === tenantId &&
    value.phoneE164 === phone &&
    value.tag === tag &&
    value.action === action &&
    isTimestamp(value.createdAt) &&
    (expectedCreatedAt === undefined || value.createdAt === expectedCreatedAt)
  );
}

const QUICK_REPLY_KEYS = new Set([
  "id",
  "label",
  "body",
  "useCount",
  "lastUsedAt",
  "createdAt",
  "updatedAt",
]);

function isQuickReply(value: unknown): value is SMSQuickReply {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, QUICK_REPLY_KEYS) &&
    isUUID(value.id) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label === value.label.trim() &&
    Array.from(value.label).length <= 80 &&
    new TextEncoder().encode(value.label).byteLength <= 320 &&
    !/[\p{Cc}\p{Cf}]/u.test(value.label) &&
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    !value.body.includes("\u0000") &&
    new TextEncoder().encode(value.body).byteLength <= 16_384 &&
    Array.from(value.body).length <= 4_800 &&
    isNonNegativeInteger(value.useCount) &&
    isOptionalTimestamp(value, "lastUsedAt") &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
    (value.lastUsedAt === undefined ||
      (typeof value.lastUsedAt === "string" &&
        Date.parse(value.lastUsedAt) >= Date.parse(value.createdAt)))
  );
}

const QUICK_REPLIES_RESPONSE_KEYS = new Set([
  "tenantId",
  "replies",
  "snapshotAt",
  "truncated",
]);

function isQuickRepliesResponse(
  value: unknown,
  tenantId: string,
): value is SMSQuickRepliesResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, QUICK_REPLIES_RESPONSE_KEYS) ||
    value.tenantId !== tenantId ||
    !isUUID(tenantId) ||
    !Array.isArray(value.replies) ||
    value.replies.length > 500 ||
    !value.replies.every(isQuickReply) ||
    !isTimestamp(value.snapshotAt) ||
    typeof value.truncated !== "boolean"
  ) {
    return false;
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  let prior: SMSQuickReply | undefined;
  for (const reply of value.replies) {
    if (ids.has(reply.id) || labels.has(reply.label)) return false;
    ids.add(reply.id);
    labels.add(reply.label);
    if (prior) {
      if (reply.useCount > prior.useCount) return false;
      if (reply.useCount === prior.useCount) {
        const priorLast = prior.lastUsedAt
          ? Date.parse(prior.lastUsedAt)
          : Number.NEGATIVE_INFINITY;
        const replyLast = reply.lastUsedAt
          ? Date.parse(reply.lastUsedAt)
          : Number.NEGATIVE_INFINITY;
        if (replyLast > priorLast) return false;
        if (replyLast === priorLast) {
          const labelOrder = compareUTF8(reply.label, prior.label);
          if (labelOrder < 0 || (labelOrder === 0 && reply.id <= prior.id)) {
            return false;
          }
        }
      }
    }
    prior = reply;
  }
  return true;
}

function isQuickReplyMutationResponse(
  value: unknown,
  tenantId: string,
): value is SMSQuickReplyMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["tenantId", "reply"])) &&
    value.tenantId === tenantId &&
    isUUID(tenantId) &&
    isQuickReply(value.reply)
  );
}

function isConversationStateMutationResponse(
  value: unknown,
  tenantId: string,
  phone: string,
  action: SMSConversationStateMutationResponse["action"],
): value is SMSConversationStateMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set([
        "ok",
        "tenantId",
        "phoneE164",
        "action",
        "snoozeUntil",
        "archivedAt",
        "assigneeUserId",
        "stateUpdatedAt",
      ]),
    ) &&
    value.ok === true &&
    value.tenantId === tenantId &&
    isUUID(tenantId) &&
    value.phoneE164 === phone &&
    E164_US_CA_RE.test(phone) &&
    value.action === action &&
    isOptionalTimestamp(value, "snoozeUntil") &&
    isOptionalTimestamp(value, "archivedAt") &&
    isOptionalUUID(value, "assigneeUserId") &&
    isTimestamp(value.stateUpdatedAt) &&
    (action !== "archive" || value.archivedAt !== undefined) &&
    (action !== "unarchive" || value.archivedAt === undefined) &&
    (action !== "unsnooze" || value.snoozeUntil === undefined)
  );
}

function isConversationBulkMutationResponse(
  value: unknown,
  tenantId: string,
  action: SMSConversationBulkMutationResponse["action"],
  phones: string[],
): value is SMSConversationBulkMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set(["ok", "tenantId", "action", "applied", "receipts"]),
    ) &&
    value.ok === true &&
    value.tenantId === tenantId &&
    value.action === action &&
    value.applied === phones.length &&
    Array.isArray(value.receipts) &&
    value.receipts.length === phones.length &&
    value.receipts.every((receipt, index) =>
      isConversationStateMutationResponse(
        receipt,
        tenantId,
        phones[index] ?? "",
        action,
      ),
    )
  );
}

function isProviderReceipt(
  value: unknown,
  providerIDRequired: boolean,
): boolean {
  if (!isRecord(value)) return false;
  const keys = new Set(["provider", "providerMessageId", "status"]);
  return (
    hasOnlyKeys(value, keys) &&
    isProvider(value.provider) &&
    isBoundedString(value.status, 64) &&
    (providerIDRequired
      ? isBoundedString(value.providerMessageId, 512)
      : value.providerMessageId === undefined ||
        isBoundedString(value.providerMessageId, 512))
  );
}

function isReplyOutcome(
  value: unknown,
  tenantId: string,
): value is SMSReplyOutcome {
  if (!isRecord(value)) return false;
  if (value.disposition === "reconciliation_required") {
    return (
      hasOnlyKeys(
        value,
        new Set(["disposition", "code", "intentMessageId", "providerReceipt"]),
      ) &&
      value.code === "reply_reconciliation_required" &&
      isUUID(value.intentMessageId) &&
      isProviderReceipt(value.providerReceipt, false)
    );
  }
  if (value.disposition !== "persisted" || !isRecord(value.message))
    return false;
  const message = value.message;
  return (
    hasOnlyKeys(
      value,
      new Set(["disposition", "message", "providerReceipt"]),
    ) &&
    hasOnlyKeys(
      message,
      new Set([
        "id",
        "tenant_id",
        "sender_profile_id",
        "provider",
        "provider_message_id",
        "direction",
        "segments",
        "status",
        "cost_micros",
        "sent_at",
        "created_at",
      ]),
    ) &&
    isUUID(message.id) &&
    isUUID(message.tenant_id) &&
    message.tenant_id === tenantId &&
    isUUID(message.sender_profile_id) &&
    isProvider(message.provider) &&
    isBoundedString(message.provider_message_id, 512) &&
    message.direction === "outbound" &&
    isNonNegativeInteger(message.segments) &&
    message.segments > 0 &&
    isBoundedString(message.status, 64) &&
    isNonNegativeInteger(message.cost_micros) &&
    (message.sent_at === undefined || isTimestamp(message.sent_at)) &&
    isTimestamp(message.created_at) &&
    isProviderReceipt(value.providerReceipt, true)
  );
}

function invalidSMSResponse<T>(): ApiResult<T> {
  return {
    error: {
      kind: "parse",
      code: "invalid_sms_inbox_response",
      message:
        "The SMS service returned a response that did not match the verified contract.",
    },
    retryability: "not-retryable",
  };
}

function signalOptions(
  signal: AbortSignal | undefined,
): SmsInboxRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

async function decodeSMSResult<T>(
  pending: Promise<ApiResult<unknown>>,
  guard: (value: unknown) => value is T,
): Promise<ApiResult<T>> {
  const result = await pending;
  if ("error" in result && result.error) return result;
  if (!guard(result.data)) return invalidSMSResponse<T>();
  return { ...result, data: result.data };
}

const SENDER_KEYS = new Set([
  "id",
  "tenant_id",
  "provider",
  "country",
  "sender_type",
  "phone_number",
  "messaging_service_sid",
  "brand_registration_sid",
  "campaign_registration_sid",
  "registration_status",
  "capabilities",
  "metadata",
  "created_at",
  "updated_at",
]);

function isSenderWire(value: unknown): value is UnknownRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, SENDER_KEYS) &&
    isUUID(value.id) &&
    isUUID(value.tenant_id) &&
    isProvider(value.provider) &&
    isBoundedString(value.country, 8) &&
    typeof value.sender_type === "string" &&
    SAFE_TOKEN_RE.test(value.sender_type) &&
    (value.phone_number === undefined ||
      (typeof value.phone_number === "string" &&
        E164_US_CA_RE.test(value.phone_number))) &&
    isOptionalString(value, "messaging_service_sid", 256) &&
    isOptionalString(value, "brand_registration_sid", 256) &&
    isOptionalString(value, "campaign_registration_sid", 256) &&
    typeof value.registration_status === "string" &&
    SAFE_TOKEN_RE.test(value.registration_status) &&
    (value.capabilities === undefined || isRecord(value.capabilities)) &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

async function decodeSenderResult(
  pending: Promise<ApiResult<unknown>>,
  expectedTenantId: string | null,
): Promise<ApiResult<SMSSendersResponse>> {
  const result = await pending;
  if ("error" in result && result.error) return result;
  const value = result.data;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["tenantId", "items"])) ||
    value.tenantId !== expectedTenantId ||
    !Array.isArray(value.items) ||
    !value.items.every(isSenderWire) ||
    !isUUID(expectedTenantId) ||
    value.items.some(
      (sender) => (sender as UnknownRecord).tenant_id !== expectedTenantId,
    )
  ) {
    return invalidSMSResponse();
  }
  return {
    ...result,
    data: {
      tenantId: value.tenantId as string,
      items: value.items.map((sender) => ({
        id: sender.id as string,
        tenant_id: sender.tenant_id as string,
        provider: sender.provider as string,
        ...(sender.phone_number === undefined
          ? {}
          : { phone_number: sender.phone_number as string }),
        registration_status: sender.registration_status as string,
      })),
    },
  };
}

/**
 * GET /api/v1/sms/conversations — one row per phone with last
 * message preview and unread evidence. Pagination uses an encrypted,
 * query-bound created-at boundary cursor.
 */
export function createListSMSConversations({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function listSMSConversations(
    opts: {
      cursor?: string;
      limit?: number;
      /** Refined SMS Inbox PR 1: server-side filter. Default "all". */
      filter?: SMSConversationFilter;
      /** Refined SMS Inbox PR 1: ORDER BY override. Default "recent". */
      sort?: SMSConversationSort;
      /** Refined SMS Inbox PR 2: lifecycle status. Default "active". */
      status?: SMSConversationStatus;
      /** Refined SMS Inbox PR 2: restrict to phones carrying this tag. */
      tag?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiResult<SMSConversationsResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    if (opts.filter && opts.filter !== "all") params.set("filter", opts.filter);
    if (opts.sort && opts.sort !== "recent") params.set("sort", opts.sort);
    if (opts.status && opts.status !== "active")
      params.set("status", opts.status);
    if (opts.tag) params.set("tag", opts.tag);
    const qs = params.toString();
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations${qs ? `?${qs}` : ""}`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSConversationsResponse =>
        isConversationsResponse(value, getTenantId() ?? "", opts),
    );
  };
}

/** GET /api/v1/sms/conversations/{phone}/messages — reverse-chrono thread. */
export function createListSMSConversationMessages({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function listSMSConversationMessages(
    phone: string,
    opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSMessagesResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/messages${qs ? `?${qs}` : ""}`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSMessagesResponse =>
        isMessagesResponse(
          value,
          getTenantId() ?? "",
          phone,
          opts.limit ?? 100,
        ),
    );
  };
}

/** POST /api/v1/sms/conversations/{phone}/reply — reply to a thread. */
export function createReplySMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function replySMSConversation(
    phone: string,
    body: SMSReplyRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<SMSReplyOutcome>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/reply`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(body),
        },
        // Provider-boundary mutation: never transport-retry or queue offline.
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSReplyOutcome =>
        isReplyOutcome(value, getTenantId() ?? ""),
    );
  };
}

/** POST /api/v1/sms/conversations/{phone}/mark-read — clear unread. */
export function createMarkSMSConversationRead({
  request,
}: SmsInboxOperationsDependencies) {
  return function markSMSConversationRead(
    phone: string,
    messageIds: string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<{ ok: boolean; applied: number }>> {
    return request<{ ok: boolean; applied: number }>(
      `/api/v1/sms/conversations/${encodeURIComponent(phone)}/mark-read`,
      { method: "POST", body: JSON.stringify({ message_ids: messageIds }) },
      signalOptions(opts.signal),
    );
  };
}

/**
 * Refined SMS Inbox PR 1: GET /api/v1/sms/conversations/{phone}/context.
 * Subscriber + lifecycle metadata for the thread header. Cheap query
 * (small joins); we fetch lazily on thread-open rather than fattening
 * every row in the conversations list.
 */
export function createGetSMSConversationContext({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function getSMSConversationContext(
    phone: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSConversationContext>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/context`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSConversationContext =>
        isConversationContext(value, getTenantId() ?? "", phone),
    );
  };
}

export function createSnoozeSMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function snoozeSMSConversation(
    phone: string,
    until: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/snooze`,
        {
          method: "POST",
          body: JSON.stringify({ until, expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "snooze",
        ),
    );
  };
}

export function createUnsnoozeSMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function unsnoozeSMSConversation(
    phone: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/unsnooze`,
        {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "unsnooze",
        ),
    );
  };
}

export function createArchiveSMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function archiveSMSConversation(
    phone: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/archive`,
        {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "archive",
        ),
    );
  };
}

export function createUnarchiveSMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function unarchiveSMSConversation(
    phone: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/unarchive`,
        {
          method: "POST",
          body: JSON.stringify({ expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "unarchive",
        ),
    );
  };
}

export function createAssignSMSConversation({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function assignSMSConversation(
    phone: string,
    userId: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/assign`,
        {
          method: "POST",
          body: JSON.stringify({ userId, expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "assign",
        ),
    );
  };
}

export function createSetSMSConversationNotes({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function setSMSConversationNotes(
    phone: string,
    notes: string,
    expectedUpdatedAt: string | null = null,
  ): Promise<ApiResult<SMSConversationStateMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/notes`,
        {
          method: "POST",
          body: JSON.stringify({ notes, expectedUpdatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationStateMutationResponse =>
        isConversationStateMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          "notes",
        ),
    );
  };
}

export function createListSMSConversationTags({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function listSMSConversationTags(
    phone: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSConversationTagsResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/tags`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSConversationTagsResponse =>
        isConversationTagsResponse(value, getTenantId() ?? "", phone),
    );
  };
}

export function createAddSMSConversationTag({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function addSMSConversationTag(
    phone: string,
    tag: string,
  ): Promise<ApiResult<SMSConversationTagMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/tags`,
        {
          method: "POST",
          body: JSON.stringify({ tag, expectedAbsent: true }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationTagMutationResponse =>
        isConversationTagMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          tag,
          "add",
        ),
    );
  };
}

export function createRemoveSMSConversationTag({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function removeSMSConversationTag(
    phone: string,
    tag: string,
    expectedCreatedAt = "",
  ): Promise<ApiResult<SMSConversationTagMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/tags`,
        {
          method: "DELETE",
          body: JSON.stringify({ tag, expectedCreatedAt }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationTagMutationResponse =>
        isConversationTagMutationResponse(
          value,
          getTenantId() ?? "",
          phone,
          tag,
          "remove",
          expectedCreatedAt,
        ),
    );
  };
}

export function createGetSMSConversationActivity({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function getSMSConversationActivity(
    phone: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSActivityResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/${encodeURIComponent(phone)}/activity`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSActivityResponse =>
        isActivityResponse(value, getTenantId() ?? "", phone),
    );
  };
}

export function createBulkSMSConversationAction({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return function bulkSMSConversationAction(input: {
    conversations?: Array<{
      phoneE164: string;
      expectedUpdatedAt: string | null;
    }>;
    /** Compatibility input: still CAS-protected as an explicit null version. */
    phones?: string[];
    action: "archive" | "unarchive" | "snooze" | "unsnooze";
    until?: string;
  }): Promise<ApiResult<SMSConversationBulkMutationResponse>> {
    const conversations =
      input.conversations ??
      (input.phones ?? []).map((phoneE164) => ({
        phoneE164,
        expectedUpdatedAt: null,
      }));
    const phones = conversations.map((row) => row.phoneE164);
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/conversations/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            conversations,
            action: input.action,
            ...(input.until ? { until: input.until } : {}),
          }),
        },
        { maxAttempts: 1, requireOnline: true },
      ),
      (value): value is SMSConversationBulkMutationResponse =>
        isConversationBulkMutationResponse(
          value,
          getTenantId() ?? "",
          input.action,
          phones,
        ),
    );
  };
}

export function createSearchSMSConversations({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function searchSMSConversations(
    input: {
      query: string;
      cursor?: string;
      limit?: number;
    },
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSSearchResponse>> {
    return decodeSMSResult(
      request<unknown>(
        "/api/v1/sms/conversations/search",
        { method: "POST", body: JSON.stringify(input) },
        {
          maxAttempts: 1,
          requireOnline: true,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      ),
      (value): value is SMSSearchResponse =>
        isSearchResponse(value, getTenantId() ?? "", input.limit ?? 50),
    );
  };
}

/** Returns a URL string so the caller can window.open() and let the
 *  browser handle the Content-Disposition save. */
export function createSmsConversationsCsvUrl({
  getApiUrl,
}: SmsInboxOperationsDependencies) {
  return function smsConversationsCsvUrl(): string {
    return `${getApiUrl()}/api/v1/sms/conversations.csv`;
  };
}

export function createListSMSQuickReplies({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function listSMSQuickReplies(
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSQuickRepliesResponse>> {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/quick-replies`,
        undefined,
        signalOptions(opts.signal),
      ),
      (value): value is SMSQuickRepliesResponse =>
        isQuickRepliesResponse(value, getTenantId() ?? ""),
    );
  };
}

export function createCreateSMSQuickReply({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function createSMSQuickReply(input: {
    label: string;
    body: string;
  }): Promise<ApiResult<SMSQuickReplyMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(`/api/v1/sms/quick-replies`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
      (value): value is SMSQuickReplyMutationResponse =>
        isQuickReplyMutationResponse(value, getTenantId() ?? ""),
    );
  };
}

export function createUpdateSMSQuickReply({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function updateSMSQuickReply(
    id: string,
    input: { label?: string; body?: string },
  ): Promise<ApiResult<SMSQuickReplyMutationResponse>> {
    return decodeSMSResult(
      request<unknown>(`/api/v1/sms/quick-replies/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
      (value): value is SMSQuickReplyMutationResponse =>
        isQuickReplyMutationResponse(value, getTenantId() ?? "") &&
        value.reply.id === id,
    );
  };
}

export function createDeleteSMSQuickReply({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function deleteSMSQuickReply(
    id: string,
  ): Promise<ApiResult<{ ok: true; tenantId: string; id: string }>> {
    return decodeSMSResult(
      request<unknown>(`/api/v1/sms/quick-replies/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
      (value): value is { ok: true; tenantId: string; id: string } =>
        isRecord(value) &&
        hasOnlyKeys(value, new Set(["ok", "tenantId", "id"])) &&
        value.ok === true &&
        value.tenantId === (getTenantId() ?? "") &&
        value.id === id &&
        isUUID(value.tenantId) &&
        isUUID(value.id),
    );
  };
}

export function createRecordSMSQuickReplyUse({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function recordSMSQuickReplyUse(id: string): Promise<
    ApiResult<{
      ok: true;
      tenantId: string;
      id: string;
      useCount: number;
      lastUsedAt: string;
    }>
  > {
    return decodeSMSResult(
      request<unknown>(
        `/api/v1/sms/quick-replies/${encodeURIComponent(id)}/use`,
        { method: "POST" },
      ),
      (
        value,
      ): value is {
        ok: true;
        tenantId: string;
        id: string;
        useCount: number;
        lastUsedAt: string;
      } =>
        isRecord(value) &&
        hasOnlyKeys(
          value,
          new Set(["ok", "tenantId", "id", "useCount", "lastUsedAt"]),
        ) &&
        value.ok === true &&
        value.tenantId === (getTenantId() ?? "") &&
        value.id === id &&
        isUUID(value.tenantId) &&
        isUUID(value.id) &&
        isNonNegativeInteger(value.useCount) &&
        isTimestamp(value.lastUsedAt),
    );
  };
}

/**
 * GET /api/v1/sms/senders — for the reply composer's sender picker.
 * Returns sender profiles already registered for this tenant.
 */
export function createListSMSSenders({
  request,
  getTenantId,
}: SmsInboxOperationsDependencies) {
  return async function listSMSSenders(
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SMSSendersResponse>> {
    // Backend returns { items: [...] } (sms/handlers.go ListSenders); the
    // legacy { senders } shape it never emitted left every picker empty.
    return decodeSenderResult(
      request<unknown>(
        `/api/v1/sms/senders`,
        undefined,
        signalOptions(opts.signal),
      ),
      getTenantId(),
    );
  };
}

export function createSmsInboxOperationsMethods(
  dependencies: SmsInboxOperationsDependencies,
) {
  return {
    listSMSConversations: createListSMSConversations(dependencies),
    listSMSConversationMessages:
      createListSMSConversationMessages(dependencies),
    replySMSConversation: createReplySMSConversation(dependencies),
    markSMSConversationRead: createMarkSMSConversationRead(dependencies),
    getSMSConversationContext: createGetSMSConversationContext(dependencies),
    snoozeSMSConversation: createSnoozeSMSConversation(dependencies),
    unsnoozeSMSConversation: createUnsnoozeSMSConversation(dependencies),
    archiveSMSConversation: createArchiveSMSConversation(dependencies),
    unarchiveSMSConversation: createUnarchiveSMSConversation(dependencies),
    assignSMSConversation: createAssignSMSConversation(dependencies),
    setSMSConversationNotes: createSetSMSConversationNotes(dependencies),
    listSMSConversationTags: createListSMSConversationTags(dependencies),
    addSMSConversationTag: createAddSMSConversationTag(dependencies),
    removeSMSConversationTag: createRemoveSMSConversationTag(dependencies),
    getSMSConversationActivity: createGetSMSConversationActivity(dependencies),
    bulkSMSConversationAction: createBulkSMSConversationAction(dependencies),
    searchSMSConversations: createSearchSMSConversations(dependencies),
    smsConversationsCsvUrl: createSmsConversationsCsvUrl(dependencies),
    listSMSQuickReplies: createListSMSQuickReplies(dependencies),
    createSMSQuickReply: createCreateSMSQuickReply(dependencies),
    updateSMSQuickReply: createUpdateSMSQuickReply(dependencies),
    deleteSMSQuickReply: createDeleteSMSQuickReply(dependencies),
    recordSMSQuickReplyUse: createRecordSMSQuickReplyUse(dependencies),
    listSMSSenders: createListSMSSenders(dependencies),
  };
}
