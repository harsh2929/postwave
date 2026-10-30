/**
 * Message rows, their bounded page window, and the internal-note receipt.
 *
 * `record_kind` and `delivery_status` are checked AGAINST the direction rather
 * than trusted: outbound rows may only ever claim `unverified`, because this
 * release has no outbound delivery to verify. An omitted body must name its
 * reason and vice versa, so "no text" is never mistaken for "empty message".
 */
import {
  allowedObject,
  assertEnvelopeTenant,
  assertOnePageWindow,
  assertOrdered,
  assertRowTenant,
  assertUnique,
  canonicalUUID,
  chronologicalTimestampKey,
  displayString,
  exactObject,
  nonnegativeInteger,
  normalizeHelpdeskId,
  pageInfo,
  requiredBoolean,
  timestamp,
  token,
} from "@/lib/helpdeskContract";
import {
  HelpdeskContractError,
  type HelpdeskMessage,
  type HelpdeskMessageDeliveryStatus,
  type HelpdeskMessageDirection,
  type HelpdeskMessagePage,
  type HelpdeskMessageRecordKind,
} from "@/lib/helpdeskTypes";

const HELPDESK_BODY_OMISSION_REASONS = new Set([
  "html_only",
  "attachments_only",
  "source_body_empty",
  "source_body_unsafe",
]);

const MESSAGE_WIRE_FIELDS = [
  "tenantId",
  "id",
  "tenant_id",
  "conversation_id",
  "source_type",
  "direction",
  "sender_type",
  "sender",
  "body_text",
  "sent_at",
  "created_at",
  "record_kind",
  "delivery_status",
  "body_omitted_reason",
  "attachment_count",
  "projection_truncated",
] as const;

function normalizeServiceMessage(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
): HelpdeskMessage {
  const raw = allowedObject(value, "message", MESSAGE_WIRE_FIELDS);
  const tenantId = assertRowTenant(raw, expectedTenantId);
  const conversationId = canonicalUUID(
    raw["conversation_id"],
    "conversation_id",
  );
  const expectedConversation = normalizeHelpdeskId(expectedConversationId);
  if (!expectedConversation || conversationId !== expectedConversation) {
    throw new HelpdeskContractError(
      "Helpdesk message crossed the conversation boundary",
    );
  }
  const direction = token(raw["direction"], "direction", true);
  const senderType = token(raw["sender_type"], "sender_type", true);
  const sourceType = token(raw["source_type"], "source_type", true) as string;
  const recordKind = token(raw["record_kind"], "record_kind", true);
  const deliveryStatus = token(raw["delivery_status"], "delivery_status", true);
  if (
    !(["inbound", "outbound", "internal"] as const).includes(direction as never)
  ) {
    throw new HelpdeskContractError("message direction is unsupported");
  }
  if (
    !(["customer", "agent", "system", "ai"] as const).includes(
      senderType as never,
    )
  ) {
    throw new HelpdeskContractError("message sender_type is unsupported");
  }
  const expected =
    direction === "internal"
      ? ["internal_note", "not_applicable"]
      : direction === "inbound"
        ? ["inbound_record", "received"]
        : ["outbound_record", "unverified"];
  if (recordKind !== expected[0] || deliveryStatus !== expected[1]) {
    throw new HelpdeskContractError(
      "message record and delivery facts disagree",
    );
  }
  const body = displayString(raw["body_text"], "body_text", 16_384);
  const bodyOmittedReason = token(
    raw["body_omitted_reason"],
    "body_omitted_reason",
  );
  if (
    bodyOmittedReason !== null &&
    !HELPDESK_BODY_OMISSION_REASONS.has(bodyOmittedReason)
  ) {
    throw new HelpdeskContractError(
      "message body omission reason is unsupported",
    );
  }
  if ((body === null) !== (bodyOmittedReason !== null)) {
    throw new HelpdeskContractError(
      "message body and omission reason disagree",
    );
  }
  const sentAt = timestamp(raw["sent_at"], "sent_at", true) as string;
  const createdAt = timestamp(raw["created_at"], "created_at", true) as string;
  const projectionTruncated = requiredBoolean(
    raw["projection_truncated"],
    "projection_truncated",
  );
  if (bodyOmittedReason === "source_body_unsafe" && !projectionTruncated) {
    throw new HelpdeskContractError(
      "unsafe source-body omission must report a truncated projection",
    );
  }
  return {
    id: canonicalUUID(raw["id"], "message.id"),
    tenantId,
    conversationId,
    direction: direction as HelpdeskMessageDirection,
    recordKind: recordKind as HelpdeskMessageRecordKind,
    deliveryStatus: deliveryStatus as HelpdeskMessageDeliveryStatus,
    senderType: senderType as HelpdeskMessage["senderType"],
    sourceType,
    sender: displayString(raw["sender"], "sender", 320),
    body,
    bodyOmittedReason,
    attachmentCount: nonnegativeInteger(
      raw["attachment_count"],
      "attachment_count",
    ),
    projectionTruncated,
    at: sentAt,
    createdAt,
  };
}

