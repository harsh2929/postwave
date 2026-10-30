// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strict, tenant-bound client for the mounted Helpdesk record-state surface.
 *
 * Deliberately absent from this module: conversation/ticket/macro creation,
 * customer replies and macro-use recording. Those routes are release-held and
 * a catalog token is not authority to call them.
 */
import { api } from "@/lib/api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const RFC3339_NANO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const UNSAFE_DISPLAY_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_CURSOR_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const MIN_TIME = Date.parse("2000-01-01T00:00:00Z");
const MAX_TIME = Date.parse("2100-01-01T00:00:00Z");

export const HELPDESK_STATUSES = [
  "open",
  "pending",
  "waiting",
  "resolved",
  "closed",
  "spam",
  "archived",
] as const;
export const HELPDESK_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
export const HELPDESK_CHANNELS = [
  "web_chat",
  "email",
  "sms",
  "instagram",
  "whatsapp",
  "facebook",
  "generic",
] as const;
export const INTERNAL_NOTE_MAX_BYTES = 16 * 1024;
export const ASSIGNMENT_REASON_MAX_BYTES = 1024;
export const HELPDESK_PAGE_LIMIT = 25;

export type HelpdeskStatus = (typeof HELPDESK_STATUSES)[number];
export type HelpdeskPriority = (typeof HELPDESK_PRIORITIES)[number];
export type HelpdeskChannel = (typeof HELPDESK_CHANNELS)[number];

export class ServiceSuiteOperationsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceSuiteOperationsContractError";
  }
}

export interface HelpdeskPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
  asOf: string;
  consistency: "mutable_window" | "created_at_window";
  mayReorder: true;
}

export interface HelpdeskPage<T> {
  tenantId: string;
  items: T[];
  page: HelpdeskPageInfo;
}

export interface HelpdeskConversation {
  tenantId: string;
  id: string;
  version: string;
  channelId: string | null;
  channelType: HelpdeskChannel;
  sourceType:
    | "manual"
    | "inbound_email"
    | "campaign_reply"
    | "sms"
    | "social"
    | "web_chat"
    | "whatsapp";
  subscriberId: string | null;
  requesterEmail: string | null;
  requesterPhone: string | null;
  requesterName: string | null;
  subject: string | null;
  status: HelpdeskStatus;
  priority: HelpdeskPriority;
  assignedTo: string | null;
  assignedToUserId: string | null;
  assignmentState: "tenant_active_user" | "legacy_unverified" | "unassigned";
  tags: string[];
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HelpdeskMessage {
  tenantId: string;
  id: string;
  conversationId: string;
  sourceType: string | null;
  direction: "inbound" | "outbound" | "internal";
  senderType: "customer" | "agent" | "system" | "ai";
  sender: string | null;
  bodyText: string | null;
  bodyOmittedReason:
    | "html_only"
    | "attachments_only"
    | "source_body_empty"
    | "source_body_unsafe"
    | null;
  recordKind: "internal_note" | "inbound_record" | "outbound_record";
  deliveryStatus: "not_applicable" | "received" | "unverified";
  attachmentCount: number;
  projectionTruncated: boolean;
  sentAt: string;
  createdAt: string;
}

export interface HelpdeskTicket {
  tenantId: string;
  id: string;
  version: string;
  conversationId: string | null;
  ticketNumber: number;
  title: string;
  status: HelpdeskStatus;
  priority: HelpdeskPriority;
  assignmentState: "legacy_unverified" | "unassigned";
  sourceChannel: string;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HelpdeskMacro {
  tenantId: string;
  id: string;
  version: string;
  name: string;
  body: string;
  channelTypes: HelpdeskChannel[];
  tags: string[];
  status: "active" | "archived";
  useCount: number;
  lastUsedAt: string | null;
  usageEvidenceStatus: "unverified";
  createdAt: string;
  updatedAt: string;
}

export interface InternalNoteReceipt {
  message: HelpdeskMessage;
  idempotencyKey: string;
  created: boolean;
  replayed: boolean;
}

export interface ArchiveMacroReceipt {
  id: string;
  previousVersion: string;
  version: string;
  archived: true;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceSuiteOperationsContractError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new ServiceSuiteOperationsContractError(
      `${label} has unsupported or missing fields`,
    );
  }
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ServiceSuiteOperationsContractError(`${label} is not a canonical UUID`);
  }
  return value;
}

function serviceSuiteEntityPath(
  collection: "conversations" | "tickets" | "macros",
  id: string,
): string {
  return `/api/v1/service-suite/${collection}/${encodeURIComponent(id)}`;
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return canonicalUuid(value, label);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function displayText(
  value: unknown,
  label: string,
  maxBytes: number,
  required = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ServiceSuiteOperationsContractError(`${label} is required`);
    }
    return null;
  }
  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    UNSAFE_DISPLAY_RE.test(value) ||
    utf8ByteLength(value) > maxBytes
  ) {
    throw new ServiceSuiteOperationsContractError(`${label} is unsafe or too long`);
  }
  return value;
}

