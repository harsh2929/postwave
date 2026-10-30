/**
 * smsBroadcastWire — pure validation and decoding for SMS broadcast DRAFT
 * management.
 *
 * ROUTES (apps/api/internal/sms/handlers.go:190-196, all behind
 * `protectSMSInboxResponse` + `RequireExactTenantAdmin`):
 *   GET    /api/v1/sms/broadcasts               list + dispatch availability
 *   POST   /api/v1/sms/broadcasts               create draft
 *   GET    /api/v1/sms/broadcasts/{id}
 *   PATCH  /api/v1/sms/broadcasts/{id}          draft|scheduled only (409 else)
 *   DELETE /api/v1/sms/broadcasts/{id}          not while sending
 *   GET    /api/v1/sms/broadcasts/{id}/progress {status,sent,failed,held,total}
 *
 * THE RELEASE HOLD IS REAL AND IT IS NOT HERE. Only POST .../{id}/send is
 * gated by `smsDispatchSagaReleaseReady` (handlers.go:268 matches exactly
 * `broadcasts/{id}/send`); every route above runs normally while dispatch is
 * held, and the list response says so itself via
 * `broadcastDispatchAvailable` + `broadcastDispatchUnavailableReason`
 * (broadcast_handlers.go:100). This module deliberately has NO send shape —
 * wiring the send would wire a 503.
 *
 * Server-enforced rules the client mirrors (broadcasts.go):
 *   - name required on create, 1..256 safe code points;
 *   - body optional on a draft, but within the SMS body contract and ≤ 10
 *     segments when present;
 *   - AT MOST ONE audience dimension (lists | segment | tag).
 */
import { SmsContractError } from "./smsConversation";
import { segmentInfo } from "./smsSegments";
import { isValidSmsInboxBody } from "./smsBodyContract";
import {
  wireBoolean,
  wireExactKeys,
  wireInteger,
  wireNextCursor,
  wireObject,
  wireOptionalString,
  wireOptionalTimestamp,
  wireString,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export const SMS_BROADCAST_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const;
export type SmsBroadcastStatus = (typeof SMS_BROADCAST_STATUSES)[number];

const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

export function smsBroadcastNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "The broadcast needs a name.";
  if (Array.from(trimmed).length > 256) {
    return "Names are limited to 256 characters.";
  }
  if (FORBIDDEN.test(trimmed)) {
    return "Names cannot contain control or invisible characters.";
  }
  return null;
}

export function smsBroadcastBodyError(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === "") return null; // a draft may be bodyless
  if (!isValidSmsInboxBody(trimmed)) {
    return "The message is outside the SMS body contract (too long or unsafe characters).";
  }
  if (segmentInfo(trimmed).segments > 10) {
    return "The message exceeds 10 SMS segments.";
  }
  return null;
}

export interface SmsBroadcast {
  id: string;
  name: string;
  body: string;
  status: SmsBroadcastStatus;
  listIds: string[];
  segmentId?: string | undefined;
  tag?: string | undefined;
  senderProfileId?: string | undefined;
  scheduledAt?: string | undefined;
  sentCount: number;
  failedCount: number;
  heldCount: number;
  segmentsPerMessage: number;
  createdAt: string;
  updatedAt: string;
}

/** One honest sentence describing the audience dimension, or its absence. */
export function smsBroadcastAudienceLine(
  broadcast: Pick<SmsBroadcast, "listIds" | "segmentId" | "tag">,
): string {
  if (broadcast.listIds.length > 0) {
    return broadcast.listIds.length === 1
      ? "Audience: 1 list"
      : `Audience: ${broadcast.listIds.length} lists`;
  }
  if (broadcast.segmentId) return "Audience: a segment";
  if (broadcast.tag) return `Audience: tag “${broadcast.tag}”`;
  return "No audience selected yet";
}

function decodeBroadcast(entry: unknown, path: string): SmsBroadcast {
  const row = wireObject(entry, path);
  wireExactKeys(
    row,
    [
      "id",
      "tenant_id",
      "sender_profile_id",
      "campaign_id",
      "name",
      "body",
      "list_ids",
      "segment_id",
      "tag",
      "status",
      "scheduled_at",
      "sent_count",
      "failed_count",
      "held_count",
      "segments_per_message",
      "created_at",
      "updated_at",
    ],
    path,
  );
  const status = String(row.status);
  if (!SMS_BROADCAST_STATUSES.includes(status as SmsBroadcastStatus)) {
    throw new SmsContractError(`${path}.status is unknown`);
  }
  if (!Array.isArray(row.list_ids) || row.list_ids.length > 100) {
    throw new SmsContractError(`${path}.list_ids must be an array`);
  }
  const listIds = row.list_ids.map((id, index) =>
    wireUuid(id, `${path}.list_ids[${index}]`),
  );
  const segmentId = wireOptionalString(row, "segment_id", path, 36);
  const tag = wireOptionalString(row, "tag", path, 64);
  const senderProfileId = wireOptionalString(row, "sender_profile_id", path, 36);
  const scheduledAt = wireOptionalTimestamp(row, "scheduled_at", path);
  if (row.campaign_id !== undefined) {
    wireString(row.campaign_id, `${path}.campaign_id`, { max: 64 });
  }
  return {
    id: wireUuid(row.id, `${path}.id`),
    name: wireString(row.name, `${path}.name`, { max: 256 }),
    body: wireString(row.body, `${path}.body`, { max: 16_384, empty: true }),
    status: status as SmsBroadcastStatus,
    listIds,
    ...(segmentId ? { segmentId: wireUuid(segmentId, `${path}.segment_id`) } : {}),
    ...(tag ? { tag } : {}),
    ...(senderProfileId
      ? { senderProfileId: wireUuid(senderProfileId, `${path}.sender_profile_id`) }
      : {}),
    ...(scheduledAt ? { scheduledAt } : {}),
    sentCount: wireInteger(row.sent_count, `${path}.sent_count`),
    failedCount: wireInteger(row.failed_count, `${path}.failed_count`),
    heldCount: wireInteger(row.held_count, `${path}.held_count`),
    segmentsPerMessage: wireInteger(
      row.segments_per_message,
      `${path}.segments_per_message`,
    ),
    createdAt: wireTimestamp(row.created_at, `${path}.created_at`),
    updatedAt: wireTimestamp(row.updated_at, `${path}.updated_at`),
  };
}

