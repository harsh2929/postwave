/** Pure display, paging, and policy vocabulary for the mobile SMS inbox. */
import { compareSmsConversationOrder } from "./smsConversationWire";

export type SmsDirection = "inbound" | "outbound";
export type SmsConsentStatus = "opted_in" | "opted_out" | "pending" | "none";
export type SmsConversationFilter = "all" | "unread" | "unknown";
export type SmsConversationSort = "recent" | "oldest_unread";
export type SmsConversationStatus = "active" | "snoozed" | "archived" | "any";
export type SmsInboxBodyOmittedReason =
  | "body_exceeds_inbox_limit"
  | "legacy_body_unavailable";

export interface SmsConversationQueryIdentity {
  filter: SmsConversationFilter;
  sort: SmsConversationSort;
  status: SmsConversationStatus;
}

export interface SmsConversationSummary {
  phoneE164: string;
  identityAmbiguous: boolean;
  lastMessagePreview: string;
  lastMessageAt: string;
  lastDirection: SmsDirection;
  messageCount: number;
  unreadCount: number;
  oldestUnreadAt?: string | undefined;
  lastMessagePreviewOmittedReason?: SmsInboxBodyOmittedReason | undefined;
  subscriberEmail?: string | undefined;
  snoozeUntil?: string | undefined;
  archivedAt?: string | undefined;
  assigneeUserId?: string | undefined;
  /**
   * The server's optimistic-lock token for operator lifecycle state
   * (`lifecycle_updated_at`). Absent until the first lifecycle mutation; the
   * bulk and per-conversation lifecycle routes require it (or explicit null)
   * as `expectedUpdatedAt` and answer 409 on a mismatch.
   */
  stateUpdatedAt?: string | undefined;
}

export interface SmsConversationsPage {
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
  nextCursor?: string | undefined;
}

export interface SmsMessage {
  id: string;
  tenantId: string;
  senderProfileId?: string | undefined;
  phoneE164: string;
  provider: string;
  providerMessageId?: string | undefined;
  direction: SmsDirection;
  body: string;
  bodyOmittedReason?: SmsInboxBodyOmittedReason | undefined;
  status: string;
  errorMessage?: string | undefined;
  createdAt: string;
  mediaUrl?: string | undefined;
  segments: number;
}

export interface SmsMessagesPage {
  tenantId: string;
  /** Server order is newest first; the merge below returns reading order. */
  messages: SmsMessage[];
  snapshotAt: string;
  nextCursor?: string | undefined;
}

export interface SmsEligibleList {
  id: string;
  name: string;
  description: string;
  consentSource?: string | undefined;
  consentAt?: string | undefined;
}

export interface SmsConversationContext {
  phoneE164: string;
  subscriberEmail?: string | undefined;
  consentStatus: SmsConsentStatus;
  consentSource?: string | undefined;
  consentAt?: string | undefined;
  optOutAt?: string | undefined;
  subscribedLists: number;
  firstSeenAt?: string | undefined;
  totalMessages: number;
  lastReadAt?: string | undefined;
  suppressed: boolean;
  suppressionReason?: string | undefined;
  suppressionReversible: boolean;
  hasInboundThread: boolean;
  eligibleLists: SmsEligibleList[];
  consentMixed: boolean;
  identityAmbiguous: boolean;
  consentEvidenceSufficient: boolean;
  replyDispatchAvailable: boolean;
  replyDispatchUnavailableReason?: string | undefined;
}

export interface SmsSenderProfile {
  id: string;
  tenantId: string;
  provider: string;
  country: string;
  senderType: string;
  phoneNumber?: string | undefined;
  registrationStatus: string;
  paused: boolean;
}

export interface SmsProviderReceipt {
  provider: string;
  providerMessageId?: string | undefined;
  status: string;
}

export interface SmsPersistedProviderReceipt extends SmsProviderReceipt {
  providerMessageId: string;
}

export interface SmsReplyMessageReceipt {
  id: string;
  tenantId: string;
  senderProfileId: string;
  provider: string;
  providerMessageId: string;
  direction: "outbound";
  segments: number;
  status: string;
  costMicros: number;
  sentAt?: string | undefined;
  createdAt: string;
}

export interface SmsPersistedReplyResponse {
  disposition: "persisted";
  message: SmsReplyMessageReceipt;
  providerReceipt: SmsPersistedProviderReceipt;
}