function projectedEmail(value: unknown, label: string): string | null {
  const email = displayText(value, label, 320);
  if (email === null) return null;
  if (email !== email.trim() || email.split("@").length !== 2) {
    throw new ServiceSuiteOperationsContractError(`${label} is invalid`);
  }
  const [local = "", domain = ""] = email.split("@", 2);
  const labels = domain.split(".");
  if (
    local.length < 1 ||
    local.length > 64 ||
    domain.length < 3 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !domain.includes(".") ||
    !/^[A-Za-z0-9._%+-]+$/u.test(local) ||
    labels.some(
      (item) =>
        item.length < 1 ||
        item.length > 63 ||
        item.startsWith("-") ||
        item.endsWith("-") ||
        !/^[A-Za-z0-9-]+$/u.test(item),
    )
  ) {
    throw new ServiceSuiteOperationsContractError(`${label} is invalid`);
  }
  return email;
}

function safeToken<T extends string>(
  value: unknown,
  label: string,
  allowed?: readonly T[],
): T {
  if (
    typeof value !== "string" ||
    !SAFE_TOKEN_RE.test(value) ||
    (allowed && !allowed.includes(value as T))
  ) {
    throw new ServiceSuiteOperationsContractError(`${label} is unsupported`);
  }
  return value as T;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !RFC3339_NANO_UTC_RE.test(value)) {
    throw new ServiceSuiteOperationsContractError(`${label} is not a canonical timestamp`);
  }
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1] ?? null;
  const parsed = Date.parse(value);
  const date = new Date(parsed);
  if (
    (fraction !== null && fraction.endsWith("0")) ||
    !Number.isFinite(parsed) ||
    parsed < MIN_TIME ||
    parsed >= MAX_TIME ||
    date.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new ServiceSuiteOperationsContractError(`${label} is not a canonical timestamp`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return timestamp(value, label);
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxBytes: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ServiceSuiteOperationsContractError(`${label} is invalid`);
  }
  const parsed = value.map((item, index) =>
    displayText(item, `${label}[${index}]`, maxBytes, true),
  ) as string[];
  if (new Set(parsed).size !== parsed.length) {
    throw new ServiceSuiteOperationsContractError(`${label} contains duplicates`);
  }
  return parsed;
}

function tokenList<T extends string>(
  value: unknown,
  label: string,
  maxItems: number,
  allowed: readonly T[],
): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ServiceSuiteOperationsContractError(`${label} is invalid`);
  }
  const parsed = value.map((item, index) =>
    safeToken(item, `${label}[${index}]`, allowed),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new ServiceSuiteOperationsContractError(`${label} contains duplicates`);
  }
  return parsed;
}

function expectedTenant(value: UnknownRecord, tenantId: string, label: string) {
  const expected = canonicalUuid(tenantId, "expected tenant");
  const binding = canonicalUuid(value["tenantId"], `${label}.tenantId`);
  const rowTenant = canonicalUuid(value["tenant_id"], `${label}.tenant_id`);
  if (binding !== expected || rowTenant !== expected) {
    throw new ServiceSuiteOperationsContractError(
      `${label} crossed the active tenant boundary`,
    );
  }
}