export interface SmsBroadcastsPage {
  tenantId: string;
  items: SmsBroadcast[];
  snapshotAt: string;
  nextCursor?: string | undefined;
  dispatchAvailable: boolean;
  dispatchUnavailableReason?: string | undefined;
}

export function decodeSmsBroadcastsPage(
  raw: unknown,
  expected: { tenantId: string },
): SmsBroadcastsPage {
  const src = wireObject(raw, "broadcasts response");
  wireExactKeys(
    src,
    [
      "tenantId",
      "items",
      "nextCursor",
      "snapshotAt",
      "broadcastDispatchAvailable",
      "broadcastDispatchUnavailableReason",
    ],
    "broadcasts response",
  );
  const tenantId = wireUuid(src.tenantId, "broadcasts response.tenantId");
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError("broadcasts response belongs to another tenant");
  }
  if (!Array.isArray(src.items) || src.items.length > 200) {
    throw new SmsContractError(
      "broadcasts response.items must be an array of at most 200 rows",
    );
  }
  const seen = new Set<string>();
  const items = src.items.map((entry, index) => {
    const broadcast = decodeBroadcast(entry, `broadcasts response.items[${index}]`);
    if (seen.has(broadcast.id)) {
      throw new SmsContractError(
        `broadcasts response.items[${index}] duplicates ${broadcast.id}`,
      );
    }
    seen.add(broadcast.id);
    return broadcast;
  });
  const dispatchAvailable = wireBoolean(
    src.broadcastDispatchAvailable,
    "broadcasts response.broadcastDispatchAvailable",
  );
  const dispatchUnavailableReason = wireOptionalString(
    src,
    "broadcastDispatchUnavailableReason",
    "broadcasts response",
    128,
  );
  if (dispatchAvailable && dispatchUnavailableReason) {
    throw new SmsContractError(
      "broadcasts response dispatch availability is inconsistent",
    );
  }
  const cursor = wireNextCursor(src, "broadcasts response");
  return {
    tenantId,
    items,
    snapshotAt: wireTimestamp(src.snapshotAt, "broadcasts response.snapshotAt"),
    ...(cursor ? { nextCursor: cursor } : {}),
    dispatchAvailable,
    ...(dispatchUnavailableReason ? { dispatchUnavailableReason } : {}),
  };
}

export function decodeSmsBroadcast(raw: unknown): SmsBroadcast {
  return decodeBroadcast(raw, "broadcast");
}

export interface SmsBroadcastProgress {
  status: SmsBroadcastStatus;
  sent: number;
  failed: number;
  held: number;
  total: number;
}

export function decodeSmsBroadcastProgress(raw: unknown): SmsBroadcastProgress {
  const src = wireObject(raw, "broadcast progress");
  wireExactKeys(
    src,
    ["status", "sent", "failed", "held", "total"],
    "broadcast progress",
  );
  const status = String(src.status);
  if (!SMS_BROADCAST_STATUSES.includes(status as SmsBroadcastStatus)) {
    throw new SmsContractError("broadcast progress.status is unknown");
  }
  const progress = {
    status: status as SmsBroadcastStatus,
    sent: wireInteger(src.sent, "broadcast progress.sent"),
    failed: wireInteger(src.failed, "broadcast progress.failed"),
    held: wireInteger(src.held, "broadcast progress.held"),
    total: wireInteger(src.total, "broadcast progress.total"),
  };
  if (progress.sent + progress.failed + progress.held > progress.total) {
    throw new SmsContractError(
      "broadcast progress counters exceed the recorded total",
    );
  }
  return progress;
}

export interface SmsBroadcastDraftInput {
  name?: string | undefined;
  body?: string | undefined;
  tag?: string | undefined;
}

/**
 * The PATCH/POST body: only supplied fields travel (pointer semantics
 * server-side), and the tag may only be authored when no list/segment
 * audience exists — the caller enforces that with `existing`.
 */
export function smsBroadcastUpsertBody(
  input: SmsBroadcastDraftInput,
  existing?: Pick<SmsBroadcast, "listIds" | "segmentId">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const invalid = smsBroadcastNameError(input.name);
    if (invalid) throw new Error(invalid);
    out.name = input.name.trim();
  }
  if (input.body !== undefined) {
    const invalid = smsBroadcastBodyError(input.body);
    if (invalid) throw new Error(invalid);
    out.body = input.body.trim();
  }
  if (input.tag !== undefined) {
    const tag = input.tag.trim();
    if (tag !== "" && (Array.from(tag).length > 64 || FORBIDDEN.test(tag))) {
      throw new Error("Audience tags are limited to 64 safe characters.");
    }
    if (
      tag !== "" &&
      existing &&
      (existing.listIds.length > 0 || existing.segmentId)
    ) {
      throw new Error(
        "This broadcast already targets lists or a segment; clear that audience first (a broadcast has at most one audience dimension).",
      );
    }
    out.tag = tag;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Nothing to save.");
  }
  return out;
}