export interface SmsReconciliationReplyResponse {
  disposition: "reconciliation_required";
  code: "reply_reconciliation_required";
  intentMessageId: string;
  providerReceipt: SmsProviderReceipt;
}

export type SmsReplyResponse =
  | SmsPersistedReplyResponse
  | SmsReconciliationReplyResponse;

export class SmsContractError extends Error {
  constructor(message: string) {
    super(`Invalid SMS response: ${message}`);
    this.name = "SmsContractError";
  }
}

export { decodeSmsConversationsPage } from "./smsConversationWire";
export { decodeSmsMessagesPage } from "./smsThreadWire";
export {
  decodeSmsConversationContext,
  decodeSmsSenders,
} from "./smsContextWire";
export { decodeSmsReplyResponse } from "./smsReplyWire";

export function mergeSmsConversationPages(
  pages: readonly SmsConversationsPage[],
): {
  conversations: SmsConversationSummary[];
  snapshotAt: string | null;
  totalConversations: number;
  unreadTotal: number;
  hasMore: boolean;
} {
  if (pages.length === 0) {
    return {
      conversations: [],
      snapshotAt: null,
      totalConversations: 0,
      unreadTotal: 0,
      hasMore: false,
    };
  }
  const first = pages[0] as SmsConversationsPage;
  const conversations: SmsConversationSummary[] = [];
  const seen = new Set<string>();
  for (const [pageIndex, page] of pages.entries()) {
    if (
      page.snapshotAt !== first.snapshotAt ||
      page.tenantId !== first.tenantId ||
      page.query.filter !== first.query.filter ||
      page.query.sort !== first.query.sort ||
      page.query.status !== first.query.status ||
      page.totalConversations !== first.totalConversations ||
      page.unreadTotal !== first.unreadTotal ||
      page.unknownTotal !== first.unknownTotal ||
      page.activeTotal !== first.activeTotal ||
      page.snoozedTotal !== first.snoozedTotal ||
      page.archivedTotal !== first.archivedTotal
    ) {
      throw new SmsContractError(
        `conversation page ${pageIndex} is from another response cutoff`,
      );
    }
    for (const row of page.conversations) {
      if (seen.has(row.phoneE164))
        throw new SmsContractError("conversation pages overlap");
      const previous = conversations.at(-1);
      if (
        previous &&
        compareSmsConversationOrder(previous, row, first.query.sort) > 0
      ) {
        throw new SmsContractError("conversation pages are out of order");
      }
      seen.add(row.phoneE164);
      conversations.push(row);
    }
    if (conversations.length > first.totalConversations) {
      throw new SmsContractError(
        "conversation pages exceed the reported total",
      );
    }
  }
  return {
    conversations,
    snapshotAt: first.snapshotAt,
    totalConversations: first.totalConversations,
    unreadTotal: first.unreadTotal,
    hasMore: Boolean(pages.at(-1)?.nextCursor),
  };
}

export function mergeSmsMessagePages(pages: readonly SmsMessagesPage[]): {
  messages: SmsMessage[];
  snapshotAt: string | null;
  hasMore: boolean;
} {
  if (pages.length === 0)
    return { messages: [], snapshotAt: null, hasMore: false };
  const snapshotAt = (pages[0] as SmsMessagesPage).snapshotAt;
  const tenantId = (pages[0] as SmsMessagesPage).tenantId;
  const newestFirst: SmsMessage[] = [];
  const seen = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const [pageIndex, page] of pages.entries()) {
    if (page.tenantId !== tenantId || page.snapshotAt !== snapshotAt) {
      throw new SmsContractError(
        `message page ${pageIndex} is from another response cutoff`,
      );
    }
    for (const message of page.messages) {
      if (seen.has(message.id))
        throw new SmsContractError("message pages overlap");
      const at = Date.parse(message.createdAt);
      if (
        at > previousAt ||
        (at === previousAt && previousId !== "" && message.id >= previousId)
      ) {
        throw new SmsContractError("message pages are out of order");
      }
      previousAt = at;
      previousId = message.id;
      seen.add(message.id);
      newestFirst.push(message);
    }
  }
  return {
    messages: newestFirst.reverse(),
    snapshotAt,
    hasMore: Boolean(pages.at(-1)?.nextCursor),
  };
}

export type DeliveryVerdict =
  | "accepted"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "reconciliation"
  | "failed";

