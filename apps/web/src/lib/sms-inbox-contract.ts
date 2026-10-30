// SPDX-License-Identifier: AGPL-3.0-only
/** Strict, fail-closed wire and display contract for the web SMS inbox. */

export type SmsInboxBodyOmittedReason =
  | "body_exceeds_inbox_limit"
  | "legacy_body_unavailable";

export interface SmsConversationSummary {
  phoneE164: string;
  identityAmbiguous: boolean;
  lastMessagePreview: string;
  lastMessageAt: string;
  lastDirection: "inbound" | "outbound";
  messageCount: number;
  unreadCount: number;
  oldestUnreadAt?: string;
  lastMessagePreviewOmittedReason?: SmsInboxBodyOmittedReason;
  subscriberEmail?: string;
  snoozeUntil?: string;
  archivedAt?: string;
  assigneeUserId?: string;
  stateUpdatedAt?: string;
}

export interface SmsConversationQueryIdentity {
  filter: "all" | "unread" | "unknown";
  sort: "recent" | "oldest_unread";
  status: "active" | "snoozed" | "archived" | "any";
}

export interface SmsConversationsResponse {
  tenantId: string;
  query: SmsConversationQueryIdentity;
  conversations: SmsConversationSummary[];
  snapshotAt: string;
  unreadTotal: number;
  unknownTotal: number;
  totalConversations: number;
  activeTotal: number;
  snoozedTotal: number;
  archivedTotal: number;
  nextCursor?: string;
}

export interface SmsConversationMessage {
  id: string;
  tenant_id: string;
  phone_e164: string;
  provider: string;
  provider_message_id?: string;
  direction: "inbound" | "outbound";
  body: string;
  body_omitted_reason?: SmsInboxBodyOmittedReason;
  media_url?: string;
  segments: number;
  status: string;
  error_code?: string;
  cost_micros: number;
  sent_at?: string;
  delivered_at?: string;
  received_at?: string;
  created_at: string;
}

export interface SmsMessagesResponse {
  tenantId: string;
  messages: SmsConversationMessage[];
  snapshotAt: string;
  nextCursor?: string;
}

export interface SmsMarkReadResponse {
  ok: true;
  applied: number;
}

export type SmsConversationStateAction =
  | "snooze"
  | "unsnooze"
  | "archive"
  | "unarchive"
  | "assign"
  | "notes";

/** Lifecycle actions the bulk endpoint accepts (assign and notes are single-row). */
export type SmsConversationBulkAction = Exclude<
  SmsConversationStateAction,
  "assign" | "notes"
>;

export interface SmsConversationStateMutationReceipt {
  ok: true;
  tenantId: string;
  phoneE164: string;
  action: SmsConversationStateAction;
  snoozeUntil?: string;
  archivedAt?: string;
  assigneeUserId?: string;
  stateUpdatedAt: string;
}

export interface SmsConversationTag {
  tag: string;
  createdAt: string;
}

export interface SmsConversationTagsResponse {
  tenantId: string;
  phoneE164: string;
  tags: SmsConversationTag[];
  snapshotAt: string;
  truncated: boolean;
}

export interface SmsConversationTagMutationReceipt {
  ok: true;
  tenantId: string;
  phoneE164: string;
  tag: string;
  createdAt: string;
  action: "add" | "remove";
}

export interface SmsConversationActivityEvent {
  kind: "consent" | "subscription";
  at: string;
  title: string;
  meta: { evidenceId: string; source: string } | { listId: string; source: string };
}

export interface SmsConversationActivityResponse {
  tenantId: string;
  phoneE164: string;
  events: SmsConversationActivityEvent[];
  snapshotAt: string;
  truncated: boolean;
  sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"];
  historyComplete: false;
}

export interface SmsConversationBulkMutationReceipt {
  ok: true;
  tenantId: string;
  action: SmsConversationBulkAction;
  applied: number;
  receipts: SmsConversationStateMutationReceipt[];
}

export class SmsInboxContractError extends Error {
  constructor(detail: string) {
    super(`Invalid SMS inbox response: ${detail}`);
    this.name = "SmsInboxContractError";
  }
}

const E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const MAX_INTEGER = 2_147_483_647;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SMS_BODY_MAX_UTF8_BYTES = 16_384;
const SMS_BODY_MAX_CODE_POINTS = 4_800;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SmsInboxContractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(source).find((key) => !keys.has(key));
  if (unexpected) {
    throw new SmsInboxContractError(
      `${path}.${unexpected} is not part of the contract`,
    );
  }
}

function text(
  value: unknown,
  path: string,
  max: number,
  empty = false,
): string {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new SmsInboxContractError(`${path} must be a string`);
  }
  if (Array.from(value).length > max || utf8Bytes(value) > max * 4) {
    throw new SmsInboxContractError(`${path} is too long`);
  }
  return value;
}

function token(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!TOKEN.test(result))
    throw new SmsInboxContractError(`${path} is not a token`);
  return result;
}

