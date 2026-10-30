/**
 * The Helpdesk wire vocabulary: the status set every surface agrees on, the
 * contract error every parser throws, and the shapes the parsers produce.
 *
 * Types only, plus the two frozen vocabularies they are validated against, so
 * every other Helpdesk module can depend on this one without depending on a
 * parser.
 */
export const HELPDESK_CONVERSATION_STATUSES = [
  "open",
  "pending",
  "waiting",
  "resolved",
  "closed",
  "spam",
  "archived",
] as const;
export type HelpdeskConversationStatus =
  (typeof HELPDESK_CONVERSATION_STATUSES)[number];
export const HELPDESK_STATUSES = new Set<string>(
  HELPDESK_CONVERSATION_STATUSES,
);

export class HelpdeskContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpdeskContractError";
  }
}

export function isHelpdeskConversationStatus(
  value: unknown,
): value is HelpdeskConversationStatus {
  return typeof value === "string" && HELPDESK_STATUSES.has(value);
}

export interface HelpdeskConversation {
  id: string;
  tenantId: string;
  version: string;
  channelType: string | null;
  sourceType: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterPhone: string | null;
  subject: string | null;
  status: string;
  priority: string | null;
  assignmentState: "tenant_active_user" | "unassigned" | "legacy_unverified";
  assignedToUserId: string | null;
  tags: string[];
  lastMessageAt: string | null;
  updatedAt: string;
}

export type HelpdeskMessageDirection = "inbound" | "outbound" | "internal";
export type HelpdeskMessageRecordKind =
  | "inbound_record"
  | "outbound_record"
  | "internal_note";
export type HelpdeskMessageDeliveryStatus =
  | "received"
  | "unverified"
  | "not_applicable";

export interface HelpdeskMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: HelpdeskMessageDirection;
  recordKind: HelpdeskMessageRecordKind;
  deliveryStatus: HelpdeskMessageDeliveryStatus;
  senderType: "customer" | "agent" | "system" | "ai";
  sourceType: string;
  sender: string | null;
  body: string | null;
  bodyOmittedReason: string | null;
  attachmentCount: number;
  projectionTruncated: boolean;
  at: string;
  createdAt: string;
}

export interface HelpdeskPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
  asOf: string;
  consistency: "mutable_window" | "created_at_window";
  mayReorder: true;
}

export interface HelpdeskConversationPage {
  items: HelpdeskConversation[];
  page: HelpdeskPageInfo;
}

export interface HelpdeskMessagePage {
  items: HelpdeskMessage[];
  page: HelpdeskPageInfo;
  order: "desc" | "asc";
}

export interface CapabilityStatus {
  status: string;
  code: string | null;
  executionMode: string | null;
}

export interface HelpdeskCatalog {
  schemaVersion: "postwave.service_suite.v2";
  provenance: {
    tenantBound: false;
    source: "static_server_catalog";
  };
  statuses: string[];
  capabilities: {
    outboundReplyDelivery: CapabilityStatus;
    inboundEmailBridge: CapabilityStatus;
    internalNotes: CapabilityStatus;
    privacyLifecycle: CapabilityStatus;
    customerHubRuntime: CapabilityStatus;
    channelRuntime: CapabilityStatus;
    customerAgent: CapabilityStatus;
    macroUsageEvidence: CapabilityStatus;
    spamAssessmentWrite: CapabilityStatus;
    resourceCreation: CapabilityStatus;
  };
  guardrail: {
    draftOnly: true;
    providerExecuted: false;
    customerMutations: false;
    requiresHumanReview: true;
  };
}
