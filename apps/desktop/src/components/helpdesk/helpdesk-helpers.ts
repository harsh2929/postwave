/**
 * helpdesk-helpers — pure logic behind HelpdeskInbox (Klaviyo-parity KLV-10).
 *
 * Extracted so the conversion-sensitive bits are unit-tested in isolation:
 *
 *   1. htmlToText: bodies render as TEXT — NEVER dangerouslySetInnerHTML.
 *      When a message only carries body_html we strip tags to readable
 *      plain text (block tags → newlines, list items → bullets, entities
 *      decoded for the common five). The output is plain text destined
 *      for a <div> text node, so there is no XSS surface.
 *   2. messageText: prefer body_text; fall back to stripped body_html;
 *      never invent a body — empty stays empty so the UI can show a
 *      muted "(no text)" placeholder instead of a fabricated string.
 *   3. requesterLabel: name || email || phone || "Unknown" — honest, no
 *      blank rows.
 *   4. statusChips: catalog statuses (deduped, blanks dropped) prefixed
 *      with the synthetic "All" sentinel.
 */

import type {
  ServiceConversation,
  ServiceMessage,
  ServiceTicket,
} from "../../lib/api-client";

export interface DecodedCollection<T> {
  items: T[];
  /** Rows rejected because their identity/tenant/shape was not trustworthy. */
  rejected: number;
  /** The envelope itself was not the documented `{ items: [] }` shape. */
  envelopeError: string | null;
  page: {
    hasMore: boolean;
    nextCursor: string | null;
    asOf: string;
    consistency: string;
    mayReorder: boolean;
  } | null;
}

export interface RecordedDueDateDescriptor {
  kind: "unknown" | "future" | "due-soon" | "past-due" | "resolved";
  label: string;
  detail: string;
}

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATUS_ROUTE_TOKEN_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CHANNEL_TYPES = new Set([
  "web_chat",
  "email",
  "sms",
  "instagram",
  "whatsapp",
  "facebook",
  "generic",
]);
const SOURCE_TYPES = new Set([
  "manual",
  "inbound_email",
  "campaign_reply",
  "sms",
  "social",
  "web_chat",
  "whatsapp",
]);
const CONVERSATION_STATUSES = new Set([
  "open",
  "pending",
  "waiting",
  "resolved",
  "closed",
  "spam",
  "archived",
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const SENDER_TYPES = new Set(["customer", "agent", "system", "ai"]);
const BODY_OMISSION_REASONS = new Set([
  "html_only",
  "attachments_only",
  "source_body_empty",
  "source_body_unsafe",
]);
const PROJECTION_MIN_MS = Date.parse("2000-01-01T00:00:00Z");
const PROJECTION_MAX_MS = Date.parse("2100-01-01T00:00:00Z");

export function isCanonicalHelpdeskId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

export function isSafeHelpdeskStatusRouteValue(
  value: unknown,
): value is string {
  return typeof value === "string" && STATUS_ROUTE_TOKEN_RE.test(value);
}

type UnknownRecord = Record<string, unknown>;

// Display text may contain ordinary tab/newline/carriage-return formatting.
// Reject the remaining C0/C1 controls plus invisible/bidi formatting that can
// disguise identities, statuses, or message content in an operator surface.
const CONTROL_OR_BIDI_OVERRIDE_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const OPAQUE_CURSOR_POISON_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const RFC3339_NANO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function isSafeOpaqueHelpdeskCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !OPAQUE_CURSOR_POISON_RE.test(value)
  );
}

function hasExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function displayString(
  value: unknown,
  maxBytes: number,
  required = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    return required ? null : "";
  }
  if (typeof value !== "string") return null;
  if (
    (required && !value.trim()) ||
    utf8ByteLength(value) > maxBytes ||
    CONTROL_OR_BIDI_OVERRIDE_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function safeToken(
  value: unknown,
  allowedValues?: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string" || !SAFE_TOKEN_RE.test(value)) return null;
  return !allowedValues || allowedValues.has(value) ? value : null;
}

function optionalCanonicalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  return isCanonicalHelpdeskId(value) ? value : null;
}

function strictDisplayStringArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = displayString(item, maxBytes, true);
    if (text === null || seen.has(text)) return null;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function tenantMatches(row: UnknownRecord, expectedTenantId: string): boolean {
  if (!isCanonicalHelpdeskId(expectedTenantId)) return false;
  const binding = isCanonicalHelpdeskId(row.tenantId) ? row.tenantId : null;
  const tenant = isCanonicalHelpdeskId(row.tenant_id) ? row.tenant_id : null;
  return (
    binding !== null &&
    tenant !== null &&
    binding === expectedTenantId &&
    tenant === expectedTenantId
  );
}

function projectedEmail(value: unknown): string | null {
  const email = displayString(value, 320);
  if (email === null || email === "") return email;
  if (email !== email.trim() || email.split("@").length !== 2) return null;
  const [local = "", domain = ""] = email.split("@", 2);
  if (
    local.length < 1 ||
    local.length > 64 ||
    domain.length < 3 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !domain.includes(".") ||
    !/^[A-Za-z0-9._%+-]+$/u.test(local)
  ) {
    return null;
  }
  const labels = domain.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      !label.startsWith("-") &&
      !label.endsWith("-") &&
      /^[A-Za-z0-9-]+$/u.test(label),
  )
    ? email
    : null;
}

/** Strictly decode one tenant-owned conversation. Unknown or cross-tenant
 * rows fail closed instead of reaching JSX and crashing on string methods. */
export function decodeConversation(
  value: unknown,
  expectedTenantId: string,
): ServiceConversation | null {
  const row = record(value);
  if (!row || !tenantMatches(row, expectedTenantId)) return null;
  const id = isCanonicalHelpdeskId(row.id) ? row.id : null;
  const version = strictProjectionTimestamp(row.version);
  const channelType = safeToken(row.channel_type, CHANNEL_TYPES);
  const sourceType = safeToken(row.source_type, SOURCE_TYPES);
  const status = safeToken(row.status, CONVERSATION_STATUSES);
  const priority = safeToken(row.priority, PRIORITIES);
  const lastMessageAt = strictProjectionTimestamp(row.last_message_at, true);
  const createdAt = strictProjectionTimestamp(row.created_at);
  const updatedAt = strictProjectionTimestamp(row.updated_at);
  const tags = strictDisplayStringArray(row.tags, 32, 100);
  const optionals = {
    channel_id: optionalCanonicalUuid(row.channel_id),
    subscriber_id: optionalCanonicalUuid(row.subscriber_id),
    requester_email: projectedEmail(row.requester_email),
    requester_phone: displayString(row.requester_phone, 64),
    requester_name: displayString(row.requester_name, 200),
    subject: displayString(row.subject, 500),
    assigned_to: optionalCanonicalUuid(row.assigned_to),
  };
  const assignedToUserId =
    row.assigned_to_user_id === undefined ||
    row.assigned_to_user_id === null ||
    row.assigned_to_user_id === ""
      ? ""
      : isCanonicalHelpdeskId(row.assigned_to_user_id)
        ? row.assigned_to_user_id
        : null;
  const assignmentState = safeToken(row.assignment_state);
  const assignmentIsConsistent =
    assignmentState === "tenant_active_user"
      ? Boolean(
          assignedToUserId &&
          optionals.assigned_to &&
          assignedToUserId === optionals.assigned_to,
        )
      : (assignmentState === "unassigned" ||
          assignmentState === "legacy_unverified") &&
        assignedToUserId === "" &&
        optionals.assigned_to === "";
  if (
    !id ||
    !version ||
    !channelType ||
    !sourceType ||
    !status ||
    !priority ||
    lastMessageAt === false ||
    !createdAt ||
    !updatedAt ||
    version !== updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    tags === null ||
    assignedToUserId === null ||
    !assignmentIsConsistent ||
    Object.values(optionals).some((item) => item === null)
  ) {
    return null;
  }
  return {
    id,
    tenantId: expectedTenantId,
    tenant_id: expectedTenantId,
    version,
    channel_type: channelType,
    source_type: sourceType,
    status,
    priority,
    last_message_at: lastMessageAt,
    tags,
    assignment_state:
      assignmentState as ServiceConversation["assignment_state"],
    ...(assignedToUserId ? { assigned_to_user_id: assignedToUserId } : {}),
    created_at: createdAt,
    updated_at: updatedAt,
    ...Object.fromEntries(
      Object.entries(optionals).filter(([, item]) => item !== ""),
    ),
  } as ServiceConversation;
}