function parseConversation(
  value: unknown,
  tenantId: string,
  expectedId?: string,
): HelpdeskConversation {
  const row = record(value, "conversation");
  exactKeys(
    row,
    "conversation",
    [
      "tenantId",
      "tenant_id",
      "id",
      "version",
      "channel_type",
      "source_type",
      "status",
      "priority",
      "assignment_state",
      "created_at",
      "updated_at",
    ],
    [
      "channel_id",
      "subscriber_id",
      "requester_email",
      "requester_phone",
      "requester_name",
      "subject",
      "assigned_to",
      "assigned_to_user_id",
      "tags",
      "last_message_at",
    ],
  );
  expectedTenant(row, tenantId, "conversation");
  const id = canonicalUuid(row["id"], "conversation.id");
  if (expectedId && id !== canonicalUuid(expectedId, "expected conversation id")) {
    throw new ServiceSuiteOperationsContractError("conversation identity changed");
  }
  const version = timestamp(row["version"], "conversation.version");
  const createdAt = timestamp(row["created_at"], "conversation.created_at");
  const updatedAt = timestamp(row["updated_at"], "conversation.updated_at");
  if (version !== updatedAt || Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ServiceSuiteOperationsContractError(
      "conversation version and chronology disagree",
    );
  }
  const assignedTo = optionalUuid(row["assigned_to"], "conversation.assigned_to");
  const assignedToUserId = optionalUuid(
    row["assigned_to_user_id"],
    "conversation.assigned_to_user_id",
  );
  const assignmentState = safeToken(row["assignment_state"], "assignment_state", [
    "tenant_active_user",
    "legacy_unverified",
    "unassigned",
  ] as const);
  const assignmentMatches =
    assignmentState === "tenant_active_user"
      ? assignedTo !== null && assignedTo === assignedToUserId
      : assignedTo === null && assignedToUserId === null;
  if (!assignmentMatches) {
    throw new ServiceSuiteOperationsContractError(
      "conversation assignment projection is inconsistent",
    );
  }
  const lastMessageAt = optionalTimestamp(
    row["last_message_at"],
    "conversation.last_message_at",
  );
  if (lastMessageAt && Date.parse(lastMessageAt) < Date.parse(createdAt)) {
    throw new ServiceSuiteOperationsContractError("conversation chronology is invalid");
  }
  return {
    tenantId,
    id,
    version,
    channelId: optionalUuid(row["channel_id"], "conversation.channel_id"),
    channelType: safeToken(row["channel_type"], "conversation.channel_type", HELPDESK_CHANNELS),
    sourceType: safeToken(row["source_type"], "conversation.source_type", [
      "manual",
      "inbound_email",
      "campaign_reply",
      "sms",
      "social",
      "web_chat",
      "whatsapp",
    ] as const),
    subscriberId: optionalUuid(row["subscriber_id"], "conversation.subscriber_id"),
    requesterEmail: projectedEmail(
      row["requester_email"],
      "conversation.requester_email",
    ),
    requesterPhone: displayText(row["requester_phone"], "conversation.requester_phone", 64),
    requesterName: displayText(row["requester_name"], "conversation.requester_name", 200),
    subject: displayText(row["subject"], "conversation.subject", 500),
    status: safeToken(row["status"], "conversation.status", HELPDESK_STATUSES),
    priority: safeToken(row["priority"], "conversation.priority", HELPDESK_PRIORITIES),
    assignedTo,
    assignedToUserId,
    assignmentState,
    tags: stringList(row["tags"], "conversation.tags", 32, 100),
    lastMessageAt,
    createdAt,
    updatedAt,
  };
}

function parseMessage(
  value: unknown,
  tenantId: string,
  conversationId: string,
): HelpdeskMessage {
  const row = record(value, "message");
  exactKeys(
    row,
    "message",
    [
      "tenantId",
      "tenant_id",
      "id",
      "conversation_id",
      "direction",
      "sender_type",
      "record_kind",
      "delivery_status",
      "attachment_count",
      "projection_truncated",
      "sent_at",
      "created_at",
    ],
    ["source_type", "sender", "body_text", "body_omitted_reason"],
  );
  expectedTenant(row, tenantId, "message");
  const expectedConversation = canonicalUuid(conversationId, "expected conversation id");
  const parsedConversation = canonicalUuid(row["conversation_id"], "message.conversation_id");
  if (parsedConversation !== expectedConversation) {
    throw new ServiceSuiteOperationsContractError("message crossed the conversation boundary");
  }
  const direction = safeToken(row["direction"], "message.direction", [
    "inbound",
    "outbound",
    "internal",
  ] as const);
  const recordKind = safeToken(row["record_kind"], "message.record_kind", [
    "internal_note",
    "inbound_record",
    "outbound_record",
  ] as const);
  const deliveryStatus = safeToken(
    row["delivery_status"],
    "message.delivery_status",
    ["not_applicable", "received", "unverified"] as const,
  );
  const truthMatches =
    (direction === "internal" &&
      recordKind === "internal_note" &&
      deliveryStatus === "not_applicable") ||
    (direction === "inbound" &&
      recordKind === "inbound_record" &&
      deliveryStatus === "received") ||
    (direction === "outbound" &&
      recordKind === "outbound_record" &&
      deliveryStatus === "unverified");
  const bodyText = displayText(row["body_text"], "message.body_text", INTERNAL_NOTE_MAX_BYTES);
  const omitted =
    row["body_omitted_reason"] === undefined ||
    row["body_omitted_reason"] === null ||
    row["body_omitted_reason"] === ""
      ? null
      : safeToken(row["body_omitted_reason"], "message.body_omitted_reason", [
          "html_only",
          "attachments_only",
          "source_body_empty",
          "source_body_unsafe",
        ] as const);
  const attachmentCount = row["attachment_count"];
  const projectionTruncated = row["projection_truncated"];
  const sentAt = timestamp(row["sent_at"], "message.sent_at");
  const createdAt = timestamp(row["created_at"], "message.created_at");
  if (
    !truthMatches ||
    Boolean(bodyText) === Boolean(omitted) ||
    !Number.isSafeInteger(attachmentCount) ||
    Number(attachmentCount) < 0 ||
    Number(attachmentCount) > 64 ||
    typeof projectionTruncated !== "boolean" ||
    ((Number(attachmentCount) > 0 || omitted === "html_only" || omitted === "attachments_only" || omitted === "source_body_unsafe") && !projectionTruncated) ||
    Date.parse(sentAt) > Date.parse(createdAt)
  ) {
    throw new ServiceSuiteOperationsContractError("message truth projection is invalid");
  }
  return {
    tenantId,
    id: canonicalUuid(row["id"], "message.id"),
    conversationId: parsedConversation,
    sourceType:
      row["source_type"] == null
        ? null
        : safeToken(row["source_type"], "message.source_type"),
    direction,
    senderType: safeToken(row["sender_type"], "message.sender_type", [
      "customer",
      "agent",
      "system",
      "ai",
    ] as const),
    sender: displayText(row["sender"], "message.sender", 320),
    bodyText,
    bodyOmittedReason: omitted,
    recordKind,
    deliveryStatus,
    attachmentCount: Number(attachmentCount),
    projectionTruncated,
    sentAt,
    createdAt,
  };
}

