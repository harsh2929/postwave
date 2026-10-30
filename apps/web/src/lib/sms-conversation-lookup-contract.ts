// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Strict, fail-closed wire contract for the SMS conversation lookup surfaces
 * that sit beside the inbox list: server search, per-phone subscriber/consent
 * context, and the audited tenant-wide conversations CSV.
 *
 * Mirrors apps/api/internal/sms (inbox_extras.go SearchConversations /
 * ExportConversationsCSV, inbox.go GetConversationContext and
 * projection_contract.go validConversationContextProjection). Anything the
 * server contract does not promise is refused rather than rendered.
 */

import type { SmsConversationSummary } from "./sms-inbox-contract";

export class SmsLookupContractError extends Error {
  constructor(detail: string) {
    super(`Invalid SMS conversation lookup response: ${detail}`);
    this.name = "SmsLookupContractError";
  }
}

const E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
const MAX_INTEGER = 2_147_483_647;

/** Server search accepts 3–128 safe Unicode characters (validInboxText). */
export const SMS_SEARCH_MIN_CHARS = 3;
export const SMS_SEARCH_MAX_CHARS = 128;
/** Server search page ceiling (SearchConversations limit 1–200). */
export const SMS_SEARCH_MAX_LIMIT = 200;
/** X-Postwave-Audit-Reason ceiling enforced by ExportConversationsCSV. */
export const SMS_EXPORT_REASON_MAX_CHARS = 160;

export const SMS_CONSENT_STATUSES = [
  "opted_in",
  "opted_out",
  "pending",
  "none",
] as const;
export type SmsConsentPosture = (typeof SMS_CONSENT_STATUSES)[number];

const SUPPRESSION_REASONS = new Set([
  "manual",
  "stop_keyword",
  "help_keyword",
  "carrier_block",
  "complaint",
  "quiet_hours",
  "expired",
]);
const SUMMARY_CONSENT_SOURCES = new Set([
  "unknown",
  "keyword",
  "form",
  "import",
  "api",
  "manual",
]);
const ELIGIBLE_CONSENT_SOURCES = new Set([
  "keyword",
  "form",
  "import",
  "api",
  "manual",
]);
const REPLY_DISPATCH_REASONS = new Set([
  "sms_reply_dispatch_release_held",
  "sms_financial_reservation_unavailable",
  "sms_configured_sender_unavailable",
]);

export interface SmsConversationSearchPage {
  tenantId: string;
  conversations: SmsConversationSummary[];
  snapshotAt: string;
  nextCursor?: string;
}

export interface SmsConversationEligibleList {
  id: string;
  name: string;
  description: string;
  consentSource?: string;
  consentAt?: string;
}

export interface SmsConversationContext {
  tenantId: string;
  phoneE164: string;
  subscriberEmail?: string;
  consentStatus: SmsConsentPosture;
  consentSource?: string;
  consentAt?: string;
  optOutAt?: string;
  consentMixed: boolean;
  identityAmbiguous: boolean;
  consentEvidenceSufficient: boolean;
  subscribedLists: number;
  firstSeenAt?: string;
  totalMessages: number;
  lastReadAt?: string;
  suppressed: boolean;
  suppressionReason?: string;
  suppressionReversible: boolean;
  hasInboundThread: boolean;
  eligibleLists: SmsConversationEligibleList[];
  replyDispatchAvailable: boolean;
  replyDispatchUnavailableReason?: string;
}

export interface SmsConversationsExportTruth {
  limit: number;
  asOf: string;
  rowCount: number;
  truncated: boolean;
}

export const SMS_CONVERSATIONS_CSV_HEADER =
  "phone_e164,last_message_at,message_count,last_inbound_at";

// --- input problems (render the sentence, never send a request the server refuses)

function scalarCount(value: string): number {
  return Array.from(value).length;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Why a trimmed search query would be refused, or null when it is sendable. */
export function smsSearchQueryProblem(query: string): string | null {
  const trimmed = query.trim();
  if (scalarCount(trimmed) < SMS_SEARCH_MIN_CHARS) {
    return `Type at least ${SMS_SEARCH_MIN_CHARS} characters to search.`;
  }
  if (scalarCount(trimmed) > SMS_SEARCH_MAX_CHARS) {
    return `Search is limited to ${SMS_SEARCH_MAX_CHARS} characters.`;
  }
  if (INVISIBLE.test(trimmed) || hasLoneSurrogate(trimmed)) {
    return "Search text cannot contain hidden or control characters.";
  }
  return null;
}

/** True when an opaque server cursor is safe to send back (1–4096, no controls). */
export function isSmsOpaqueCursor(cursor: string): boolean {
  return cursor.length >= 1 && cursor.length <= 4_096 && !CONTROL.test(cursor);
}

/** Why an export audit reason would be refused, or null when it is sendable. */
export function smsExportReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "Enter an audit reason for this export.";
  if (scalarCount(trimmed) > SMS_EXPORT_REASON_MAX_CHARS) {
    return `Keep the audit reason to ${SMS_EXPORT_REASON_MAX_CHARS} characters or fewer.`;
  }
  if (INVISIBLE.test(trimmed) || hasLoneSurrogate(trimmed)) {
    return "The audit reason must be one line of plain text without hidden or control characters.";
  }
  return null;
}