export function decodeConversationList(
  value: unknown,
  expectedTenantId: string,
): DecodedCollection<ServiceConversation> {
  return decodeItems(value, expectedTenantId, (item) =>
    decodeConversation(item, expectedTenantId),
  );
}

export function decodeMessageList(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
  order: "desc" | "asc" = "desc",
): DecodedCollection<ServiceMessage> {
  const decoded = decodeItems(
    value,
    expectedTenantId,
    (value) => decodeMessage(value, expectedTenantId, expectedConversationId),
    "created_at_window",
  );
  if (decoded.envelopeError || !decoded.page) return decoded;

  // A partially accepted thread can manufacture a false chronology. Hold the
  // complete page if any row, identity, timestamp, or body projection fails.
  if (decoded.rejected > 0) {
    return {
      ...decoded,
      items: [],
      envelopeError:
        "One or more messages failed the protected message contract, so this page was withheld.",
    };
  }

  const seen = new Set<string>();
  for (let index = 0; index < decoded.items.length; index += 1) {
    const current = decoded.items[index];
    if (!current?.id || seen.has(current.id)) {
      return {
        ...decoded,
        items: [],
        envelopeError:
          "The message page contained a missing or duplicate identity and was withheld.",
      };
    }
    seen.add(current.id);
    if (index > 0) {
      const previous = decoded.items[index - 1];
      if (previous && compareMessages(previous, current, order) > 0) {
        return {
          ...decoded,
          items: [],
          envelopeError:
            "The message page was not in the server-declared deterministic order and was withheld.",
        };
      }
    }
  }
  if (decoded.page.hasMore && decoded.items.length === 0) {
    return {
      ...decoded,
      envelopeError:
        "The message page claimed older rows after returning an empty window and was withheld.",
    };
  }
  return decoded;
}