function uuid(value: unknown, path: string): string {
  const result = text(value, path, 36);
  if (!UUID_V4.test(result)) {
    throw new SmsInboxContractError(
      `${path} must be a canonical lowercase UUIDv4`,
    );
  }
  return result;
}

function tenantUuid(value: unknown, path: string): string {
  const result = text(value, path, 36);
  if (!TENANT_UUID.test(result)) {
    throw new SmsInboxContractError(
      `${path} must be a canonical lowercase tenant UUID`,
    );
  }
  return result;
}

function tenantEnvelope(
  source: Record<string, unknown>,
  expectedTenant: string,
  path: string,
): string {
  const tenantId = tenantUuid(source.tenantId, `${path}.tenantId`);
  if (tenantUuid(expectedTenant, `${path}.expectedTenantId`) !== tenantId) {
    throw new SmsInboxContractError(`${path} belongs to another tenant`);
  }
  return tenantId;
}

function integer(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_INTEGER
  ) {
    throw new SmsInboxContractError(
      `${path} must be a bounded non-negative integer`,
    );
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!isSmsInboxRfc3339(result)) {
    throw new SmsInboxContractError(`${path} must be RFC3339`);
  }
  return result;
}

export function isSmsInboxRfc3339(value: string): boolean {
  const parts = RFC3339.exec(value);
  return Boolean(
    parts && validRfc3339Parts(parts) && Number.isFinite(Date.parse(value)),
  );
}

function validRfc3339Parts(parts: RegExpExecArray): boolean {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = Number(parts[8] ?? 0);
  const offsetMinute = Number(parts[9] ?? 0);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function optionalText(
  row: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
) {
  const value = row[key];
  return value === undefined ? undefined : text(value, `${path}.${key}`, max);
}

function optionalTimestamp(
  row: Record<string, unknown>,
  key: string,
  path: string,
) {
  const value = row[key];
  return value === undefined ? undefined : timestamp(value, `${path}.${key}`);
}

function cursor(
  row: Record<string, unknown>,
  path: string,
): string | undefined {
  const value = row.nextCursor;
  if (value === undefined) return undefined;
  const result = text(value, `${path}.nextCursor`, 4_096);
  if (CONTROL.test(result))
    throw new SmsInboxContractError(`${path}.nextCursor has controls`);
  return result;
}

function direction(value: unknown, path: string): "inbound" | "outbound" {
  if (value !== "inbound" && value !== "outbound") {
    throw new SmsInboxContractError(`${path} has an unknown direction`);
  }
  return value;
}

function conversationOrder(
  a: SmsConversationSummary,
  b: SmsConversationSummary,
  sort: SmsConversationQueryIdentity["sort"] = "recent",
): number {
  if (sort === "oldest_unread") {
    const aRank = a.oldestUnreadAt ? 0 : 1;
    const bRank = b.oldestUnreadAt ? 0 : 1;
    return (
      aRank - bRank ||
      (a.oldestUnreadAt && b.oldestUnreadAt
        ? Date.parse(a.oldestUnreadAt) - Date.parse(b.oldestUnreadAt)
        : 0) ||
      a.phoneE164.localeCompare(b.phoneE164)
    );
  }
  return (
    Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt) ||
    a.phoneE164.localeCompare(b.phoneE164)
  );
}

