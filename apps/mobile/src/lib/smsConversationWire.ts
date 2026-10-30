/**
 * smsConversationWire — the strict decoder for the SMS conversation list.
 *
 * Field validators live in `smsWirePrimitives.ts`; the thread, context, and
 * reply decoders live in `smsThreadWire.ts` / `smsContextWire.ts` /
 * `smsReplyWire.ts` (split when this file was 1,081 lines against a 450-line
 * budget). `smsConversation.ts` re-exports everything, so callers see one
 * unchanged public surface.
 *
 * `stateUpdatedAt` is decoded and carried on every summary row: it is the
 * server's optimistic-lock token for operator lifecycle state
 * (`ConversationSummary.StateUpdatedAt`, apps/api/internal/sms/inbox.go:78),
 * and both the bulk action route and the per-conversation lifecycle routes
 * refuse a write whose `expectedUpdatedAt` does not match it.
 */
import {
  SmsContractError,
  type SmsConversationQueryIdentity,
  type SmsConversationSummary,
  type SmsConversationsPage,
  type SmsInboxBodyOmittedReason,
} from "./smsConversation";
import { isValidSmsInboxBody } from "./smsBodyContract";
import {
  wireBoolean,
  wireExactKeys,
  wireInteger,
  wireNextCursor,
  wireObject,
  wireOptionalString,
  wireOptionalTimestamp,
  wirePhone,
  wireTenantEnvelope,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export function compareSmsConversationOrder(
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
  const time = Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt);
  return time !== 0 ? time : a.phoneE164.localeCompare(b.phoneE164);
}

/**
 * One conversation summary row, checked against the response cutoff.
 *
 * Exported (rather than kept private to the page decoder) because the search
 * response (`POST /api/v1/sms/conversations/search`) carries the SAME row
 * shape under a different envelope — see `lib/smsInboxSearch.ts`.
 */