export function decodeMessage(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
): ServiceMessage | null {
  const row = record(value);
  if (!row || !tenantMatches(row, expectedTenantId)) return null;
  const id = isCanonicalHelpdeskId(row.id) ? row.id : null;
  const conversationId = isCanonicalHelpdeskId(row.conversation_id)
    ? row.conversation_id
    : null;
  const direction = safeToken(row.direction);
  const senderType = safeToken(row.sender_type, SENDER_TYPES);
  const sourceType = safeToken(row.source_type);
  const sender = displayString(row.sender, 320);
  const bodyText = boundedUtf8DisplayString(
    row.body_text,
    INTERNAL_NOTE_MAX_BYTES,
  );
  const recordKind = safeToken(row.record_kind);
  const deliveryStatus = safeToken(row.delivery_status);
  const bodyOmittedReason =
    row.body_omitted_reason === undefined ||
    row.body_omitted_reason === null ||
    row.body_omitted_reason === ""
      ? ""
      : safeToken(row.body_omitted_reason, BODY_OMISSION_REASONS);
  const attachmentCount = row.attachment_count;
  const projectionTruncated = row.projection_truncated;
  const sentAt = strictProjectionTimestamp(row.sent_at);
  const createdAt = strictProjectionTimestamp(row.created_at);
  const hasBody = Boolean(bodyText);
  const hasOmission = Boolean(bodyOmittedReason);
  if (
    !id ||
    !conversationId ||
    conversationId !== expectedConversationId ||
    !direction ||
    !["inbound", "outbound", "internal"].includes(direction) ||
    !senderType ||
    !sourceType ||
    sender === null ||
    bodyText === null ||
    !recordKind ||
    !deliveryStatus ||
    bodyOmittedReason === null ||
    hasBody === hasOmission ||
    !Number.isSafeInteger(attachmentCount) ||
    Number(attachmentCount) < 0 ||
    typeof projectionTruncated !== "boolean" ||
    ((Number(attachmentCount) > 0 ||
      bodyOmittedReason === "html_only" ||
      bodyOmittedReason === "attachments_only" ||
      bodyOmittedReason === "source_body_unsafe") &&
      projectionTruncated !== true) ||
    !messageTruthMatches(direction, recordKind, deliveryStatus) ||
    !sentAt ||
    !createdAt ||
    Date.parse(sentAt) > Date.parse(createdAt)
  ) {
    return null;
  }
  return {
    id,
    tenantId: expectedTenantId,
    tenant_id: expectedTenantId,
    conversation_id: conversationId,
    direction,
    sender_type: senderType,
    source_type: sourceType,
    ...(sender ? { sender } : {}),
    ...(bodyText ? { body_text: bodyText } : {}),
    record_kind: recordKind,
    delivery_status: deliveryStatus,
    attachment_count: Number(attachmentCount),
    projection_truncated: projectionTruncated,
    ...(bodyOmittedReason ? { body_omitted_reason: bodyOmittedReason } : {}),
    sent_at: sentAt,
    created_at: createdAt,
  };
}

function boundedUtf8DisplayString(
  value: unknown,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  if (!value.trim()) return "";
  if (
    CONTROL_OR_BIDI_OVERRIDE_RE.test(value) ||
    utf8ByteLength(value) > maxBytes
  ) {
    return null;
  }
  return value;
}

function strictProjectionTimestamp(
  value: unknown,
  optional = false,
): string | null | false {
  if (value === undefined || value === null || value === "") {
    return optional ? null : false;
  }
  if (typeof value !== "string" || !RFC3339_NANO_UTC_RE.test(value)) {
    return false;
  }
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1] ?? null;
  const parsed = Date.parse(value);
  const parsedDate = new Date(parsed);
  if (
    (fraction !== null && fraction.endsWith("0")) ||
    !Number.isFinite(parsed) ||
    parsed < PROJECTION_MIN_MS ||
    parsed >= PROJECTION_MAX_MS ||
    parsedDate.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return false;
  }
  return value;
}

function messageTimestamp(message: ServiceMessage): string {
  return message.sent_at ?? message.created_at ?? "";
}

function sortableTimestamp(value: string): string {
  return value.replace(
    /(?:\.(\d+))?Z$/u,
    (_match, fraction?: string) => `.${(fraction ?? "").padEnd(9, "0")}Z`,
  );
}

function compareMessages(
  left: ServiceMessage,
  right: ServiceMessage,
  order: "desc" | "asc",
): number {
  const direction = order === "desc" ? -1 : 1;
  const byTime = sortableTimestamp(messageTimestamp(left)).localeCompare(
    sortableTimestamp(messageTimestamp(right)),
  );
  return (byTime || (left.id ?? "").localeCompare(right.id ?? "")) * direction;
}

function messageTruthMatches(
  direction: string,
  recordKind: string,
  deliveryStatus: string,
): boolean {
  if (direction === "internal") {
    return (
      recordKind === "internal_note" && deliveryStatus === "not_applicable"
    );
  }
  if (direction === "inbound") {
    return recordKind === "inbound_record" && deliveryStatus === "received";
  }
  return (
    direction === "outbound" &&
    recordKind === "outbound_record" &&
    deliveryStatus === "unverified"
  );
}

export function isVerifiedInternalNote(message: ServiceMessage): boolean {
  return (
    message.direction === "internal" &&
    message.record_kind === "internal_note" &&
    message.delivery_status === "not_applicable"
  );
}

