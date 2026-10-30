/**
 * smsBulkAction — pure request-shaping and receipt decoding for
 * `POST /api/v1/sms/conversations/bulk` (`BulkConversationAction`,
 * apps/api/internal/sms/inbox_extras.go:66,942-1116).
 *
 * SERVER CONTRACT WORTH RESTATING:
 *  - Body: `{conversations: [{phoneE164, expectedUpdatedAt}], action, until?}`.
 *    `expectedUpdatedAt` is REQUIRED per target — the row's `stateUpdatedAt`,
 *    or explicit null for a conversation whose lifecycle was never touched.
 *    An omitted field is a 400, and a stale value is a 409 that rolls back the
 *    WHOLE batch (all-or-nothing, deliberately conflict-loud).
 *  - Actions: archive | unarchive | snooze | unsnooze. `mark_read` is refused
 *    (400) because read state needs exact message boundaries; do not offer it.
 *  - At most 200 unique phones; `until` required for snooze, ≤ 366 days out.
 */
import {
  SmsContractError,
  type SmsConversationSummary,
} from "./smsConversation";
import {
  wireBoolean,
  wireExactKeys,
  wireInteger,
  wireObject,
  wireOptionalTimestamp,
  wirePhone,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export const SMS_BULK_MAX_TARGETS = 200;

export type SmsBulkAction = "archive" | "unarchive" | "snooze" | "unsnooze";

export interface SmsBulkTarget {
  phoneE164: string;
  /** The loaded row's `stateUpdatedAt`, or null when the row carries none. */
  expectedUpdatedAt: string | null;
}

export interface SmsBulkActionInput {
  conversations: readonly SmsBulkTarget[];
  action: SmsBulkAction;
  /** RFC3339, required for snooze; must be in the future. */
  until?: string | undefined;
}

export interface SmsBulkRequestBody {
  conversations: { phoneE164: string; expectedUpdatedAt: string | null }[];
  action: SmsBulkAction;
  until?: string;
}

/** Build selection targets from loaded rows, carrying each CAS token. */
export function smsBulkTargetsFrom(
  rows: readonly Pick<
    SmsConversationSummary,
    "phoneE164" | "stateUpdatedAt"
  >[],
): SmsBulkTarget[] {
  return rows.map((row) => ({
    phoneE164: row.phoneE164,
    expectedUpdatedAt: row.stateUpdatedAt ?? null,
  }));
}

const E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;

/** Validate and shape the request body, throwing operator-readable errors. */
export function smsBulkRequestBody(
  input: SmsBulkActionInput,
): SmsBulkRequestBody {
  if (input.conversations.length === 0) {
    throw new Error("Select at least one conversation first.");
  }
  if (input.conversations.length > SMS_BULK_MAX_TARGETS) {
    throw new Error(
      `Bulk actions are limited to ${SMS_BULK_MAX_TARGETS} conversations at once.`,
    );
  }
  const seen = new Set<string>();
  const conversations = input.conversations.map((target) => {
    if (!E164.test(target.phoneE164)) {
      throw new Error("Every selected conversation needs a valid +1 number.");
    }
    if (seen.has(target.phoneE164)) {
      throw new Error("A conversation was selected twice.");
    }
    seen.add(target.phoneE164);
    if (
      target.expectedUpdatedAt !== null &&
      !Number.isFinite(Date.parse(target.expectedUpdatedAt))
    ) {
      throw new Error(
        "A selected conversation carries an unreadable lifecycle version.",
      );
    }
    return {
      phoneE164: target.phoneE164,
      expectedUpdatedAt: target.expectedUpdatedAt,
    };
  });
  if (!["archive", "unarchive", "snooze", "unsnooze"].includes(input.action)) {
    throw new Error("Unknown bulk action.");
  }
  if (input.action === "snooze") {
    const until = input.until ? Date.parse(input.until) : Number.NaN;
    if (!Number.isFinite(until) || until <= Date.now()) {
      throw new Error("Snooze needs a deadline in the future.");
    }
    return { conversations, action: input.action, until: input.until as string };
  }
  return { conversations, action: input.action };
}

export interface SmsBulkRowReceipt {
  phoneE164: string;
  stateUpdatedAt: string;
  snoozeUntil?: string | undefined;
  archivedAt?: string | undefined;
}

export interface SmsBulkActionReceipt {
  tenantId: string;
  action: SmsBulkAction;
  applied: number;
  receipts: SmsBulkRowReceipt[];
}

export function decodeSmsBulkActionReceipt(
  raw: unknown,
  expected: { tenantId: string; action: SmsBulkAction; phones: string[] },
): SmsBulkActionReceipt {
  const src = wireObject(raw, "bulk receipt");
  wireExactKeys(
    src,
    ["ok", "tenantId", "action", "applied", "receipts"],
    "bulk receipt",
  );
  if (src.ok !== true) throw new SmsContractError("bulk receipt is not ok");
  const tenantId = wireUuid(src.tenantId, "bulk receipt.tenantId");
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError("bulk receipt belongs to another tenant");
  }
  if (src.action !== expected.action) {
    throw new SmsContractError("bulk receipt echoes another action");
  }
  const applied = wireInteger(src.applied, "bulk receipt.applied");
  if (!Array.isArray(src.receipts) || src.receipts.length !== applied) {
    throw new SmsContractError("bulk receipt rows disagree with applied count");
  }
  if (applied !== expected.phones.length) {
    throw new SmsContractError(
      "bulk receipt applied count disagrees with the selection",
    );
  }
  const expectedSet = new Set(expected.phones);
  const seen = new Set<string>();
  const receipts = src.receipts.map((entry, index) => {
    const path = `bulk receipt.receipts[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(
      row,
      [
        "ok",
        "tenantId",
        "phoneE164",
        "action",
        "snoozeUntil",
        "archivedAt",
        "assigneeUserId",
        "stateUpdatedAt",
      ],
      path,
    );
    wireBoolean(row.ok, `${path}.ok`);
    const phoneE164 = wirePhone(row.phoneE164, `${path}.phoneE164`);
    if (!expectedSet.has(phoneE164)) {
      throw new SmsContractError(`${path} names an unselected conversation`);
    }
    if (seen.has(phoneE164)) {
      throw new SmsContractError(`${path} duplicates ${phoneE164}`);
    }
    seen.add(phoneE164);
    const snoozeUntil = wireOptionalTimestamp(row, "snoozeUntil", path);
    const archivedAt = wireOptionalTimestamp(row, "archivedAt", path);
    return {
      phoneE164,
      stateUpdatedAt: wireTimestamp(row.stateUpdatedAt, `${path}.stateUpdatedAt`),
      ...(snoozeUntil ? { snoozeUntil } : {}),
      ...(archivedAt ? { archivedAt } : {}),
    };
  });
  return { tenantId, action: expected.action, applied, receipts };
}