function parseTicket(value: unknown, tenantId: string, expectedId?: string): HelpdeskTicket {
  const row = record(value, "ticket");
  exactKeys(
    row,
    "ticket",
    [
      "tenantId",
      "tenant_id",
      "id",
      "version",
      "ticket_number",
      "title",
      "status",
      "priority",
      "assignment_state",
      "created_at",
      "updated_at",
    ],
    ["conversation_id", "assignee", "source_channel", "due_at", "resolved_at"],
  );
  expectedTenant(row, tenantId, "ticket");
  const id = canonicalUuid(row["id"], "ticket.id");
  if (expectedId && id !== canonicalUuid(expectedId, "expected ticket id")) {
    throw new ServiceSuiteOperationsContractError("ticket identity changed");
  }
  const version = timestamp(row["version"], "ticket.version");
  const createdAt = timestamp(row["created_at"], "ticket.created_at");
  const updatedAt = timestamp(row["updated_at"], "ticket.updated_at");
  const dueAt = optionalTimestamp(row["due_at"], "ticket.due_at");
  const resolvedAt = optionalTimestamp(row["resolved_at"], "ticket.resolved_at");
  const ticketNumber = row["ticket_number"];
  const assignee = optionalUuid(row["assignee"], "ticket.assignee");
  const sourceChannel =
    row["source_channel"] == null
      ? "generic"
      : safeToken(row["source_channel"], "ticket.source_channel");
  if (
    version !== updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (dueAt !== null && Date.parse(dueAt) < Date.parse(createdAt)) ||
    (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(createdAt)) ||
    !Number.isSafeInteger(ticketNumber) ||
    Number(ticketNumber) < 1 ||
    assignee !== null
  ) {
    throw new ServiceSuiteOperationsContractError("ticket projection is invalid");
  }
  return {
    tenantId,
    id,
    version,
    conversationId: optionalUuid(row["conversation_id"], "ticket.conversation_id"),
    ticketNumber: Number(ticketNumber),
    title: displayText(row["title"], "ticket.title", 500, true) as string,
    status: safeToken(row["status"], "ticket.status", HELPDESK_STATUSES),
    priority: safeToken(row["priority"], "ticket.priority", HELPDESK_PRIORITIES),
    assignmentState: safeToken(row["assignment_state"], "ticket.assignment_state", [
      "legacy_unverified",
      "unassigned",
    ] as const),
    sourceChannel,
    dueAt,
    resolvedAt,
    createdAt,
    updatedAt,
  };
}

