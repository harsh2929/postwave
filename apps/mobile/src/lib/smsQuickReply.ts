/**
 * smsQuickReply — pure validation and decoding for the canned-response
 * library.
 *
 * ROUTES (apps/api/internal/sms/inbox_extras.go:70-74, all behind
 * `protectSMSInboxResponse` + `RequireExactTenantAdmin`, none release-held):
 *   GET    /api/v1/sms/quick-replies            list, ranked most-used first
 *   POST   /api/v1/sms/quick-replies            {label, body} → 201
 *   PATCH  /api/v1/sms/quick-replies/{id}       {label?, body?}
 *   DELETE /api/v1/sms/quick-replies/{id}
 *   POST   /api/v1/sms/quick-replies/{id}/use   bump use_count + last_used_at
 *
 * The library is capped at 500 per tenant (409 `quick_reply_limit_reached`).
 * NOTE THE DISPATCH CAVEAT: inserting a quick reply into the composer works
 * today, but the reply SEND itself is release-held server-side
 * (`sms_reply_dispatch_release_held`), so inserted text cannot dispatch until
 * that hold lifts. The picker must not promise otherwise.
 */
import { isValidSmsReplyBody } from "./smsBodyContract";
import { SmsContractError } from "./smsConversation";
import {
  wireBoolean,
  wireExactKeys,
  wireInteger,
  wireObject,
  wireOptionalTimestamp,
  wireString,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export const SMS_QUICK_REPLY_LABEL_MAX = 80;
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

export function smsQuickReplyLabelError(label: string): string | null {
  if (label.trim() !== label || label === "") {
    return "Labels need 1 to 80 characters without leading or trailing spaces.";
  }
  if (Array.from(label).length > SMS_QUICK_REPLY_LABEL_MAX) {
    return "Labels are limited to 80 characters.";
  }
  if (FORBIDDEN.test(label)) {
    return "Labels cannot contain control or invisible characters.";
  }
  return null;
}

export function smsQuickReplyBodyError(body: string): string | null {
  if (body.trim() === "") return "The reply text cannot be empty.";
  if (!isValidSmsReplyBody(body)) {
    return "The reply text is outside the SMS body contract (too long or unsafe characters).";
  }
  return null;
}

export interface SmsQuickReply {
  id: string;
  label: string;
  body: string;
  useCount: number;
  lastUsedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SmsQuickRepliesPage {
  tenantId: string;
  replies: SmsQuickReply[];
  snapshotAt: string;
  truncated: boolean;
}

function decodeReply(entry: unknown, path: string): SmsQuickReply {
  const row = wireObject(entry, path);
  wireExactKeys(
    row,
    ["id", "label", "body", "useCount", "lastUsedAt", "createdAt", "updatedAt"],
    path,
  );
  const label = wireString(row.label, `${path}.label`, { max: 80 });
  if (smsQuickReplyLabelError(label)) {
    throw new SmsContractError(`${path}.label violates the label contract`);
  }
  const body = wireString(row.body, `${path}.body`, { max: 16_384 });
  const lastUsedAt = wireOptionalTimestamp(row, "lastUsedAt", path);
  return {
    id: wireUuid(row.id, `${path}.id`),
    label,
    body,
    useCount: wireInteger(row.useCount, `${path}.useCount`),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    createdAt: wireTimestamp(row.createdAt, `${path}.createdAt`),
    updatedAt: wireTimestamp(row.updatedAt, `${path}.updatedAt`),
  };
}

export function decodeSmsQuickRepliesPage(
  raw: unknown,
  expected: { tenantId: string },
): SmsQuickRepliesPage {
  const src = wireObject(raw, "quick replies response");
  wireExactKeys(
    src,
    ["tenantId", "replies", "snapshotAt", "truncated"],
    "quick replies response",
  );
  const tenantId = wireUuid(src.tenantId, "quick replies response.tenantId");
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError(
      "quick replies response belongs to another tenant",
    );
  }
  if (!Array.isArray(src.replies) || src.replies.length > 500) {
    throw new SmsContractError(
      "quick replies response.replies must be an array of at most 500 rows",
    );
  }
  const seen = new Set<string>();
  const replies = src.replies.map((entry, index) => {
    const path = `quick replies response.replies[${index}]`;
    const reply = decodeReply(entry, path);
    if (seen.has(reply.id))
      throw new SmsContractError(`${path} duplicates ${reply.id}`);
    seen.add(reply.id);
    return reply;
  });
  return {
    tenantId,
    replies,
    snapshotAt: wireTimestamp(
      src.snapshotAt,
      "quick replies response.snapshotAt",
    ),
    truncated: wireBoolean(src.truncated, "quick replies response.truncated"),
  };
}

export function decodeSmsQuickReplyMutation(
  raw: unknown,
  expected: { tenantId: string; id?: string },
): SmsQuickReply {
  const src = wireObject(raw, "quick reply receipt");
  wireExactKeys(src, ["tenantId", "reply"], "quick reply receipt");
  const tenantId = wireUuid(src.tenantId, "quick reply receipt.tenantId");
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError("quick reply receipt belongs to another tenant");
  }
  const reply = decodeReply(src.reply, "quick reply receipt.reply");
  if (expected.id && reply.id !== expected.id) {
    throw new SmsContractError("quick reply receipt names another reply");
  }
  return reply;
}

export interface SmsQuickReplyDeleteReceipt {
  tenantId: string;
  id: string;
}

export function decodeSmsQuickReplyDelete(
  raw: unknown,
  expected: { tenantId: string; id: string },
): SmsQuickReplyDeleteReceipt {
  const src = wireObject(raw, "quick reply delete receipt");
  wireExactKeys(src, ["ok", "tenantId", "id"], "quick reply delete receipt");
  if (src.ok !== true) {
    throw new SmsContractError("quick reply delete receipt is not ok");
  }
  const tenantId = wireUuid(src.tenantId, "quick reply delete receipt.tenantId");
  const id = wireUuid(src.id, "quick reply delete receipt.id");
  if (tenantId !== expected.tenantId || id !== expected.id) {
    throw new SmsContractError(
      "quick reply delete receipt does not match the request",
    );
  }
  return { tenantId, id };
}

export interface SmsQuickReplyUseReceipt {
  tenantId: string;
  id: string;
  useCount: number;
  lastUsedAt: string;
}

export function decodeSmsQuickReplyUse(
  raw: unknown,
  expected: { tenantId: string; id: string },
): SmsQuickReplyUseReceipt {
  const src = wireObject(raw, "quick reply use receipt");
  wireExactKeys(
    src,
    ["ok", "tenantId", "id", "useCount", "lastUsedAt"],
    "quick reply use receipt",
  );
  if (src.ok !== true) {
    throw new SmsContractError("quick reply use receipt is not ok");
  }
  const tenantId = wireUuid(src.tenantId, "quick reply use receipt.tenantId");
  const id = wireUuid(src.id, "quick reply use receipt.id");
  if (tenantId !== expected.tenantId || id !== expected.id) {
    throw new SmsContractError(
      "quick reply use receipt does not match the request",
    );
  }
  return {
    tenantId,
    id,
    useCount: wireInteger(src.useCount, "quick reply use receipt.useCount"),
    lastUsedAt: wireTimestamp(
      src.lastUsedAt,
      "quick reply use receipt.lastUsedAt",
    ),
  };
}