function compareMessages(
  a: HelpdeskMessage,
  b: HelpdeskMessage,
  order: "desc" | "asc",
): number {
  const direction = order === "desc" ? -1 : 1;
  const byTime =
    chronologicalTimestampKey(a.at).localeCompare(
      chronologicalTimestampKey(b.at),
    ) * direction;
  return byTime || a.id.localeCompare(b.id) * direction;
}

export function normalizeServiceMessagePage(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
  order: "desc" | "asc" = "desc",
): HelpdeskMessagePage {
  const raw = exactObject(value, "message page", ["tenantId", "items", "page"]);
  assertEnvelopeTenant(raw, expectedTenantId);
  if (!Array.isArray(raw["items"])) {
    throw new HelpdeskContractError("message page items must be an array");
  }
  const items = raw["items"];
  const parsed = items.map((item) =>
    normalizeServiceMessage(item, expectedTenantId, expectedConversationId),
  );
  assertUnique(
    parsed.map((item) => item.id),
    "message",
  );
  assertOrdered(parsed, (a, b) => compareMessages(a, b, order), "message");
  const page = pageInfo(raw["page"], "created_at_window");
  if (
    parsed.some(
      (message) =>
        chronologicalTimestampKey(message.createdAt).localeCompare(
          chronologicalTimestampKey(page.asOf),
        ) > 0,
    )
  ) {
    throw new HelpdeskContractError(
      "message page contains a row created after its as_of boundary",
    );
  }
  if (page.hasMore && parsed.length === 0) {
    throw new HelpdeskContractError(
      "an empty message page cannot have more rows",
    );
  }
  return { items: parsed, page, order };
}

export function normalizeServiceInternalNote(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
): HelpdeskMessage {
  const raw = allowedObject(value, "internal note", MESSAGE_WIRE_FIELDS);
  assertEnvelopeTenant(raw, expectedTenantId);
  const note = normalizeServiceMessage(
    raw,
    expectedTenantId,
    expectedConversationId,
  );
  if (
    note.direction !== "internal" ||
    note.recordKind !== "internal_note" ||
    note.deliveryStatus !== "not_applicable"
  ) {
    throw new HelpdeskContractError(
      "internal note receipt is not non-delivery state",
    );
  }
  return note;
}

export function normalizeServiceMessages(
  value: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
  order: "desc" | "asc" = "desc",
): HelpdeskMessage[] {
  return normalizeServiceMessagePage(
    value,
    expectedTenantId,
    expectedConversationId,
    order,
  ).items;
}

export function mergeHelpdeskMessagePages(
  pages: readonly HelpdeskMessagePage[],
): HelpdeskMessage[] {
  assertOnePageWindow(
    pages.map((page) => page.page),
    "message",
  );
  if (pages.some((page) => page.order !== "desc")) {
    throw new HelpdeskContractError("message window mixed incompatible orders");
  }
  const rows = pages.flatMap((page) => page.items);
  assertUnique(
    rows.map((row) => row.id),
    "message window",
  );
  return [...rows].sort((a, b) => compareMessages(a, b, "asc"));
}