function parseMacro(value: unknown, tenantId: string, expectedId?: string): HelpdeskMacro {
  const row = record(value, "macro");
  exactKeys(
    row,
    "macro",
    [
      "tenantId",
      "tenant_id",
      "id",
      "version",
      "name",
      "body",
      "status",
      "usage_evidence_status",
      "created_at",
      "updated_at",
    ],
    ["channel_types", "tags", "use_count", "last_used_at"],
  );
  expectedTenant(row, tenantId, "macro");
  const id = canonicalUuid(row["id"], "macro.id");
  if (expectedId && id !== canonicalUuid(expectedId, "expected macro id")) {
    throw new ServiceSuiteOperationsContractError("macro identity changed");
  }
  const version = timestamp(row["version"], "macro.version");
  const createdAt = timestamp(row["created_at"], "macro.created_at");
  const updatedAt = timestamp(row["updated_at"], "macro.updated_at");
  const lastUsedAt = optionalTimestamp(row["last_used_at"], "macro.last_used_at");
  const useCount = row["use_count"] ?? 0;
  if (
    version !== updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (lastUsedAt !== null && Date.parse(lastUsedAt) < Date.parse(createdAt)) ||
    !Number.isSafeInteger(useCount) ||
    Number(useCount) < 0 ||
    row["usage_evidence_status"] !== "unverified"
  ) {
    throw new ServiceSuiteOperationsContractError("macro projection is invalid");
  }
  return {
    tenantId,
    id,
    version,
    name: displayText(row["name"], "macro.name", 200, true) as string,
    body: displayText(row["body"], "macro.body", INTERNAL_NOTE_MAX_BYTES, true) as string,
    channelTypes: tokenList(
      row["channel_types"],
      "macro.channel_types",
      HELPDESK_CHANNELS.length,
      HELPDESK_CHANNELS,
    ),
    tags: stringList(row["tags"], "macro.tags", 32, 100),
    status: safeToken(row["status"], "macro.status", ["active", "archived"] as const),
    useCount: Number(useCount),
    lastUsedAt,
    usageEvidenceStatus: "unverified",
    createdAt,
    updatedAt,
  };
}

function parseCursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    UNSAFE_CURSOR_RE.test(value)
  ) {
    throw new ServiceSuiteOperationsContractError("page cursor is unsafe");
  }
  return value;
}

function parsePageInfo(
  value: unknown,
  consistency: HelpdeskPageInfo["consistency"],
): HelpdeskPageInfo {
  const row = record(value, "page");
  exactKeys(row, "page", [
    "has_more",
    "next_cursor",
    "as_of",
    "consistency",
    "may_reorder",
  ]);
  const cursor = parseCursor(row["next_cursor"]);
  if (
    typeof row["has_more"] !== "boolean" ||
    row["has_more"] !== (cursor !== null) ||
    row["consistency"] !== consistency ||
    row["may_reorder"] !== true
  ) {
    throw new ServiceSuiteOperationsContractError("page receipt is inconsistent");
  }
  return {
    hasMore: row["has_more"],
    nextCursor: cursor,
    asOf: timestamp(row["as_of"], "page.as_of"),
    consistency,
    mayReorder: true,
  };
}

function parsePage<T>(
  value: unknown,
  tenantId: string,
  consistency: HelpdeskPageInfo["consistency"],
  parseItem: (item: unknown) => T,
): HelpdeskPage<T> {
  const row = record(value, "collection");
  exactKeys(row, "collection", ["tenantId", "items", "page"]);
  if (canonicalUuid(row["tenantId"], "collection.tenantId") !== tenantId) {
    throw new ServiceSuiteOperationsContractError("collection crossed the active tenant boundary");
  }
  if (!Array.isArray(row["items"]) || row["items"].length > 100) {
    throw new ServiceSuiteOperationsContractError("collection items are invalid");
  }
  const items = row["items"].map(parseItem);
  if (new Set(items.map((item) => (item as { id?: unknown }).id)).size !== items.length) {
    throw new ServiceSuiteOperationsContractError("collection contains duplicate identities");
  }
  const page = parsePageInfo(row["page"], consistency);
  if (page.hasMore && items.length === 0) {
    throw new ServiceSuiteOperationsContractError("empty collection claims a continuation");
  }
  return { tenantId, items, page };
}

function listOptions(
  limit: number,
  cursor: string | null | undefined,
): { limit: number; cursor?: string } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ServiceSuiteOperationsContractError("limit must be an integer from 1 to 100");
  }
  return { limit, ...(cursor ? { cursor: parseCursor(cursor) as string } : {}) };
}

function quotedVersion(value: string): string {
  return `"${timestamp(value, "version")}"`;
}

function readReceipt(
  response: Response,
): { status: number; etag: string | null; replayed: string | null } {
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    replayed: response.headers.get("idempotency-replayed"),
  };
}

function requireEntityReceipt(
  receipt: ReturnType<typeof readReceipt> | null,
  version: string,
  expectedStatus = 200,
): void {
  if (
    !receipt ||
    receipt.status !== expectedStatus ||
    receipt.etag !== quotedVersion(version)
  ) {
    throw new ServiceSuiteOperationsContractError("mutation receipt did not match the returned version");
  }
}

