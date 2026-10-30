/**
 * smsInboxContracts — the PURE request/response half of `@/api/smsInbox`.
 *
 * Split for the same reason `eventBus.ts` was split into `eventBusStream.ts`
 * and `eventBusConnection.ts`: one file was carrying two jobs. What lives
 * where, and why:
 *
 *   HERE   — everything that decides, with no network in sight: the argument
 *            validators an SMS route refuses without (`requirePhone`,
 *            `requireUuid`, `boundedLimit`, `addCursor`), the query builder for
 *            the conversation list, the snooze bound mirrored from the handler,
 *            and every RECEIPT DECODER. These are total functions over plain
 *            values, so they are exercised in the node vitest environment
 *            directly rather than only through a mocked transport.
 *
 *   THERE  — `smsInbox.ts` keeps the transport: `rawRequest`, `SmsInboxError`,
 *            the route strings, and the doc comments that record which mount
 *            block and which auth chain each route sits behind.
 *
 * NOTHING HERE IS LENIENT. Every decoder rejects an unexpected key, a receipt
 * acknowledged for another tenant, or a phone that is not the one that was
 * asked for. A 200 that does not actually say what was requested is a failure,
 * not something to paint as success.
 */
import {
  isValidSmsReplyBody,
  SMS_REPLY_PRODUCT_MAX_CODE_POINTS,
  smsUtf8Bytes,
} from "@/lib/smsBodyContract";
import type {
  SmsConversationFilter,
  SmsConversationSort,
  SmsConversationStatus,
} from "@/lib/smsConversation";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function boundedLimit(
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("SMS page limit must be an integer from 1 to 100.");
  }
  return limit;
}

export function addCursor(
  params: URLSearchParams,
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (!value || value.length > 4096 || CONTROL_CHARS.test(value)) {
    throw new Error("SMS cursor is invalid.");
  }
  params.set("cursor", value);
}

export function requirePhone(phone: string): string {
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
    throw new Error("A valid US/Canada (+1) phone is required.");
  }
  return phone;
}

export function requireUuid(value: string, label: string): string {
  if (!UUID_V4.test(value)) {
    throw new Error(`${label} must be a canonical lowercase UUIDv4.`);
  }
  return value;
}

export interface SmsConversationsQuery {
  filter: SmsConversationFilter;
  sort: SmsConversationSort;
  status: SmsConversationStatus;
  search: string;
}

/**
 * The query string for `GET /api/v1/sms/conversations`, plus the resolved
 * triple the decoder is then told to hold the response to.
 */
export function smsConversationsQuery(options: {
  filter?: SmsConversationFilter;
  sort?: SmsConversationSort;
  status?: SmsConversationStatus;
  limit?: number;
  cursor?: string;
}): SmsConversationsQuery {
  const params = new URLSearchParams();
  const filter = options.filter ?? "all";
  const sort = options.sort ?? "recent";
  const status = options.status ?? "active";
  if (!["all", "unread", "unknown"].includes(filter)) {
    throw new Error("Unknown SMS conversation filter.");
  }
  if (!["active", "snoozed", "archived", "any"].includes(status)) {
    throw new Error("Unknown SMS conversation lifecycle status.");
  }
  if (!["recent", "oldest_unread"].includes(sort)) {
    throw new Error("Unknown SMS conversation order.");
  }
  if (filter !== "all") params.set("filter", filter);
  params.set("sort", sort);
  params.set("status", status);
  params.set("limit", String(boundedLimit(options.limit, 40)));
  addCursor(params, options.cursor);
  return { filter, sort, status, search: params.toString() };
}

/** The messages-page query string for one conversation. */
export function smsMessagesQuery(input: {
  limit?: number;
  cursor?: string;
}): string {
  const params = new URLSearchParams({
    limit: String(boundedLimit(input.limit, 50)),
  });
  addCursor(params, input.cursor);
  return params.toString();
}

/** At most 200 safe characters, mirrored from the pause handler. */
export function requireSmsPauseReason(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length > 200 || CONTROL_CHARS.test(trimmed)) {
    throw new Error("Pause reason must be at most 200 safe characters.");
  }
  return trimmed;
}

/**
 * Re-derives `paused` from the returned sender profile exactly the way
 * `decodeSmsSenders` derives it (`metadata.paused` OR `metadata.sending.paused`)
 * and compares it with what was asked. A 200 that did not actually change the
 * state is reported as a failure rather than painted as success.
 */