export function decodeTicketList(
  value: unknown,
  expectedTenantId: string,
): DecodedCollection<ServiceTicket> {
  return decodeItems(value, expectedTenantId, (value) => {
    const row = record(value);
    if (!row || !tenantMatches(row, expectedTenantId)) return null;
    const id = isCanonicalHelpdeskId(row.id) ? row.id : null;
    const conversationId =
      row.conversation_id === undefined || row.conversation_id === null
        ? ""
        : isCanonicalHelpdeskId(row.conversation_id)
          ? row.conversation_id
          : null;
    const version = strictProjectionTimestamp(row.version);
    const title = displayString(row.title, 500, true);
    const status = safeToken(row.status, CONVERSATION_STATUSES);
    const priority = safeToken(row.priority, PRIORITIES);
    const assignee = displayString(row.assignee, 320);
    const assignmentState = safeToken(row.assignment_state);
    const sourceChannel = safeToken(row.source_channel);
    const dueAt = strictProjectionTimestamp(row.due_at, true);
    const resolvedAt = strictProjectionTimestamp(row.resolved_at, true);
    const createdAt = strictProjectionTimestamp(row.created_at);
    const updatedAt = strictProjectionTimestamp(row.updated_at);
    const ticketNumber = row.ticket_number;
    if (
      !id ||
      !version ||
      version !== updatedAt ||
      conversationId === null ||
      !title ||
      !status ||
      !priority ||
      assignee !== "" ||
      (assignmentState !== "unassigned" &&
        assignmentState !== "legacy_unverified") ||
      !sourceChannel ||
      dueAt === false ||
      resolvedAt === false ||
      !createdAt ||
      !updatedAt ||
      Date.parse(updatedAt) < Date.parse(createdAt) ||
      (dueAt !== null && Date.parse(dueAt) < Date.parse(createdAt)) ||
      (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(createdAt)) ||
      (ticketNumber !== undefined &&
        (!Number.isSafeInteger(ticketNumber) || Number(ticketNumber) < 1))
    ) {
      return null;
    }
    return {
      id,
      tenantId: expectedTenantId,
      tenant_id: expectedTenantId,
      version,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(ticketNumber === undefined
        ? {}
        : { ticket_number: Number(ticketNumber) }),
      title,
      status,
      priority,
      assignment_state: assignmentState,
      source_channel: sourceChannel,
      due_at: dueAt,
      resolved_at: resolvedAt,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  });
}

function decodeItems<T>(
  value: unknown,
  expectedTenantId: string,
  decoder: (item: unknown) => T | null,
  expectedConsistency:
    | "mutable_window"
    | "created_at_window" = "mutable_window",
): DecodedCollection<T> {
  const envelope = record(value);
  if (
    !envelope ||
    !isCanonicalHelpdeskId(expectedTenantId) ||
    envelope.tenantId !== expectedTenantId ||
    !isCanonicalHelpdeskId(envelope.tenantId) ||
    !hasExactKeys(envelope, ["tenantId", "items", "page"]) ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100
  ) {
    return {
      items: [],
      rejected: 0,
      envelopeError:
        "The server returned an invalid or cross-workspace collection envelope.",
      page: null,
    };
  }
  const pageRow = record(envelope.page);
  const nextCursor: string | null | false =
    pageRow?.next_cursor === null
      ? null
      : isSafeOpaqueHelpdeskCursor(pageRow?.next_cursor)
        ? pageRow.next_cursor
        : false;
  const asOf = strictProjectionTimestamp(pageRow?.as_of);
  if (
    !pageRow ||
    !hasExactKeys(pageRow, [
      "has_more",
      "next_cursor",
      "as_of",
      "consistency",
      "may_reorder",
    ]) ||
    typeof pageRow.has_more !== "boolean" ||
    nextCursor === false ||
    pageRow.has_more !== (typeof nextCursor === "string") ||
    !asOf ||
    pageRow.consistency !== expectedConsistency ||
    pageRow.may_reorder !== true
  ) {
    return {
      items: [],
      rejected: 0,
      envelopeError: "The server returned invalid pagination metadata.",
      page: null,
    };
  }
  const page: NonNullable<DecodedCollection<T>["page"]> = {
    hasMore: pageRow.has_more,
    nextCursor: nextCursor || null,
    asOf,
    consistency: expectedConsistency,
    mayReorder: true,
  };
  const items: T[] = [];
  let rejected = 0;
  for (const raw of envelope.items) {
    const decoded = decoder(raw);
    if (decoded) items.push(decoded);
    else rejected += 1;
  }
  return { items, rejected, envelopeError: null, page };
}

/** Client-side queue search over fields already present in the verified list.
 * The bounded query is deliberately not logged or sent to a second endpoint. */
export function conversationMatchesQuery(
  conversation: ServiceConversation,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    requesterLabel(conversation),
    conversation.subject,
    conversation.requester_email,
    conversation.requester_phone,
    conversation.assigned_to,
    conversation.channel_type,
    conversation.source_type,
    conversation.status,
    conversation.priority,
    ...(conversation.tags ?? []),
  ].some((value) => (value ?? "").toLocaleLowerCase().includes(needle));
}