export function decodeSmsConversations(
  raw: unknown,
  expected: {
    tenantId: string;
    query: SmsConversationQueryIdentity;
  },
): SmsConversationsResponse {
  const source = record(raw, "conversations");
  exactKeys(
    source,
    [
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
    ],
    "conversations",
  );
  const tenantId = tenantEnvelope(source, expected.tenantId, "conversations");
  const query = conversationQueryIdentity(expected.query);
  const snapshotAt = timestamp(source.snapshotAt, "conversations.snapshotAt");
  if (
    !Array.isArray(source.conversations) ||
    source.conversations.length > 100
  ) {
    throw new SmsInboxContractError(
      "conversations must contain at most 100 rows",
    );
  }
  const seen = new Set<string>();
  let previous: SmsConversationSummary | undefined;
  const conversations = source.conversations.map((value, index) => {
    const path = `conversations[${index}]`;
    const row = record(value, path);
    exactKeys(
      row,
      [
        "phoneE164",
        "identityAmbiguous",
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
      ],
      path,
    );
    const phoneE164 = text(row.phoneE164, `${path}.phoneE164`, 16);
    if (!E164.test(phoneE164) || seen.has(phoneE164)) {
      throw new SmsInboxContractError(
        `${path}.phoneE164 is invalid or duplicated`,
      );
    }
    seen.add(phoneE164);
    const preview = conversationPreview(row, path);
    const result: SmsConversationSummary = {
      phoneE164,
      identityAmbiguous: requiredBoolean(
        row.identityAmbiguous,
        `${path}.identityAmbiguous`,
      ),
      lastMessagePreview: preview.value,
      lastMessageAt: timestamp(row.lastMessageAt, `${path}.lastMessageAt`),
      lastDirection: direction(row.lastDirection, `${path}.lastDirection`),
      messageCount: integer(row.messageCount, `${path}.messageCount`),
      unreadCount: integer(row.unreadCount, `${path}.unreadCount`),
      ...(preview.omittedReason
        ? { lastMessagePreviewOmittedReason: preview.omittedReason }
        : {}),
      ...conversationOptional(row, path),
    };
    if (result.identityAmbiguous && result.subscriberEmail) {
      throw new SmsInboxContractError(
        `${path}.subscriberEmail must be omitted for ambiguous identity`,
      );
    }
    if (
      (result.snoozeUntil || result.archivedAt || result.assigneeUserId) &&
      !result.stateUpdatedAt
    ) {
      throw new SmsInboxContractError(
        `${path}.stateUpdatedAt is required for operator-managed state`,
      );
    }
    if (
      result.unreadCount > result.messageCount ||
      Date.parse(result.lastMessageAt) > Date.parse(snapshotAt) ||
      Boolean(result.oldestUnreadAt) !== result.unreadCount > 0 ||
      (result.oldestUnreadAt !== undefined &&
        (Date.parse(result.oldestUnreadAt) > Date.parse(snapshotAt) ||
          Date.parse(result.oldestUnreadAt) >
            Date.parse(result.lastMessageAt))) ||
      (previous && conversationOrder(previous, result, query.sort) > 0)
    ) {
      throw new SmsInboxContractError(
        `${path} has invalid counts, time, or order`,
      );
    }
    if (
      (query.filter === "unread" && result.unreadCount === 0) ||
      (query.filter === "unknown" &&
        (result.identityAmbiguous || Boolean(result.subscriberEmail))) ||
      !conversationMatchesStatus(result, query.status, Date.parse(snapshotAt))
    ) {
      throw new SmsInboxContractError(
        `${path} disagrees with the conversation query identity`,
      );
    }
    previous = result;
    return result;
  });
  const result: SmsConversationsResponse = {
    tenantId,
    query,
    conversations,
    snapshotAt,
    unreadTotal: integer(source.unreadTotal, "conversations.unreadTotal"),
    unknownTotal: integer(source.unknownTotal, "conversations.unknownTotal"),
    totalConversations: integer(
      source.totalConversations,
      "conversations.totalConversations",
    ),
    activeTotal: integer(source.activeTotal, "conversations.activeTotal"),
    snoozedTotal: integer(source.snoozedTotal, "conversations.snoozedTotal"),
    archivedTotal: integer(source.archivedTotal, "conversations.archivedTotal"),
    ...(cursor(source, "conversations")
      ? { nextCursor: cursor(source, "conversations") }
      : {}),
  };
  if (
    result.unreadTotal > result.totalConversations ||
    result.unknownTotal > result.totalConversations ||
    result.activeTotal + result.snoozedTotal + result.archivedTotal !==
      result.totalConversations ||
    conversations.length > conversationStatusTotal(result, query.status)
  ) {
    throw new SmsInboxContractError("conversation totals disagree");
  }
  return result;
}

function conversationMatchesStatus(
  row: SmsConversationSummary,
  status: SmsConversationQueryIdentity["status"],
  cutoff: number,
): boolean {
  if (status === "any") return true;
  if (status === "archived") {
    const archivedAt = row.archivedAt;
    return archivedAt !== undefined && Date.parse(archivedAt) <= cutoff;
  }
  if (row.archivedAt) return false;
  const snoozeUntil = row.snoozeUntil ? Date.parse(row.snoozeUntil) : null;
  return status === "snoozed"
    ? snoozeUntil !== null && snoozeUntil > cutoff
    : snoozeUntil === null || snoozeUntil <= cutoff;
}

function conversationStatusTotal(
  response: Pick<
    SmsConversationsResponse,
    "activeTotal" | "snoozedTotal" | "archivedTotal" | "totalConversations"
  >,
  status: SmsConversationQueryIdentity["status"],
): number {
  if (status === "active") return response.activeTotal;
  if (status === "snoozed") return response.snoozedTotal;
  if (status === "archived") return response.archivedTotal;
  return response.totalConversations;
}