// --- primitive decoders

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SmsLookupContractError(`${path} must be an object`);
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
    throw new SmsLookupContractError(
      `${path}.${unexpected} is not part of the contract`,
    );
  }
}

function text(value: unknown, path: string, max: number, empty = false) {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new SmsLookupContractError(`${path} must be a string`);
  }
  if (scalarCount(value) > max || hasLoneSurrogate(value)) {
    throw new SmsLookupContractError(`${path} is too long or malformed`);
  }
  return value;
}

function safeLabel(value: unknown, path: string, max: number, empty = false) {
  const result = text(value, path, max, empty);
  if (INVISIBLE.test(result)) {
    throw new SmsLookupContractError(`${path} has hidden or control characters`);
  }
  return result;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new SmsLookupContractError(`${path} must be a boolean`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_INTEGER
  ) {
    throw new SmsLookupContractError(
      `${path} must be a bounded non-negative integer`,
    );
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!RFC3339.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new SmsLookupContractError(`${path} must be RFC3339`);
  }
  return result;
}

function optionalTimestamp(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  return source[key] === undefined
    ? undefined
    : timestamp(source[key], `${path}.${key}`);
}

function tenant(value: unknown, expected: string, path: string): string {
  const tenantId = text(value, `${path}.tenantId`, 36);
  if (!TENANT_UUID.test(tenantId) || tenantId !== expected) {
    throw new SmsLookupContractError(`${path} belongs to another tenant`);
  }
  return tenantId;
}

function phone(value: unknown, path: string): string {
  const result = text(value, path, 16);
  if (!E164.test(result)) {
    throw new SmsLookupContractError(`${path} must be an exact US/Canada E.164`);
  }
  return result;
}

// --- search

const SEARCH_ROW_KEYS = [
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
] as const;