/** Describe only the ticket row's recorded due_at clock comparison. The
 * service exposes no governed service-level policy, so this must never imply compliance,
 * breach, or completeness beyond the loaded ticket window. */
export function describeTicketDueDate(
  ticket: ServiceTicket | null | undefined,
  nowMs = Date.now(),
  absenceProven = false,
): RecordedDueDateDescriptor {
  if (!ticket) {
    return {
      kind: "unknown",
      label: absenceProven ? "No recorded due date" : "Due date unverified",
      detail: absenceProven
        ? "A complete ticket query found no linked ticket or recorded due date."
        : "The loaded ticket window cannot prove whether a ticket or recorded due date exists.",
    };
  }
  if (
    ["resolved", "closed", "archived"].includes(ticket.status.toLowerCase())
  ) {
    return {
      kind: "resolved",
      label: "Ticket resolved",
      detail: ticket.resolved_at
        ? `Ticket resolved ${new Date(ticket.resolved_at).toLocaleString()}; no governed service-level policy is inferred.`
        : "Ticket is in a terminal state; no governed service-level policy is inferred.",
    };
  }
  const dueMs = ticket.due_at ? Date.parse(ticket.due_at) : Number.NaN;
  if (!Number.isFinite(dueMs)) {
    return {
      kind: "unknown",
      label: "No recorded due date",
      detail: "The linked ticket has no valid recorded due date.",
    };
  }
  const deltaMinutes = Math.round((dueMs - nowMs) / 60_000);
  if (deltaMinutes < 0) {
    return {
      kind: "past-due",
      label: `${formatDuration(Math.abs(deltaMinutes))} past recorded due`,
      detail: `Recorded due date: ${new Date(dueMs).toLocaleString()}. This is a clock comparison, not a service-level breach claim.`,
    };
  }
  if (deltaMinutes <= 60) {
    return {
      kind: "due-soon",
      label: `Recorded due in ${formatDuration(deltaMinutes)}`,
      detail: `Recorded due date: ${new Date(dueMs).toLocaleString()}. No governed service-level policy is attached.`,
    };
  }
  return {
    kind: "future",
    label: `Recorded due in ${formatDuration(deltaMinutes)}`,
    detail: `Recorded due date: ${new Date(dueMs).toLocaleString()}. No governed service-level policy is attached.`,
  };
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

/** Synthetic status filter meaning "no status filter" (omit the query). */
export const ALL_STATUS = "__all__";
export const INTERNAL_NOTE_MAX_BYTES = 16 * 1024;
export const ASSIGNMENT_REASON_MAX_BYTES = 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function internalNoteValidationError(value: string): string | null {
  const text = value.trim();
  if (!text) return "Enter an internal note to enable Add note.";
  if (CONTROL_OR_BIDI_OVERRIDE_RE.test(text)) {
    return "Internal notes cannot contain unsafe control, bidi, or zero-width characters.";
  }
  const bytes = utf8ByteLength(text);
  if (bytes > INTERNAL_NOTE_MAX_BYTES) {
    return `Internal notes must not exceed 16 KiB after UTF-8 encoding (${bytes.toLocaleString()} bytes entered).`;
  }
  return null;
}

export function assignmentReasonValidationError(value: string): string | null {
  const text = value.trim();
  if (CONTROL_OR_BIDI_OVERRIDE_RE.test(text)) {
    return "Assignment reason cannot contain unsafe control, bidi, or zero-width characters.";
  }
  const bytes = utf8ByteLength(text);
  return bytes > ASSIGNMENT_REASON_MAX_BYTES
    ? `Assignment reason must not exceed 1,024 UTF-8 bytes (${bytes.toLocaleString()} bytes entered).`
    : null;
}

/**
 * Strip HTML to readable plain text. Block-level tags become newlines,
 * <li> becomes a bullet, and the five XML/HTML named entities plus
 * numeric entities are decoded. Runs of blank lines collapse to one.
 *
 * This is deliberately conservative: the result is ALWAYS inserted as a
 * text node (never as innerHTML), so even if a tag slips through it
 * renders as literal text rather than executing.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const withBreaks = html
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|ul|ol|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const decoded = decodeEntities(withBreaks);
  // Collapse 3+ newlines to a paragraph break and trim trailing space
  // on each line so the rendered block doesn't have ragged whitespace.
  return decoded
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode the common named entities + numeric (&#NN; / &#xNN;) entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      safeFromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * The text to render for a message: prefer the plain-text body; if only
 * HTML is present, strip it to text. Never fabricate — an empty body
 * stays empty so the caller can show a muted placeholder.
 */
export function messageText(
  m: Partial<ServiceMessage> | null | undefined,
): string {
  if (!m) return "";
  const text = (m.body_text ?? "").trim();
  if (text) return text;
  return htmlToText(m.body_html);
}

/** name || email || phone || "Unknown" — never a blank requester. */
export function requesterLabel(
  c:
    | Pick<
        ServiceConversation,
        "requester_name" | "requester_email" | "requester_phone"
      >
    | null
    | undefined,
): string {
  if (!c) return "Unknown";
  const name = (c.requester_name ?? "").trim();
  if (name) return name;
  const email = (c.requester_email ?? "").trim();
  if (email) return email;
  const phone = (c.requester_phone ?? "").trim();
  if (phone) return phone;
  return "Unknown";
}

/**
 * The left-rail status chips: the synthetic "All" sentinel followed by
 * the catalog statuses (blanks dropped, de-duplicated, order preserved).
 */
export function statusChips(
  statuses: string[] | null | undefined,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [
    { value: ALL_STATUS, label: "All" },
  ];
  const seen = new Set<string>();
  const list = Array.isArray(statuses) ? statuses : [];
  for (const raw of list) {
    const s = (raw ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ value: s, label: titleizeStatus(s) });
  }
  return out;
}

/** "in_progress" → "In progress" for display; raw value kept for queries. */
export function titleizeStatus(s: string): string {
  const cleaned = (s ?? "").trim();
  if (!cleaned) return "—";
  const spaced = cleaned.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The default status filter: the first catalog status, or "All" when the
 * catalog has no statuses (so the inbox still loads everything).
 */
export function defaultStatus(statuses: string[] | null | undefined): string {
  const list = Array.isArray(statuses) ? statuses : [];
  for (const raw of list) {
    const s = (raw ?? "").trim();
    if (s) return s;
  }
  return ALL_STATUS;
}

/** Map a status string to a badge tone class (success/warning/plain). */
export function statusBadgeClass(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "closed" || s === "resolved" || s === "solved") {
    return "badge success";
  }
  if (
    s === "open" ||
    s === "pending" ||
    s === "in_progress" ||
    s === "waiting"
  ) {
    return "badge warning";
  }
  return "badge";
}