function conversationOptional(row: Record<string, unknown>, path: string) {
  const oldestUnreadAt = optionalTimestamp(row, "oldestUnreadAt", path);
  const subscriberEmail = optionalText(row, "subscriberEmail", path, 320);
  const snoozeUntil = optionalTimestamp(row, "snoozeUntil", path);
  const archivedAt = optionalTimestamp(row, "archivedAt", path);
  const stateUpdatedAt = optionalTimestamp(row, "stateUpdatedAt", path);
  const assigneeUserId =
    row.assigneeUserId === undefined
      ? undefined
      : uuid(row.assigneeUserId, `${path}.assigneeUserId`);
  return {
    ...(oldestUnreadAt ? { oldestUnreadAt } : {}),
    ...(subscriberEmail ? { subscriberEmail } : {}),
    ...(snoozeUntil ? { snoozeUntil } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(stateUpdatedAt ? { stateUpdatedAt } : {}),
  };
}

function conversationQueryIdentity(
  value: SmsConversationQueryIdentity,
): SmsConversationQueryIdentity {
  if (
    !value ||
    !["all", "unread", "unknown"].includes(value.filter) ||
    !["recent", "oldest_unread"].includes(value.sort) ||
    !["active", "snoozed", "archived", "any"].includes(value.status)
  ) {
    throw new SmsInboxContractError("conversation query identity is invalid");
  }
  return { filter: value.filter, sort: value.sort, status: value.status };
}

function conversationPreview(
  row: Record<string, unknown>,
  path: string,
): {
  value: string;
  omittedReason?: SmsInboxBodyOmittedReason;
} {
  if (typeof row.lastMessagePreview !== "string") {
    throw new SmsInboxContractError(
      `${path}.lastMessagePreview must be a string`,
    );
  }
  if (row.lastMessagePreviewOmittedReason !== undefined) {
    const reason = row.lastMessagePreviewOmittedReason;
    if (
      (reason !== "body_exceeds_inbox_limit" &&
        reason !== "legacy_body_unavailable") ||
      row.lastMessagePreview !== ""
    ) {
      throw new SmsInboxContractError(
        `${path}.lastMessagePreviewOmittedReason is invalid`,
      );
    }
    return { value: "", omittedReason: reason };
  }
  if (
    row.lastMessagePreview.trim().length === 0 ||
    row.lastMessagePreview.includes("\u0000") ||
    !hasOnlyUnicodeScalars(row.lastMessagePreview) ||
    Array.from(row.lastMessagePreview).length > 512 ||
    utf8Bytes(row.lastMessagePreview) > SMS_BODY_MAX_UTF8_BYTES
  ) {
    throw new SmsInboxContractError(
      `${path}.lastMessagePreview violates the private inbox preview contract`,
    );
  }
  return { value: row.lastMessagePreview };
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new SmsInboxContractError(`${path} must be a boolean`);
  return value;
}

export function decodeSmsMessages(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsMessagesResponse {
  const source = record(raw, "messages");
  exactKeys(
    source,
    ["tenantId", "messages", "nextCursor", "snapshotAt"],
    "messages",
  );
  const tenantId = tenantEnvelope(source, expected.tenantId, "messages");
  const snapshotAt = timestamp(source.snapshotAt, "messages.snapshotAt");
  if (!Array.isArray(source.messages) || source.messages.length > 100) {
    throw new SmsInboxContractError("messages must contain at most 100 rows");
  }
  const seen = new Set<string>();
  let priorAt = Number.POSITIVE_INFINITY;
  let priorId = "";
  const messages = source.messages.map((value, index) => {
    const path = `messages[${index}]`;
    const row = record(value, path);
    exactKeys(
      row,
      [
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
      ],
      path,
    );
    const id = uuid(row.id, `${path}.id`);
    const rowTenantId = tenantUuid(row.tenant_id, `${path}.tenant_id`);
    const phoneE164 = text(row.phone_e164, `${path}.phone_e164`, 16);
    const createdAt = timestamp(row.created_at, `${path}.created_at`);
    const at = Date.parse(createdAt);
    if (
      seen.has(id) ||
      rowTenantId !== tenantId ||
      phoneE164 !== expected.phoneE164 ||
      !E164.test(phoneE164) ||
      at > Date.parse(snapshotAt) ||
      at > priorAt ||
      (at === priorAt && priorId !== "" && priorId.localeCompare(id) < 0)
    ) {
      throw new SmsInboxContractError(
        `${path} violates identity, duplicate, timestamp, or order checks`,
      );
    }
    seen.add(id);
    priorAt = at;
    priorId = id;
    const body = decodeMessageBody(row, path);
    return {
      id,
      tenant_id: rowTenantId,
      phone_e164: phoneE164,
      provider: token(row.provider, `${path}.provider`),
      direction: direction(row.direction, `${path}.direction`),
      body: body.value,
      ...(body.omittedReason
        ? { body_omitted_reason: body.omittedReason }
        : {}),
      segments: integer(row.segments, `${path}.segments`),
      status: token(row.status, `${path}.status`),
      cost_micros: integer(row.cost_micros, `${path}.cost_micros`),
      created_at: createdAt,
      ...messageOptional(row, path),
    } satisfies SmsConversationMessage;
  });
  const nextCursor = cursor(source, "messages");
  return {
    tenantId,
    messages,
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function decodeMessageBody(
  row: Record<string, unknown>,
  path: string,
): {
  value: string;
  omittedReason?: SmsInboxBodyOmittedReason;
} {
  if (typeof row.body !== "string") {
    throw new SmsInboxContractError(`${path}.body must be a string`);
  }
  if (row.body_omitted_reason !== undefined) {
    const reason = row.body_omitted_reason;
    if (
      (reason !== "body_exceeds_inbox_limit" &&
        reason !== "legacy_body_unavailable") ||
      row.body !== ""
    ) {
      throw new SmsInboxContractError(`${path}.body_omitted_reason is invalid`);
    }
    return {
      value: "",
      omittedReason: reason,
    };
  }
  if (
    row.body.trim().length === 0 ||
    row.body.includes("\u0000") ||
    !hasOnlyUnicodeScalars(row.body) ||
    Array.from(row.body).length > SMS_BODY_MAX_CODE_POINTS ||
    utf8Bytes(row.body) > SMS_BODY_MAX_UTF8_BYTES
  ) {
    throw new SmsInboxContractError(
      `${path}.body violates the private inbox body contract`,
    );
  }
  return { value: row.body };
}

export function decodeSmsMarkReadResponse(
  raw: unknown,
  requestedCount: number,
): SmsMarkReadResponse {
  const source = record(raw, "mark-read response");
  if (
    Object.keys(source).some((key) => key !== "ok" && key !== "applied") ||
    source.ok !== true
  ) {
    throw new SmsInboxContractError(
      "mark-read response must be {ok:true,applied}",
    );
  }
  const applied = integer(source.applied, "mark-read response.applied");
  if (applied > requestedCount) {
    throw new SmsInboxContractError("mark-read applied exceeds its boundary");
  }
  return { ok: true, applied };
}

export function decodeSmsConversationStateMutation(
  raw: unknown,
  expected: {
    tenantId: string;
    phoneE164: string;
    action: SmsConversationStateAction;
    snoozeUntil?: string;
    assigneeUserId?: string | null;
  },
): SmsConversationStateMutationReceipt {
  const source = record(raw, "conversation-state response");
  exactKeys(
    source,
    [
      "ok",
      "tenantId",
      "phoneE164",
      "action",
      "snoozeUntil",
      "archivedAt",
      "assigneeUserId",
      "stateUpdatedAt",
    ],
    "conversation-state response",
  );
  if (source.ok !== true || source.action !== expected.action) {
    throw new SmsInboxContractError(
      "conversation-state response has the wrong action",
    );
  }
  const tenantId = tenantEnvelope(
    source,
    expected.tenantId,
    "conversation-state response",
  );
  const phoneE164 = text(
    source.phoneE164,
    "conversation-state response.phoneE164",
    16,
  );
  if (
    !E164.test(expected.phoneE164) ||
    phoneE164 !== expected.phoneE164 ||
    !E164.test(phoneE164)
  ) {
    throw new SmsInboxContractError(
      "conversation-state response has the wrong phone identity",
    );
  }
  const stateUpdatedAt = timestamp(
    source.stateUpdatedAt,
    "conversation-state response.stateUpdatedAt",
  );
  const snoozeUntil = optionalTimestamp(
    source,
    "snoozeUntil",
    "conversation-state response",
  );
  const archivedAt = optionalTimestamp(
    source,
    "archivedAt",
    "conversation-state response",
  );
  const assigneeUserId =
    source.assigneeUserId === undefined
      ? undefined
      : uuid(
          source.assigneeUserId,
          "conversation-state response.assigneeUserId",
        );
  if (archivedAt && Date.parse(archivedAt) > Date.parse(stateUpdatedAt)) {
    throw new SmsInboxContractError(
      "conversation-state response archive time exceeds its version",
    );
  }
  if (
    (expected.action === "snooze" &&
      (!expected.snoozeUntil ||
        !snoozeUntil ||
        Date.parse(snoozeUntil) !== Date.parse(expected.snoozeUntil))) ||
    (expected.action === "unsnooze" && snoozeUntil !== undefined) ||
    (expected.action === "archive" && archivedAt === undefined) ||
    (expected.action === "unarchive" && archivedAt !== undefined) ||
    (expected.action === "assign" &&
      "assigneeUserId" in expected &&
      assigneeUserId !== (expected.assigneeUserId ?? undefined))
  ) {
    throw new SmsInboxContractError(
      "conversation-state response disagrees with the requested transition",
    );
  }
  return {
    ok: true,
    tenantId,
    phoneE164,
    action: expected.action,
    ...(snoozeUntil ? { snoozeUntil } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
    stateUpdatedAt,
  };
}

function decodeConversationTag(
  value: unknown,
  path: string,
): SmsConversationTag {
  const source = record(value, path);
  exactKeys(source, ["tag", "createdAt"], path);
  const tag = text(source.tag, `${path}.tag`, 64);
  if (
    tag !== tag.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(tag) ||
    !hasOnlyUnicodeScalars(tag) ||
    utf8Bytes(tag) > 256
  ) {
    throw new SmsInboxContractError(`${path}.tag is not safe display text`);
  }
  return { tag, createdAt: timestamp(source.createdAt, `${path}.createdAt`) };
}

export function decodeSmsConversationTags(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsConversationTagsResponse {
  const source = record(raw, "conversation-tags response");
  exactKeys(
    source,
    ["tenantId", "phoneE164", "tags", "snapshotAt", "truncated"],
    "conversation-tags response",
  );
  const tenantId = tenantEnvelope(
    source,
    expected.tenantId,
    "conversation-tags response",
  );
  const phoneE164 = text(
    source.phoneE164,
    "conversation-tags response.phoneE164",
    16,
  );
  if (phoneE164 !== expected.phoneE164 || !E164.test(phoneE164)) {
    throw new SmsInboxContractError(
      "conversation-tags response has the wrong phone identity",
    );
  }
  const snapshotAt = timestamp(
    source.snapshotAt,
    "conversation-tags response.snapshotAt",
  );
  if (!Array.isArray(source.tags) || source.tags.length > 100) {
    throw new SmsInboxContractError(
      "conversation-tags response must contain at most 100 tags",
    );
  }
  const seen = new Set<string>();
  let priorAt = Number.NEGATIVE_INFINITY;
  const tags = source.tags.map((value, index) => {
    const tag = decodeConversationTag(value, `conversation-tags[${index}]`);
    const createdAt = Date.parse(tag.createdAt);
    if (
      seen.has(tag.tag) ||
      createdAt < priorAt ||
      createdAt > Date.parse(snapshotAt)
    ) {
      throw new SmsInboxContractError(
        "conversation-tags response has duplicate or unordered evidence",
      );
    }
    seen.add(tag.tag);
    priorAt = createdAt;
    return tag;
  });
  if (typeof source.truncated !== "boolean") {
    throw new SmsInboxContractError(
      "conversation-tags response.truncated must be a boolean",
    );
  }
  return {
    tenantId,
    phoneE164,
    tags,
    snapshotAt,
    truncated: source.truncated,
  };
}

export function decodeSmsConversationTagMutation(
  raw: unknown,
  expected: {
    tenantId: string;
    phoneE164: string;
    tag: string;
    action: "add" | "remove";
    createdAt?: string;
  },
): SmsConversationTagMutationReceipt {
  const source = record(raw, "conversation-tag mutation response");
  exactKeys(
    source,
    ["ok", "tenantId", "phoneE164", "tag", "createdAt", "action"],
    "conversation-tag mutation response",
  );
  if (
    source.ok !== true ||
    source.phoneE164 !== expected.phoneE164 ||
    source.tag !== expected.tag ||
    source.action !== expected.action
  ) {
    throw new SmsInboxContractError(
      "conversation-tag mutation response has the wrong identity",
    );
  }
  const tenantId = tenantEnvelope(
    source,
    expected.tenantId,
    "conversation-tag mutation response",
  );
  const tag = decodeConversationTag(
    { tag: source.tag, createdAt: source.createdAt },
    "conversation-tag mutation response",
  );
  if (
    expected.createdAt &&
    Date.parse(tag.createdAt) !== Date.parse(expected.createdAt)
  ) {
    throw new SmsInboxContractError(
      "conversation-tag mutation response changed the selected tag version",
    );
  }
  return {
    ok: true,
    tenantId,
    phoneE164: expected.phoneE164,
    tag: tag.tag,
    createdAt: tag.createdAt,
    action: expected.action,
  };
}

const ACTIVITY_TITLES = new Set([
  "Consent granted",
  "Consent revoked",
  "Help requested",
  "Consent imported",
  "Current list consent: Pending",
  "Current list consent: Opted in",
  "Current list consent: Opted out",
]);
const CONSENT_ACTIVITY_TITLES = new Set([
  "Consent granted",
  "Consent revoked",
  "Help requested",
  "Consent imported",
]);
const CONSENT_ACTIVITY_SOURCES = new Set([
  "keyword",
  "form",
  "import",
  "api",
  "manual",
  "twilio",
  "telnyx",
  "bandwidth",
  "product",
]);
const SUBSCRIPTION_ACTIVITY_SOURCES = new Set([
  "keyword",
  "form",
  "import",
  "api",
  "manual",
  "unknown",
]);

export function decodeSmsConversationActivity(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsConversationActivityResponse {
  const source = record(raw, "conversation-activity response");
  exactKeys(
    source,
    [
      "tenantId",
      "phoneE164",
      "events",
      "snapshotAt",
      "truncated",
      "sourcePlanes",
      "historyComplete",
    ],
    "conversation-activity response",
  );
  const tenantId = tenantEnvelope(
    source,
    expected.tenantId,
    "conversation-activity response",
  );
  if (
    source.phoneE164 !== expected.phoneE164 ||
    !E164.test(expected.phoneE164) ||
    source.historyComplete !== false ||
    typeof source.truncated !== "boolean" ||
    !Array.isArray(source.sourcePlanes) ||
    source.sourcePlanes.length !== 2 ||
    source.sourcePlanes[0] !== "sms_consent_events" ||
    source.sourcePlanes[1] !== "sms_subscriptions_current" ||
    !Array.isArray(source.events) ||
    source.events.length > 150
  ) {
    throw new SmsInboxContractError(
      "conversation-activity response has an invalid identity or evidence boundary",
    );
  }
  const snapshotAt = timestamp(
    source.snapshotAt,
    "conversation-activity response.snapshotAt",
  );
  let priorAt = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const events = source.events.map((value, index) => {
    const path = `conversation-activity[${index}]`;
    const event = record(value, path);
    exactKeys(event, ["kind", "at", "title", "meta"], path);
    if (event.kind !== "consent" && event.kind !== "subscription") {
      throw new SmsInboxContractError(`${path}.kind is not supported`);
    }
    const at = timestamp(event.at, `${path}.at`);
    const atMillis = Date.parse(at);
    const title = text(event.title, `${path}.title`, 80);
    if (
      !ACTIVITY_TITLES.has(title) ||
      atMillis > priorAt ||
      atMillis > Date.parse(snapshotAt)
    ) {
      throw new SmsInboxContractError(
        `${path} has invalid title, timestamp, or order`,
      );
    }
    priorAt = atMillis;
    const meta = record(event.meta, `${path}.meta`);
    const idKey = event.kind === "consent" ? "evidenceId" : "listId";
    exactKeys(meta, [idKey, "source"], `${path}.meta`);
    const id = uuid(meta[idKey], `${path}.meta.${idKey}`);
    const sourceToken = token(meta.source, `${path}.meta.source`);
    if (
      (event.kind === "consent" &&
        (!CONSENT_ACTIVITY_TITLES.has(title) ||
          !CONSENT_ACTIVITY_SOURCES.has(sourceToken))) ||
      (event.kind === "subscription" &&
        (CONSENT_ACTIVITY_TITLES.has(title) ||
          !SUBSCRIPTION_ACTIVITY_SOURCES.has(sourceToken)))
    ) {
      throw new SmsInboxContractError(
        `${path} disagrees with its documented evidence plane`,
      );
    }
    const identity = `${event.kind}:${id}`;
    if (seen.has(identity)) {
      throw new SmsInboxContractError(`${path} duplicates evidence identity`);
    }
    seen.add(identity);
    const decodedMeta =
      event.kind === "consent"
        ? { evidenceId: id, source: sourceToken }
        : { listId: id, source: sourceToken };
    return {
      kind: event.kind,
      at,
      title,
      meta: decodedMeta,
    } satisfies SmsConversationActivityEvent;
  });
  return {
    tenantId,
    phoneE164: expected.phoneE164,
    events,
    snapshotAt,
    truncated: source.truncated,
    sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
    historyComplete: false,
  };
}

export function decodeSmsConversationBulkMutation(
  raw: unknown,
  expected: {
    tenantId: string;
    action: SmsConversationBulkAction;
    conversations: ReadonlyArray<{
      phoneE164: string;
      snoozeUntil?: string;
    }>;
  },
): SmsConversationBulkMutationReceipt {
  const source = record(raw, "bulk conversation-state response");
  exactKeys(
    source,
    ["ok", "tenantId", "action", "applied", "receipts"],
    "bulk conversation-state response",
  );
  const tenantId = tenantEnvelope(
    source,
    expected.tenantId,
    "bulk conversation-state response",
  );
  if (
    source.ok !== true ||
    source.action !== expected.action ||
    !Array.isArray(source.receipts) ||
    source.receipts.length !== expected.conversations.length
  ) {
    throw new SmsInboxContractError(
      "bulk conversation-state response has the wrong action or receipt count",
    );
  }
  const applied = integer(
    source.applied,
    "bulk conversation-state response.applied",
  );
  if (applied !== expected.conversations.length) {
    throw new SmsInboxContractError(
      "bulk conversation-state response has a partial applied count",
    );
  }
  const receipts = source.receipts.map((value, index) =>
    decodeSmsConversationStateMutation(value, {
      tenantId,
      phoneE164: expected.conversations[index]!.phoneE164,
      action: expected.action,
      ...(expected.conversations[index]!.snoozeUntil
        ? { snoozeUntil: expected.conversations[index]!.snoozeUntil }
        : {}),
    }),
  );
  return { ok: true, tenantId, action: expected.action, applied, receipts };
}

function messageOptional(row: Record<string, unknown>, path: string) {
  if (row.campaign_id !== undefined)
    uuid(row.campaign_id, `${path}.campaign_id`);
  if (row.sender_profile_id !== undefined) {
    uuid(row.sender_profile_id, `${path}.sender_profile_id`);
  }
  const providerMessageId = optionalText(row, "provider_message_id", path, 256);
  const mediaUrl = optionalText(row, "media_url", path, 4_096);
  const errorCode = optionalText(row, "error_code", path, 128);
  if (errorCode && !TOKEN.test(errorCode))
    throw new SmsInboxContractError(`${path}.error_code is invalid`);
  optionalText(row, "error_message", path, 2_048);
  const dispatchState = optionalText(row, "dispatch_state", path, 128);
  if (dispatchState && !TOKEN.test(dispatchState)) {
    throw new SmsInboxContractError(`${path}.dispatch_state is invalid`);
  }
  const sentAt = optionalTimestamp(row, "sent_at", path);
  const deliveredAt = optionalTimestamp(row, "delivered_at", path);
  const receivedAt = optionalTimestamp(row, "received_at", path);
  return {
    ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(sentAt ? { sent_at: sentAt } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(receivedAt ? { received_at: receivedAt } : {}),
  };
}

export function mergeSmsConversationPages(
  pages: readonly SmsConversationsResponse[],
) {
  if (pages.length === 0)
    return {
      conversations: [],
      snapshotAt: null,
      totalConversations: 0,
      activeTotal: 0,
      snoozedTotal: 0,
      archivedTotal: 0,
      hasMore: false,
    };
  const first = pages[0]!;
  const conversations: SmsConversationSummary[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (
      page.tenantId !== first.tenantId ||
      page.query.filter !== first.query.filter ||
      page.query.sort !== first.query.sort ||
      page.query.status !== first.query.status ||
      [
        "snapshotAt",
        "unreadTotal",
        "unknownTotal",
        "totalConversations",
        "activeTotal",
        "snoozedTotal",
        "archivedTotal",
      ].some(
        (key) =>
          page[key as keyof SmsConversationsResponse] !==
          first[key as keyof SmsConversationsResponse],
      )
    ) {
      throw new SmsInboxContractError(
        "conversation pages cross response cutoffs or totals",
      );
    }
    for (const row of page.conversations) {
      if (
        seen.has(row.phoneE164) ||
        (conversations.at(-1) &&
          conversationOrder(conversations.at(-1)!, row, first.query.sort) > 0)
      ) {
        throw new SmsInboxContractError(
          "conversation pages overlap or are out of order",
        );
      }
      seen.add(row.phoneE164);
      conversations.push(row);
    }
  }
  const statusTotal =
    first.query.status === "any"
      ? first.totalConversations
      : first.query.status === "active"
        ? first.activeTotal
        : first.query.status === "snoozed"
          ? first.snoozedTotal
          : first.archivedTotal;
  if (conversations.length > statusTotal)
    throw new SmsInboxContractError("conversation pages exceed lifecycle total");
  return {
    conversations,
    snapshotAt: first.snapshotAt,
    totalConversations: first.totalConversations,
    activeTotal: first.activeTotal,
    snoozedTotal: first.snoozedTotal,
    archivedTotal: first.archivedTotal,
    hasMore: Boolean(pages.at(-1)?.nextCursor),
  };
}

export function mergeSmsMessagePages(pages: readonly SmsMessagesResponse[]) {
  if (pages.length === 0)
    return { messages: [], snapshotAt: null, hasMore: false };
  const snapshotAt = pages[0]!.snapshotAt;
  const messages: SmsConversationMessage[] = [];
  const seen = new Set<string>();
  let priorAt = Number.POSITIVE_INFINITY;
  let priorId = "";
  for (const page of pages) {
    if (page.tenantId !== pages[0]!.tenantId || page.snapshotAt !== snapshotAt)
      throw new SmsInboxContractError("message pages cross response cutoffs");
    for (const row of page.messages) {
      const at = Date.parse(row.created_at);
      if (
        seen.has(row.id) ||
        at > priorAt ||
        (at === priorAt && priorId && priorId.localeCompare(row.id) < 0)
      ) {
        throw new SmsInboxContractError(
          "message pages overlap or are out of order",
        );
      }
      seen.add(row.id);
      priorAt = at;
      priorId = row.id;
      messages.push(row);
    }
  }
  return { messages, snapshotAt, hasMore: Boolean(pages.at(-1)?.nextCursor) };
}

export function safeSmsText(value: string, maxCodePoints: number): string {
  const clean = value.replace(BIDI_CONTROL, "�");
  const points = Array.from(clean);
  return points.length > maxCodePoints
    ? `${points.slice(0, maxCodePoints).join("")}…`
    : clean;
}

export function smsDeliveryLabel(
  directionValue: "inbound" | "outbound",
  status: string,
): string {
  if (directionValue === "inbound") return "Received";
  const value = status.toLowerCase();
  if (value === "delivered") return "Delivered";
  if (value === "sent") return "Sent — delivery not confirmed";
  if (value === "accepted") return "Accepted by provider";
  if (value === "queued") return "Queued";
  if (["failed", "undelivered", "rejected", "error"].includes(value))
    return "Failed";
  return "Sending or processing — delivery not confirmed";
}

function utf8Bytes(value: string): number {
  let count = 0;
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0;
    count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return count;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