function searchRow(
  value: unknown,
  path: string,
  snapshotAt: number,
): SmsConversationSummary {
  const row = record(value, path);
  exactKeys(row, SEARCH_ROW_KEYS, path);
  const phoneE164 = phone(row.phoneE164, `${path}.phoneE164`);
  const identityAmbiguous = bool(
    row.identityAmbiguous,
    `${path}.identityAmbiguous`,
  );
  let lastMessagePreview: string;
  let omitted: SmsConversationSummary["lastMessagePreviewOmittedReason"];
  if (row.lastMessagePreviewOmittedReason !== undefined) {
    const reason = row.lastMessagePreviewOmittedReason;
    if (
      (reason !== "body_exceeds_inbox_limit" &&
        reason !== "legacy_body_unavailable") ||
      row.lastMessagePreview !== ""
    ) {
      throw new SmsLookupContractError(
        `${path}.lastMessagePreviewOmittedReason is invalid`,
      );
    }
    lastMessagePreview = "";
    omitted = reason;
  } else {
    lastMessagePreview = text(
      row.lastMessagePreview,
      `${path}.lastMessagePreview`,
      512,
    );
    if (lastMessagePreview.trim() === "" || lastMessagePreview.includes("\u0000")) {
      throw new SmsLookupContractError(
        `${path}.lastMessagePreview violates the private preview contract`,
      );
    }
  }
  const direction = row.lastDirection;
  if (direction !== "inbound" && direction !== "outbound") {
    throw new SmsLookupContractError(`${path}.lastDirection is unknown`);
  }
  const lastMessageAt = timestamp(row.lastMessageAt, `${path}.lastMessageAt`);
  const messageCount = integer(row.messageCount, `${path}.messageCount`);
  const unreadCount = integer(row.unreadCount, `${path}.unreadCount`);
  const oldestUnreadAt = optionalTimestamp(row, "oldestUnreadAt", path);
  const subscriberEmail =
    row.subscriberEmail === undefined
      ? undefined
      : text(row.subscriberEmail, `${path}.subscriberEmail`, 320);
  const snoozeUntil = optionalTimestamp(row, "snoozeUntil", path);
  const archivedAt = optionalTimestamp(row, "archivedAt", path);
  const stateUpdatedAt = optionalTimestamp(row, "stateUpdatedAt", path);
  let assigneeUserId: string | undefined;
  if (row.assigneeUserId !== undefined) {
    assigneeUserId = text(row.assigneeUserId, `${path}.assigneeUserId`, 36);
    if (!UUID_V4.test(assigneeUserId)) {
      throw new SmsLookupContractError(
        `${path}.assigneeUserId must be a canonical UUIDv4`,
      );
    }
  }
  if (identityAmbiguous && subscriberEmail) {
    throw new SmsLookupContractError(
      `${path}.subscriberEmail must be omitted for ambiguous identity`,
    );
  }
  if (
    unreadCount > messageCount ||
    messageCount < 1 ||
    Date.parse(lastMessageAt) > snapshotAt ||
    Boolean(oldestUnreadAt) !== unreadCount > 0 ||
    (oldestUnreadAt !== undefined &&
      Date.parse(oldestUnreadAt) > Date.parse(lastMessageAt)) ||
    ((snoozeUntil || archivedAt || assigneeUserId) && !stateUpdatedAt)
  ) {
    throw new SmsLookupContractError(`${path} has invalid counts or times`);
  }
  return {
    phoneE164,
    identityAmbiguous,
    lastMessagePreview,
    lastMessageAt,
    lastDirection: direction,
    messageCount,
    unreadCount,
    ...(omitted ? { lastMessagePreviewOmittedReason: omitted } : {}),
    ...(oldestUnreadAt ? { oldestUnreadAt } : {}),
    ...(subscriberEmail ? { subscriberEmail } : {}),
    ...(snoozeUntil ? { snoozeUntil } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(stateUpdatedAt ? { stateUpdatedAt } : {}),
  };
}

/**
 * Decode one POST /api/v1/sms/conversations/search page. The server never
 * echoes the query, orders by (lastMessageAt DESC, phoneE164 ASC) and binds
 * every continuation cursor to the first page's snapshotAt.
 */
export function decodeSmsConversationSearch(
  raw: unknown,
  expected: { tenantId: string; limit: number },
): SmsConversationSearchPage {
  const source = record(raw, "search");
  exactKeys(
    source,
    ["tenantId", "conversations", "nextCursor", "snapshotAt"],
    "search",
  );
  const tenantId = tenant(source.tenantId, expected.tenantId, "search");
  const snapshotAt = timestamp(source.snapshotAt, "search.snapshotAt");
  const cutoff = Date.parse(snapshotAt);
  if (
    !Array.isArray(source.conversations) ||
    source.conversations.length > expected.limit
  ) {
    throw new SmsLookupContractError(
      `search.conversations must hold at most ${expected.limit} rows`,
    );
  }
  const seen = new Set<string>();
  let previous: SmsConversationSummary | undefined;
  const conversations = source.conversations.map((value, index) => {
    const row = searchRow(value, `search.conversations[${index}]`, cutoff);
    if (seen.has(row.phoneE164)) {
      throw new SmsLookupContractError(
        `search.conversations[${index}] repeats a phone`,
      );
    }
    seen.add(row.phoneE164);
    if (previous) {
      // (lastMessageAt DESC, phoneE164 ASC): positive means row sorts first.
      const order =
        Date.parse(row.lastMessageAt) - Date.parse(previous.lastMessageAt) ||
        (previous.phoneE164 < row.phoneE164 ? -1 : 1);
      if (order > 0) {
        throw new SmsLookupContractError(
          `search.conversations[${index}] is out of order`,
        );
      }
    }
    previous = row;
    return row;
  });
  let nextCursor: string | undefined;
  if (source.nextCursor !== undefined) {
    nextCursor = text(source.nextCursor, "search.nextCursor", 4_096);
    if (CONTROL.test(nextCursor)) {
      throw new SmsLookupContractError("search.nextCursor has controls");
    }
  }
  return {
    tenantId,
    conversations,
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/**
 * Merge loaded search pages. Every continuation must carry the first page's
 * snapshotAt; a changed window is refused so the operator refreshes instead
 * of reading two different cutoffs as one result set.
 */
export function mergeSmsConversationSearchPages(
  pages: readonly SmsConversationSearchPage[],
): {
  conversations: SmsConversationSummary[];
  snapshotAt: string | null;
  hasMore: boolean;
} {
  const first = pages[0];
  if (!first) return { conversations: [], snapshotAt: null, hasMore: false };
  const seen = new Set<string>();
  const conversations: SmsConversationSummary[] = [];
  for (const page of pages) {
    if (page.snapshotAt !== first.snapshotAt) {
      throw new SmsLookupContractError(
        "the search window changed before the next page loaded",
      );
    }
    for (const row of page.conversations) {
      if (seen.has(row.phoneE164)) continue;
      seen.add(row.phoneE164);
      conversations.push(row);
    }
  }
  return {
    conversations,
    snapshotAt: first.snapshotAt,
    hasMore: Boolean(pages[pages.length - 1]?.nextCursor),
  };
}

// --- context

const CONTEXT_KEYS = [
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
] as const;

function eligibleList(value: unknown, path: string): SmsConversationEligibleList {
  const row = record(value, path);
  exactKeys(row, ["id", "name", "description", "consentSource", "consentAt"], path);
  const id = text(row.id, `${path}.id`, 36);
  if (!UUID_V4.test(id)) {
    throw new SmsLookupContractError(`${path}.id must be a canonical UUIDv4`);
  }
  const name = safeLabel(row.name, `${path}.name`, 256);
  if (name.trim() !== name) {
    throw new SmsLookupContractError(`${path}.name has surrounding whitespace`);
  }
  const description = safeLabel(row.description, `${path}.description`, 2048, true);
  let consentSource: string | undefined;
  if (row.consentSource !== undefined) {
    consentSource = text(row.consentSource, `${path}.consentSource`, 32);
    if (!ELIGIBLE_CONSENT_SOURCES.has(consentSource)) {
      throw new SmsLookupContractError(`${path}.consentSource is unknown`);
    }
  }
  const consentAt = optionalTimestamp(row, "consentAt", path);
  return {
    id,
    name,
    description,
    ...(consentSource ? { consentSource } : {}),
    ...(consentAt ? { consentAt } : {}),
  };
}

/** Decode GET /api/v1/sms/conversations/{phone}/context for exactly one phone. */
export function decodeSmsConversationContext(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsConversationContext {
  const source = record(raw, "context");
  exactKeys(source, CONTEXT_KEYS, "context");
  const tenantId = tenant(source.tenantId, expected.tenantId, "context");
  const phoneE164 = phone(source.phoneE164, "context.phoneE164");
  if (phoneE164 !== expected.phoneE164) {
    throw new SmsLookupContractError("context belongs to another phone");
  }
  const consentStatus = source.consentStatus;
  if (!(SMS_CONSENT_STATUSES as readonly unknown[]).includes(consentStatus)) {
    throw new SmsLookupContractError("context.consentStatus is unknown");
  }
  let consentSource: string | undefined;
  if (source.consentSource !== undefined) {
    consentSource = text(source.consentSource, "context.consentSource", 32);
    if (!SUMMARY_CONSENT_SOURCES.has(consentSource)) {
      throw new SmsLookupContractError("context.consentSource is unknown");
    }
  }
  const subscriberEmail =
    source.subscriberEmail === undefined
      ? undefined
      : safeLabel(source.subscriberEmail, "context.subscriberEmail", 320);
  if (!Array.isArray(source.eligibleLists) || source.eligibleLists.length > 500) {
    throw new SmsLookupContractError("context.eligibleLists must be a bounded array");
  }
  const eligibleLists = source.eligibleLists.map((value, index) =>
    eligibleList(value, `context.eligibleLists[${index}]`),
  );
  let suppressionReason: string | undefined;
  if (source.suppressionReason !== undefined) {
    suppressionReason = text(source.suppressionReason, "context.suppressionReason", 32);
    if (!SUPPRESSION_REASONS.has(suppressionReason)) {
      throw new SmsLookupContractError("context.suppressionReason is unknown");
    }
  }
  let replyDispatchUnavailableReason: string | undefined;
  if (source.replyDispatchUnavailableReason !== undefined) {
    replyDispatchUnavailableReason = text(
      source.replyDispatchUnavailableReason,
      "context.replyDispatchUnavailableReason",
      64,
    );
    if (!REPLY_DISPATCH_REASONS.has(replyDispatchUnavailableReason)) {
      throw new SmsLookupContractError(
        "context.replyDispatchUnavailableReason is unknown",
      );
    }
  }
  const result: SmsConversationContext = {
    tenantId,
    phoneE164,
    ...(subscriberEmail ? { subscriberEmail } : {}),
    consentStatus: consentStatus as SmsConsentPosture,
    ...(consentSource ? { consentSource } : {}),
    ...(optionalTimestamp(source, "consentAt", "context")
      ? { consentAt: optionalTimestamp(source, "consentAt", "context") }
      : {}),
    ...(optionalTimestamp(source, "optOutAt", "context")
      ? { optOutAt: optionalTimestamp(source, "optOutAt", "context") }
      : {}),
    consentMixed: bool(source.consentMixed, "context.consentMixed"),
    identityAmbiguous: bool(source.identityAmbiguous, "context.identityAmbiguous"),
    consentEvidenceSufficient: bool(
      source.consentEvidenceSufficient,
      "context.consentEvidenceSufficient",
    ),
    subscribedLists: integer(source.subscribedLists, "context.subscribedLists"),
    ...(optionalTimestamp(source, "firstSeenAt", "context")
      ? { firstSeenAt: optionalTimestamp(source, "firstSeenAt", "context") }
      : {}),
    totalMessages: integer(source.totalMessages, "context.totalMessages"),
    ...(optionalTimestamp(source, "lastReadAt", "context")
      ? { lastReadAt: optionalTimestamp(source, "lastReadAt", "context") }
      : {}),
    suppressed: bool(source.suppressed, "context.suppressed"),
    ...(suppressionReason ? { suppressionReason } : {}),
    suppressionReversible: bool(
      source.suppressionReversible,
      "context.suppressionReversible",
    ),
    hasInboundThread: bool(source.hasInboundThread, "context.hasInboundThread"),
    eligibleLists,
    replyDispatchAvailable: bool(
      source.replyDispatchAvailable,
      "context.replyDispatchAvailable",
    ),
    ...(replyDispatchUnavailableReason ? { replyDispatchUnavailableReason } : {}),
  };
  if (
    (result.identityAmbiguous && result.subscriberEmail) ||
    result.subscribedLists !== result.eligibleLists.length ||
    result.consentEvidenceSufficient !== result.subscribedLists > 0 ||
    (result.consentStatus === "opted_in") !== result.consentEvidenceSufficient ||
    (result.suppressed && !result.suppressionReason) ||
    (!result.suppressed &&
      (result.suppressionReason !== undefined || result.suppressionReversible)) ||
    result.replyDispatchAvailable ===
      (result.replyDispatchUnavailableReason !== undefined)
  ) {
    throw new SmsLookupContractError("context fields contradict each other");
  }
  return result;
}

// --- CSV export

/**
 * Parse the server truth headers ExportConversationsCSV sets. Returns null
 * when any is missing or contradictory, so the caller refuses the file
 * instead of saving an export whose bounds it cannot state.
 */
export function parseSmsConversationsExportTruth(
  headers: Headers,
): SmsConversationsExportTruth | null {
  const limitRaw = headers.get("X-Postwave-Export-Limit");
  const asOf = headers.get("X-Postwave-Export-As-Of");
  const rowCountRaw = headers.get("X-Postwave-Export-Row-Count");
  const truncatedRaw = headers.get("X-Postwave-Truncated");
  if (!limitRaw || !asOf || !rowCountRaw) return null;
  if (!/^[0-9]{1,6}$/u.test(limitRaw) || !/^[0-9]{1,6}$/u.test(rowCountRaw)) {
    return null;
  }
  const limit = Number(limitRaw);
  const rowCount = Number(rowCountRaw);
  if (
    limit <= 0 ||
    rowCount > limit ||
    !RFC3339.test(asOf) ||
    !Number.isFinite(Date.parse(asOf)) ||
    (truncatedRaw !== "true" && truncatedRaw !== "false") ||
    (truncatedRaw === "true" && rowCount !== limit)
  ) {
    return null;
  }
  return { limit, asOf, rowCount, truncated: truncatedRaw === "true" };
}

/**
 * The CSV body must start with the server's exact header row and carry exactly
 * the number of data rows the Row-Count header states.
 */
export function smsConversationsCsvMatchesTruth(
  csv: string,
  truth: SmsConversationsExportTruth,
): boolean {
  const lines = csv.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    lines[0]?.replace(/\r$/u, "") === SMS_CONVERSATIONS_CSV_HEADER &&
    lines.length - 1 === truth.rowCount
  );
}

/**
 * The Content-Disposition filename only when it is a plain `.csv` name (no
 * path, no controls, no encoding tricks); otherwise a dated fallback.
 */
export function smsConversationsExportFilename(
  contentDisposition: string | null,
  asOf: string,
): string {
  const candidate = /filename="([A-Za-z0-9._-]{1,128})"/u.exec(
    contentDisposition ?? "",
  )?.[1];
  if (candidate && candidate.endsWith(".csv") && !candidate.startsWith(".")) {
    return candidate;
  }
  return `postwave-sms-conversations-${new Date(asOf).toISOString().slice(0, 10)}.csv`;
}
