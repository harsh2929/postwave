/**
 * Conversation rows and their bounded page window.
 *
 * A row must prove its tenant TWICE — the envelope binding and the row's own
 * `tenant_id` — and the two assignment identifiers must either both be present
 * and agree, or both be absent. Anything else is a conversation whose owner
 * this client cannot honestly name.
 */
import {
  allowedObject,
  assertEnvelopeTenant,
  assertOnePageWindow,
  assertOrdered,
  assertRowTenant,
  assertUnique,
  boundedStringList,
  canonicalUUID,
  chronologicalTimestampKey,
  displayString,
  enumToken,
  exactObject,
  pageInfo,
  resourceVersion,
  timestamp,
  token,
} from "@/lib/helpdeskContract";
import { conversationSortKey } from "@/lib/helpdeskDerive";
import {
  HELPDESK_STATUSES,
  HelpdeskContractError,
  type HelpdeskConversation,
  type HelpdeskConversationPage,
} from "@/lib/helpdeskTypes";

const HELPDESK_CHANNEL_TYPES = new Set([
  "web_chat",
  "email",
  "sms",
  "instagram",
  "whatsapp",
  "facebook",
  "generic",
]);
const HELPDESK_SOURCE_TYPES = new Set([
  "manual",
  "inbound_email",
  "campaign_reply",
  "sms",
  "social",
  "web_chat",
  "whatsapp",
]);
const HELPDESK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

const CONVERSATION_WIRE_FIELDS = [
  "tenantId",
  "id",
  "tenant_id",
  "version",
  "channel_id",
  "channel_type",
  "source_type",
  "subscriber_id",
  "requester_email",
  "requester_phone",
  "requester_name",
  "subject",
  "status",
  "priority",
  "assigned_to",
  "assigned_to_user_id",
  "assignment_state",
  "tags",
  "last_message_at",
  "created_at",
  "updated_at",
] as const;

function normalizeConversationRow(
  value: unknown,
  expectedTenantId: string,
): HelpdeskConversation {
  const raw = allowedObject(value, "conversation", CONVERSATION_WIRE_FIELDS);
  const tenantId = assertRowTenant(raw, expectedTenantId);
  const version = resourceVersion(raw["version"]);
  const updatedAt = timestamp(raw["updated_at"], "updated_at", true) as string;
  if (version !== updatedAt) {
    throw new HelpdeskContractError(
      "conversation version and updated_at disagree",
    );
  }
  const assignmentState = token(
    raw["assignment_state"],
    "assignment_state",
    true,
  );
  if (
    assignmentState !== "tenant_active_user" &&
    assignmentState !== "unassigned" &&
    assignmentState !== "legacy_unverified"
  ) {
    throw new HelpdeskContractError("conversation assignment_state is invalid");
  }
  const hasAssignedTo = Object.hasOwn(raw, "assigned_to");
  const hasAssignedToUserId = Object.hasOwn(raw, "assigned_to_user_id");
  let assignedToUserId: string | null = null;
  if (assignmentState === "tenant_active_user") {
    if (!hasAssignedTo || !hasAssignedToUserId) {
      throw new HelpdeskContractError(
        "verified assignment fields must both be present",
      );
    }
    assignedToUserId = canonicalUUID(
      raw["assigned_to_user_id"],
      "assigned_to_user_id",
    );
    if (canonicalUUID(raw["assigned_to"], "assigned_to") !== assignedToUserId) {
      throw new HelpdeskContractError(
        "conversation assignment fields disagree",
      );
    }
  } else if (hasAssignedTo || hasAssignedToUserId) {
    throw new HelpdeskContractError(
      "unverified or unassigned conversations must omit assignment identifiers",
    );
  }
  return {
    id: canonicalUUID(raw["id"], "conversation.id"),
    tenantId,
    version,
    channelType: enumToken(
      raw["channel_type"],
      "channel_type",
      HELPDESK_CHANNEL_TYPES,
    ),
    sourceType: enumToken(
      raw["source_type"],
      "source_type",
      HELPDESK_SOURCE_TYPES,
    ),
    requesterName: displayString(raw["requester_name"], "requester_name", 200),
    requesterEmail: displayString(
      raw["requester_email"],
      "requester_email",
      320,
    ),
    requesterPhone: displayString(
      raw["requester_phone"],
      "requester_phone",
      64,
    ),
    subject: displayString(raw["subject"], "subject", 500),
    status: enumToken(raw["status"], "status", HELPDESK_STATUSES),
    priority: enumToken(raw["priority"], "priority", HELPDESK_PRIORITIES),
    assignmentState,
    assignedToUserId,
    tags: boundedStringList(raw["tags"], "tags", 32, 100),
    lastMessageAt: timestamp(raw["last_message_at"], "last_message_at"),
    updatedAt,
  };
}

export function normalizeServiceConversation(
  value: unknown,
  expectedTenantId: string,
): HelpdeskConversation {
  const raw = allowedObject(value, "conversation", CONVERSATION_WIRE_FIELDS);
  assertEnvelopeTenant(raw, expectedTenantId);
  return normalizeConversationRow(raw, expectedTenantId);
}

function compareDesc(a: HelpdeskConversation, b: HelpdeskConversation): number {
  const byTime = chronologicalTimestampKey(
    conversationSortKey(b),
  ).localeCompare(chronologicalTimestampKey(conversationSortKey(a)));
  return byTime || b.id.localeCompare(a.id);
}

export function normalizeServiceConversationPage(
  value: unknown,
  expectedTenantId: string,
): HelpdeskConversationPage {
  const raw = exactObject(value, "conversation page", [
    "tenantId",
    "items",
    "page",
  ]);
  assertEnvelopeTenant(raw, expectedTenantId);
  if (!Array.isArray(raw["items"])) {
    throw new HelpdeskContractError("conversation page items must be an array");
  }
  const items = raw["items"];
  const parsed = items.map((item) =>
    normalizeConversationRow(item, expectedTenantId),
  );
  assertUnique(
    parsed.map((item) => item.id),
    "conversation",
  );
  assertOrdered(parsed, compareDesc, "conversation");
  const page = pageInfo(raw["page"], "mutable_window");
  if (page.hasMore && parsed.length === 0) {
    throw new HelpdeskContractError(
      "an empty conversation page cannot have more rows",
    );
  }
  return { items: parsed, page };
}

export function normalizeServiceConversations(
  value: unknown,
  expectedTenantId: string,
): HelpdeskConversation[] {
  return normalizeServiceConversationPage(value, expectedTenantId).items;
}

export function mergeHelpdeskConversationPages(
  pages: readonly HelpdeskConversationPage[],
): HelpdeskConversation[] {
  assertOnePageWindow(
    pages.map((page) => page.page),
    "conversation",
  );
  const rows = pages.flatMap((page) => page.items);
  assertUnique(
    rows.map((row) => row.id),
    "conversation window",
  );
  return [...rows].sort(compareDesc);
}