export function deliveryVerdict(status: string): DeliveryVerdict {
  const value = status.trim().toLowerCase();
  if (value === "delivered") return "delivered";
  if (value === "sent") return "sent";
  if (value === "accepted") return "accepted";
  if (value === "queued") return "queued";
  if (["reconciliation_required", "reconciling"].includes(value)) {
    return "reconciliation";
  }
  if (["failed", "undelivered", "rejected", "error"].includes(value))
    return "failed";
  return "sending";
}

export function isEligibleSmsSender(sender: SmsSenderProfile): boolean {
  return (
    (sender.country === "US" || sender.country === "CA") &&
    sender.registrationStatus.toLowerCase() === "approved" &&
    !sender.paused
  );
}

export function smsReplyBlockReason(input: {
  phoneE164: string;
  online: boolean;
  context?: SmsConversationContext | undefined;
  contextFailed: boolean;
  sendersFailed: boolean;
  eligibleSenders: readonly SmsSenderProfile[];
}): string | null {
  if (!input.online) return "Offline — replies need a connection";
  if (!isSupportedSmsReplyPhone(input.phoneE164)) {
    return "Replies are currently available only to US and Canada (+1) numbers";
  }
  if (input.contextFailed) return "Consent status unavailable — reply locked";
  if (input.sendersFailed) return "Sender status unavailable — reply locked";
  if (!input.context) return "Checking consent and suppression…";
  if (!input.context.replyDispatchAvailable) {
    switch (input.context.replyDispatchUnavailableReason) {
      case "sms_reply_dispatch_release_held":
        return "Live SMS reply dispatch is release-held; nothing can be sent";
      default:
        return "Reply dispatch is unavailable — nothing can be sent";
    }
  }
  if (input.context.suppressed) {
    return `Suppressed${
      input.context.suppressionReason
        ? ` — ${input.context.suppressionReason}`
        : ""
    }`;
  }
  if (input.context.consentStatus !== "opted_in") {
    return `Reply locked — consent is ${input.context.consentStatus.replace("_", " ")}`;
  }
  if (input.context.identityAmbiguous) {
    return "Reply locked — this phone is linked to multiple subscriber identities";
  }
  if (input.context.consentMixed) {
    return "Reply locked — consent evidence conflicts across subscriber identities";
  }
  if (!input.context.consentEvidenceSufficient) {
    return "Reply locked — consent evidence is insufficient";
  }
  if (!input.context.hasInboundThread)
    return "Reply locked — no verified inbound thread";
  if (input.context.eligibleLists.length === 0) {
    return "Reply locked — no currently opted-in SMS list";
  }
  if (input.eligibleSenders.length === 0)
    return "No approved, active SMS sender";
  return null;
}

export function isSupportedSmsReplyPhone(phoneE164: string): boolean {
  return /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phoneE164);
}

export function newSmsReplyIntentKey(): string {
  return `mobile-sms-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Exact server codes whose Route40 handler branches before provider dispatch.
 * Everything else is outcome-unknown and must keep the durable local hold.
 */
const DEFINITIVE_PRE_PROVIDER_REPLY_CODES = new Set([
  "bad_phone",
  "consent_required",
  "invalid_list_id",
  "invalid_media_url",
  "invalid_sender_profile_id",
  "list_selection_required",
  "reply_blocked",
  "sms_body_outside_contract",
  "sms_financial_reservation_unavailable",
  "sms_provider_unconfigured",
  "sms_reply_dispatch_release_held",
  "sms_sender_provider_unconfigured",
]);

export function isDefinitivePreProviderSmsReplyError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  return DEFINITIVE_PRE_PROVIDER_REPLY_CODES.has(code);
}

export {
  conversationTitle,
  decodePhoneParam,
  safeSmsDisplayText,
  threadPath,
} from "./smsDisplay";

export function markConversationReadInPage(
  page: SmsConversationsPage | undefined,
  phoneE164: string,
): SmsConversationsPage | undefined {
  if (!page) return undefined;
  let cleared = false;
  const conversations = page.conversations.map((row) => {
    if (row.phoneE164 !== phoneE164 || row.unreadCount <= 0) return row;
    cleared = true;
    const { oldestUnreadAt: _oldestUnreadAt, ...rest } = row;
    return { ...rest, unreadCount: 0 };
  });
  return !cleared
    ? page
    : {
        ...page,
        conversations,
        // unreadTotal counts conversations, not unread messages.
        unreadTotal: Math.max(0, page.unreadTotal - 1),
      };
}