export async function listHelpdeskConversations(args: {
  tenantId: string;
  status?: HelpdeskStatus;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<HelpdeskPage<HelpdeskConversation>> {
  canonicalUuid(args.tenantId, "tenantId");
  const paging = listOptions(args.limit ?? HELPDESK_PAGE_LIMIT, args.cursor);
  const status = args.status
    ? safeToken(args.status, "status", HELPDESK_STATUSES)
    : undefined;
  const raw = await api.get<unknown>("/api/v1/service-suite/conversations", {
    query: { ...paging, status },
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return parsePage(raw, args.tenantId, "mutable_window", (item) =>
    parseConversation(item, args.tenantId),
  );
}

export async function getHelpdeskConversation(args: {
  tenantId: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<HelpdeskConversation> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.conversationId, "conversationId");
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.get<unknown>(serviceSuiteEntityPath("conversations", id), {
    ...(args.signal ? { signal: args.signal } : {}),
    onResponse: (response) => {
      receipt = readReceipt(response);
    },
  });
  const parsed = parseConversation(raw, args.tenantId, id);
  requireEntityReceipt(receipt, parsed.version);
  return parsed;
}

export async function listHelpdeskMessages(args: {
  tenantId: string;
  conversationId: string;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<HelpdeskPage<HelpdeskMessage>> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.conversationId, "conversationId");
  const order = args.order ?? "desc";
  const paging = listOptions(args.limit ?? HELPDESK_PAGE_LIMIT, args.cursor);
  const raw = await api.get<unknown>(
    `${serviceSuiteEntityPath("conversations", id)}/messages`,
    {
      query: { ...paging, order },
      ...(args.signal ? { signal: args.signal } : {}),
    },
  );
  const parsed = parsePage(raw, args.tenantId, "created_at_window", (item) =>
    parseMessage(item, args.tenantId, id),
  );
  const sortable = (message: HelpdeskMessage) =>
    `${message.sentAt.replace(/(?:\.(\d+))?Z$/u, (_m, fraction?: string) =>
      `.${(fraction ?? "").padEnd(9, "0")}Z`,
    )}\u0000${message.id}`;
  for (let index = 1; index < parsed.items.length; index += 1) {
    const previous = sortable(parsed.items[index - 1] as HelpdeskMessage);
    const current = sortable(parsed.items[index] as HelpdeskMessage);
    if ((order === "desc" && previous < current) || (order === "asc" && previous > current)) {
      throw new ServiceSuiteOperationsContractError(
        "message page is not in its declared deterministic order",
      );
    }
  }
  return parsed;
}

export async function listHelpdeskTickets(args: {
  tenantId: string;
  status?: HelpdeskStatus;
  conversationId?: string;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<HelpdeskPage<HelpdeskTicket>> {
  canonicalUuid(args.tenantId, "tenantId");
  const status = args.status
    ? safeToken(args.status, "status", HELPDESK_STATUSES)
    : undefined;
  const conversationId = args.conversationId
    ? canonicalUuid(args.conversationId, "conversationId")
    : undefined;
  const paging = listOptions(args.limit ?? HELPDESK_PAGE_LIMIT, args.cursor);
  const raw = await api.get<unknown>("/api/v1/service-suite/tickets", {
    query: { ...paging, status, conversation_id: conversationId },
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const parsed = parsePage(raw, args.tenantId, "mutable_window", (item) =>
    parseTicket(item, args.tenantId),
  );
  if (
    conversationId &&
    parsed.items.some((ticket) => ticket.conversationId !== conversationId)
  ) {
    throw new ServiceSuiteOperationsContractError(
      "ticket collection crossed the requested conversation boundary",
    );
  }
  return parsed;
}

export async function listHelpdeskMacros(args: {
  tenantId: string;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<HelpdeskPage<HelpdeskMacro>> {
  canonicalUuid(args.tenantId, "tenantId");
  const paging = listOptions(args.limit ?? HELPDESK_PAGE_LIMIT, args.cursor);
  const raw = await api.get<unknown>("/api/v1/service-suite/macros", {
    query: paging,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return parsePage(raw, args.tenantId, "mutable_window", (item) =>
    parseMacro(item, args.tenantId),
  );
}

function validateNewVersion(previous: string, next: string, label: string): void {
  if (next === timestamp(previous, `${label}.previousVersion`)) {
    throw new ServiceSuiteOperationsContractError(`${label} did not advance its version`);
  }
}

export async function assignHelpdeskConversation(args: {
  tenantId: string;
  conversationId: string;
  version: string;
  action: "assign_self" | "unassign";
  reason?: string;
}): Promise<HelpdeskConversation> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.conversationId, "conversationId");
  const reason = args.reason?.trim() ?? "";
  const reasonError = assignmentReasonValidationError(reason);
  if (reasonError) throw new ServiceSuiteOperationsContractError(reasonError);
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.post<unknown>(
    `${serviceSuiteEntityPath("conversations", id)}/assign`,
    { action: args.action, ...(reason ? { reason } : {}) },
    {
      headers: { "If-Match": quotedVersion(args.version) },
      requireOnline: true,
      maxAttempts: 1,
      onResponse: (response) => {
        receipt = readReceipt(response);
      },
    },
  );
  const parsed = parseConversation(raw, args.tenantId, id);
  requireEntityReceipt(receipt, parsed.version);
  validateNewVersion(args.version, parsed.version, "conversation assignment");
  return parsed;
}

export async function setHelpdeskConversationStatus(args: {
  tenantId: string;
  conversationId: string;
  version: string;
  status: HelpdeskStatus;
}): Promise<HelpdeskConversation> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.conversationId, "conversationId");
  const status = safeToken(args.status, "status", HELPDESK_STATUSES);
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.post<unknown>(
    `${serviceSuiteEntityPath("conversations", id)}/status`,
    { status },
    {
      headers: { "If-Match": quotedVersion(args.version) },
      requireOnline: true,
      maxAttempts: 1,
      onResponse: (response) => {
        receipt = readReceipt(response);
      },
    },
  );
  const parsed = parseConversation(raw, args.tenantId, id);
  requireEntityReceipt(receipt, parsed.version);
  validateNewVersion(args.version, parsed.version, "conversation status");
  return parsed;
}

export function internalNoteValidationError(value: string): string | null {
  const body = value.trim();
  if (!body) return "Enter a private internal note.";
  if (UNSAFE_DISPLAY_RE.test(body)) {
    return "Internal notes cannot contain unsafe control, bidi, or zero-width characters.";
  }
  const bytes = utf8ByteLength(body);
  return bytes > INTERNAL_NOTE_MAX_BYTES
    ? `Internal notes must not exceed 16 KiB after UTF-8 encoding (${bytes.toLocaleString()} bytes entered).`
    : null;
}

export function assignmentReasonValidationError(value: string): string | null {
  const reason = value.trim();
  if (UNSAFE_DISPLAY_RE.test(reason)) {
    return "Assignment reason cannot contain unsafe control, bidi, or zero-width characters.";
  }
  const bytes = utf8ByteLength(reason);
  return bytes > ASSIGNMENT_REASON_MAX_BYTES
    ? `Assignment reason must not exceed 1,024 UTF-8 bytes (${bytes.toLocaleString()} bytes entered).`
    : null;
}

export function newInternalNoteKey(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value || !UUID_RE.test(value.toLowerCase())) {
    throw new ServiceSuiteOperationsContractError(
      "A secure idempotency key could not be generated",
    );
  }
  return `helpdesk-note-${value.toLowerCase()}`;
}

export async function createHelpdeskInternalNote(args: {
  tenantId: string;
  conversationId: string;
  bodyText: string;
  idempotencyKey: string;
}): Promise<InternalNoteReceipt> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.conversationId, "conversationId");
  const body = args.bodyText.trim();
  const validation = internalNoteValidationError(body);
  if (validation) throw new ServiceSuiteOperationsContractError(validation);
  if (
    typeof args.idempotencyKey !== "string" ||
    args.idempotencyKey.length < 1 ||
    utf8ByteLength(args.idempotencyKey) > 255 ||
    args.idempotencyKey.trim() !== args.idempotencyKey ||
    UNSAFE_CURSOR_RE.test(args.idempotencyKey)
  ) {
    throw new ServiceSuiteOperationsContractError("Idempotency key is invalid");
  }
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.post<unknown>(
    `${serviceSuiteEntityPath("conversations", id)}/internal-notes`,
    { body_text: body },
    {
      idempotencyKey: args.idempotencyKey,
      requireOnline: true,
      maxAttempts: 1,
      onResponse: (response) => {
        receipt = readReceipt(response);
      },
    },
  );
  const message = parseMessage(raw, args.tenantId, id);
  const noteReceipt = receipt as ReturnType<typeof readReceipt> | null;
  if (
    !noteReceipt ||
    (noteReceipt.status !== 201 && noteReceipt.status !== 200) ||
    (noteReceipt.status === 201 && noteReceipt.replayed !== null) ||
    (noteReceipt.status === 200 && noteReceipt.replayed !== "true") ||
    message.direction !== "internal" ||
    message.bodyText !== body
  ) {
    throw new ServiceSuiteOperationsContractError(
      "internal-note receipt did not match the committed note",
    );
  }
  return {
    message,
    idempotencyKey: args.idempotencyKey,
    created: noteReceipt.status === 201,
    replayed: noteReceipt.status === 200,
  };
}

export interface TicketPatchInput {
  title?: string;
  status?: HelpdeskStatus;
  priority?: HelpdeskPriority;
  dueAt?: string | null;
  resolvedAt?: string | null;
}

function ticketPatch(input: TicketPatchInput): UnknownRecord {
  const patch: UnknownRecord = {};
  if (input.title !== undefined) {
    patch["title"] = displayText(input.title.trim(), "ticket.title", 500, true);
  }
  if (input.status !== undefined) {
    patch["status"] = safeToken(input.status, "ticket.status", HELPDESK_STATUSES);
  }
  if (input.priority !== undefined) {
    patch["priority"] = safeToken(input.priority, "ticket.priority", HELPDESK_PRIORITIES);
  }
  if (input.dueAt !== undefined) {
    patch["due_at"] = input.dueAt === null ? null : timestamp(input.dueAt, "ticket.due_at");
  }
  if (input.resolvedAt !== undefined) {
    patch["resolved_at"] =
      input.resolvedAt === null ? null : timestamp(input.resolvedAt, "ticket.resolved_at");
  }
  if (Object.keys(patch).length === 0) {
    throw new ServiceSuiteOperationsContractError("Ticket update has no changes");
  }
  return patch;
}

export async function patchHelpdeskTicket(args: {
  tenantId: string;
  ticketId: string;
  version: string;
  patch: TicketPatchInput;
}): Promise<HelpdeskTicket> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.ticketId, "ticketId");
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.patch<unknown>(
    serviceSuiteEntityPath("tickets", id),
    ticketPatch(args.patch),
    {
      headers: { "If-Match": quotedVersion(args.version) },
      requireOnline: true,
      maxAttempts: 1,
      onResponse: (response) => {
        receipt = readReceipt(response);
      },
    },
  );
  const parsed = parseTicket(raw, args.tenantId, id);
  requireEntityReceipt(receipt, parsed.version);
  validateNewVersion(args.version, parsed.version, "ticket");
  return parsed;
}

export interface MacroPatchInput {
  name?: string;
  body?: string;
  status?: "active" | "archived";
  channelTypes?: HelpdeskChannel[];
  tags?: string[];
}

function macroPatch(input: MacroPatchInput): UnknownRecord {
  const patch: UnknownRecord = {};
  if (input.name !== undefined) {
    patch["name"] = displayText(input.name.trim(), "macro.name", 200, true);
  }
  if (input.body !== undefined) {
    patch["body"] = displayText(input.body.trim(), "macro.body", INTERNAL_NOTE_MAX_BYTES, true);
  }
  if (input.status !== undefined) {
    patch["status"] = safeToken(input.status, "macro.status", ["active", "archived"] as const);
  }
  if (input.channelTypes !== undefined) {
    patch["channel_types"] = tokenList(
      input.channelTypes,
      "macro.channel_types",
      HELPDESK_CHANNELS.length,
      HELPDESK_CHANNELS,
    );
  }
  if (input.tags !== undefined) {
    patch["tags"] = stringList(input.tags, "macro.tags", 32, 100);
  }
  if (Object.keys(patch).length === 0) {
    throw new ServiceSuiteOperationsContractError("Macro update has no changes");
  }
  return patch;
}

export async function patchHelpdeskMacro(args: {
  tenantId: string;
  macroId: string;
  version: string;
  patch: MacroPatchInput;
}): Promise<HelpdeskMacro> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.macroId, "macroId");
  let receipt: ReturnType<typeof readReceipt> | null = null;
  const raw = await api.patch<unknown>(
    serviceSuiteEntityPath("macros", id),
    macroPatch(args.patch),
    {
      headers: { "If-Match": quotedVersion(args.version) },
      requireOnline: true,
      maxAttempts: 1,
      onResponse: (response) => {
        receipt = readReceipt(response);
      },
    },
  );
  const parsed = parseMacro(raw, args.tenantId, id);
  requireEntityReceipt(receipt, parsed.version);
  validateNewVersion(args.version, parsed.version, "macro");
  return parsed;
}

export async function archiveHelpdeskMacro(args: {
  tenantId: string;
  macroId: string;
  version: string;
}): Promise<ArchiveMacroReceipt> {
  canonicalUuid(args.tenantId, "tenantId");
  const id = canonicalUuid(args.macroId, "macroId");
  let receipt: ReturnType<typeof readReceipt> | null = null;
  await api.delete<unknown>(serviceSuiteEntityPath("macros", id), {
    headers: { "If-Match": quotedVersion(args.version) },
    requireOnline: true,
    maxAttempts: 1,
    onResponse: (response) => {
      receipt = readReceipt(response);
    },
  });
  const archiveReceipt = receipt as ReturnType<typeof readReceipt> | null;
  if (!archiveReceipt || archiveReceipt.status !== 204 || !archiveReceipt.etag) {
    throw new ServiceSuiteOperationsContractError("macro archive receipt is missing");
  }
  const match = /^"([^"]+)"$/u.exec(archiveReceipt.etag);
  const version = match ? timestamp(match[1], "macro archive version") : null;
  if (!version) {
    throw new ServiceSuiteOperationsContractError("macro archive ETag is invalid");
  }
  validateNewVersion(args.version, version, "macro archive");
  return { id, previousVersion: args.version, version, archived: true };
}