export function decodeSmsConversationSummary(
  entry: unknown,
  path: string,
  snapshotTime: number,
): SmsConversationSummary {
  const row = wireObject(entry, path);
  wireExactKeys(
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
  const phoneE164 = wirePhone(row.phoneE164, `${path}.phoneE164`);
  const preview = conversationPreview(row, path);
  const result: SmsConversationSummary = {
    phoneE164,
    identityAmbiguous: wireBoolean(
      row.identityAmbiguous,
      `${path}.identityAmbiguous`,
    ),
    lastMessagePreview: preview.value,
    lastMessageAt: wireTimestamp(row.lastMessageAt, `${path}.lastMessageAt`),
    lastDirection: decodeDirectionField(row.lastDirection, path),
    messageCount: wireInteger(row.messageCount, `${path}.messageCount`),
    unreadCount: wireInteger(row.unreadCount, `${path}.unreadCount`),
    ...(preview.omittedReason
      ? { lastMessagePreviewOmittedReason: preview.omittedReason }
      : {}),
    ...conversationOptional(row, path),
  };
  if (result.identityAmbiguous && result.subscriberEmail) {
    throw new SmsContractError(
      `${path}.subscriberEmail must be omitted for ambiguous identity`,
    );
  }
  if (Date.parse(result.lastMessageAt) > snapshotTime) {
    throw new SmsContractError(
      `${path}.lastMessageAt is newer than the response cutoff`,
    );
  }
  if (result.unreadCount > result.messageCount) {
    throw new SmsContractError(`${path}.unreadCount exceeds messageCount`);
  }
  if (
    Boolean(result.oldestUnreadAt) !== result.unreadCount > 0 ||
    (result.oldestUnreadAt &&
      (Date.parse(result.oldestUnreadAt) > snapshotTime ||
        Date.parse(result.oldestUnreadAt) > Date.parse(result.lastMessageAt)))
  ) {
    throw new SmsContractError(
      `${path}.oldestUnreadAt disagrees with unreadCount or the response cutoff`,
    );
  }
  return result;
}

function decodeDirectionField(
  value: unknown,
  path: string,
): SmsConversationSummary["lastDirection"] {
  if (value !== "inbound" && value !== "outbound") {
    throw new SmsContractError(`${path}.lastDirection has an unknown direction`);
  }
  return value;
}

export function decodeSmsConversationsPage(
  raw: unknown,
  expected: { tenantId: string; query: SmsConversationQueryIdentity },
): SmsConversationsPage {
  const src = wireObject(raw, "conversations response");
  wireExactKeys(
    src,
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
    "conversations response",
  );
  const tenantId = wireTenantEnvelope(
    src,
    expected.tenantId,
    "conversations response",
  );
  const query = conversationQueryIdentity(expected.query);
  const snapshotAt = wireTimestamp(
    src.snapshotAt,
    "conversations response.snapshotAt",
  );
  const snapshotTime = Date.parse(snapshotAt);
  if (!Array.isArray(src.conversations) || src.conversations.length > 100) {
    throw new SmsContractError(
      "conversations must be an array of at most 100 rows",
    );
  }
  const seen = new Set<string>();
  let previous: SmsConversationSummary | undefined;
  const conversations = src.conversations.map((entry, index) => {
    const path = `conversations[${index}]`;
    const result = decodeSmsConversationSummary(entry, path, snapshotTime);
    if (seen.has(result.phoneE164))
      throw new SmsContractError(`${path} duplicates ${result.phoneE164}`);
    seen.add(result.phoneE164);
    if (
      (query.filter === "unread" && result.unreadCount === 0) ||
      (query.filter === "unknown" &&
        (result.identityAmbiguous || Boolean(result.subscriberEmail))) ||
      !conversationMatchesStatus(result, query.status, snapshotTime)
    ) {
      throw new SmsContractError(
        `${path} disagrees with the conversation query identity`,
      );
    }
    if (
      previous &&
      compareSmsConversationOrder(previous, result, query.sort) > 0
    ) {
      throw new SmsContractError(`${path} is out of requested order`);
    }
    previous = result;
    return result;
  });
  const cursor = wireNextCursor(src, "conversations response");
  const result: SmsConversationsPage = {
    tenantId,
    query,
    conversations,
    snapshotAt,
    unreadTotal: wireInteger(
      src.unreadTotal,
      "conversations response.unreadTotal",
    ),
    unknownTotal: wireInteger(
      src.unknownTotal,
      "conversations response.unknownTotal",
    ),
    totalConversations: wireInteger(
      src.totalConversations,
      "conversations response.totalConversations",
    ),
    activeTotal: wireInteger(
      src.activeTotal,
      "conversations response.activeTotal",
    ),
    snoozedTotal: wireInteger(
      src.snoozedTotal,
      "conversations response.snoozedTotal",
    ),
    archivedTotal: wireInteger(
      src.archivedTotal,
      "conversations response.archivedTotal",
    ),
    ...(cursor ? { nextCursor: cursor } : {}),
  };
  if (
    result.unreadTotal > result.totalConversations ||
    result.unknownTotal > result.totalConversations ||
    result.activeTotal + result.snoozedTotal + result.archivedTotal !==
      result.totalConversations ||
    conversations.length > conversationStatusTotal(result, query.status)
  ) {
    throw new SmsContractError(
      "conversation totals are internally inconsistent",
    );
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
  page: Pick<
    SmsConversationsPage,
    "activeTotal" | "snoozedTotal" | "archivedTotal" | "totalConversations"
  >,
  status: SmsConversationQueryIdentity["status"],
): number {
  if (status === "active") return page.activeTotal;
  if (status === "snoozed") return page.snoozedTotal;
  if (status === "archived") return page.archivedTotal;
  return page.totalConversations;
}

function conversationOptional(
  row: Record<string, unknown>,
  path: string,
): Partial<SmsConversationSummary> {
  const oldestUnreadAt = wireOptionalTimestamp(row, "oldestUnreadAt", path);
  const snoozeUntil = wireOptionalTimestamp(row, "snoozeUntil", path);
  const archivedAt = wireOptionalTimestamp(row, "archivedAt", path);
  const stateUpdatedAt = wireOptionalTimestamp(row, "stateUpdatedAt", path);
  const subscriberEmail = wireOptionalString(row, "subscriberEmail", path, 320);
  const rawAssigneeUserId = row.assigneeUserId;
  const assigneeUserId =
    rawAssigneeUserId === undefined
      ? undefined
      : wireUuid(rawAssigneeUserId, `${path}.assigneeUserId`);
  return {
    ...(oldestUnreadAt ? { oldestUnreadAt } : {}),
    ...(snoozeUntil ? { snoozeUntil } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(stateUpdatedAt ? { stateUpdatedAt } : {}),
    ...(subscriberEmail ? { subscriberEmail } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
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
    throw new SmsContractError("conversation query identity is invalid");
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
    throw new SmsContractError(`${path}.lastMessagePreview must be a string`);
  }
  if (row.lastMessagePreviewOmittedReason !== undefined) {
    const reason = row.lastMessagePreviewOmittedReason;
    if (
      (reason !== "body_exceeds_inbox_limit" &&
        reason !== "legacy_body_unavailable") ||
      row.lastMessagePreview !== ""
    ) {
      throw new SmsContractError(
        `${path}.lastMessagePreviewOmittedReason is invalid`,
      );
    }
    return {
      value: "",
      omittedReason: reason,
    };
  }
  if (
    row.lastMessagePreview.trim().length === 0 ||
    !isValidSmsInboxBody(row.lastMessagePreview, {
      allowEmpty: true,
      maxCodePoints: 512,
    })
  ) {
    throw new SmsContractError(
      `${path}.lastMessagePreview violates the private inbox preview contract`,
    );
  }
  return { value: row.lastMessagePreview };
}