export function decodeSmsSenderPaused(
  raw: unknown,
  expected: {
    senderId: string;
    tenantId: string;
    paused: boolean;
    label: string;
  },
): { id: string; paused: boolean } {
  const { senderId, tenantId, label } = expected;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} returned an invalid sender profile.`);
  }
  const row = raw as Record<string, unknown>;
  if (row.id !== senderId) {
    throw new Error(`${label} returned a different sender profile.`);
  }
  if (row.tenant_id !== undefined && row.tenant_id !== tenantId) {
    throw new Error(`${label} returned another workspace's sender profile.`);
  }
  const metadata = plainObject(row.metadata);
  const sending = plainObject(metadata.sending);
  const paused = metadata.paused === true || sending.paused === true;
  if (paused !== expected.paused) {
    throw new Error(
      expected.paused
        ? "The server did not report this sender as paused. Nothing was changed on screen."
        : "The server did not report this sender as sending again. Nothing was changed on screen.",
    );
  }
  return { id: senderId, paused };
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface SmsConversationStateReceipt {
  ok: true;
  tenantId: string;
  phoneE164: string;
}

/** Mirrors the server's own bound at inbox_extras.go:88 (`366*24*time.Hour`). */
export const SMS_SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * The first reason this snooze cannot be accepted, or null.
 *
 * Mirrored from the handler so the app never sends a body whose only possible
 * outcome is a 422: `until must be in the future and no more than 366 days
 * away` (inbox_extras.go:86-90).
 */
export function smsSnoozeUntilError(
  until: string,
  now: number = Date.now(),
): string | null {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) {
    return "A snooze needs a valid date and time.";
  }
  if (at <= now) {
    return "A snooze has to end in the future.";
  }
  if (at > now + SMS_SNOOZE_MAX_MS) {
    return "A snooze cannot be more than 366 days away.";
  }
  return null;
}

/**
 * The lifecycle receipt is `{ok, tenantId, phoneE164}` and is checked against
 * the conversation that was asked for. A write acknowledged for a different
 * tenant or a different number is never treated as success.
 */
export function decodeSmsConversationStateReceipt(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
  label: string,
): SmsConversationStateReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} returned an invalid receipt.`);
  }
  const receipt = raw as Record<string, unknown>;
  if (
    Object.keys(receipt).some(
      (key) => key !== "ok" && key !== "tenantId" && key !== "phoneE164",
    ) ||
    receipt.ok !== true ||
    receipt.tenantId !== expected.tenantId ||
    receipt.phoneE164 !== expected.phoneE164
  ) {
    throw new Error(`${label} returned an invalid receipt.`);
  }
  return {
    ok: true,
    tenantId: expected.tenantId,
    phoneE164: expected.phoneE164,
  };
}

/**
 * `userId: null` (or "") unassigns — the server reads an empty `userId` as
 * `assignee_user_id = NULL` (inbox_extras.go:128-131) and validates a supplied
 * one against active tenant membership (:203-215), which is why an invalid
 * shape is refused here rather than sent.
 */
export function requireSmsAssignee(userId: string | null): string {
  return userId === null || userId === ""
    ? ""
    : requireUuid(userId, "Assignee");
}

export const MAX_SMS_REPLY_CODE_POINTS = SMS_REPLY_PRODUCT_MAX_CODE_POINTS;

/** The trimmed reply body, or a throw naming the product bound. */
export function requireSmsReplyBody(body: string): string {
  const trimmed = body.trim();
  if (!isValidSmsReplyBody(trimmed)) {
    throw new Error(
      `Reply must contain 1–${MAX_SMS_REPLY_CODE_POINTS} characters.`,
    );
  }
  return trimmed;
}

export function requireSmsReplyIdempotencyKey(key: string): string {
  if (!key || smsUtf8Bytes(key) > 255 || CONTROL_CHARS.test(key)) {
    throw new Error("Reply intent key is invalid.");
  }
  return key;
}

/** 1–500 distinct inbound message IDs — the server's own read boundary. */
export function requireSmsReadBoundary(messageIds: string[]): string[] {
  if (
    !Array.isArray(messageIds) ||
    messageIds.length < 1 ||
    messageIds.length > 500
  ) {
    throw new Error(
      "A read boundary of 1–500 inbound message IDs is required.",
    );
  }
  const seen = new Set<string>();
  return messageIds.map((id) => {
    if (!UUID_V4.test(id) || seen.has(id)) {
      throw new Error(
        "SMS read boundary contains an invalid or duplicate message ID.",
      );
    }
    seen.add(id);
    return id;
  });
}

export function decodeSmsMarkReadReceipt(
  raw: unknown,
  requested: number,
): { ok: true; applied: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Marking as read returned an invalid receipt.");
  }
  const receipt = raw as Record<string, unknown>;
  if (
    Object.keys(receipt).some((key) => key !== "ok" && key !== "applied") ||
    receipt.ok !== true ||
    !Number.isSafeInteger(receipt.applied) ||
    (receipt.applied as number) < 0 ||
    (receipt.applied as number) > requested
  ) {
    throw new Error("Marking as read returned an invalid receipt.");
  }
  return { ok: true, applied: receipt.applied as number };
}
