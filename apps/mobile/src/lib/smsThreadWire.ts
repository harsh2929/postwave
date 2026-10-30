/**
 * smsThreadWire — the strict decoder for `GET .../conversations/{phone}/messages`.
 *
 * Moved verbatim out of `smsConversationWire.ts` to bring that file back under
 * the 450-line source budget; the checks are unchanged. `smsConversation.ts`
 * re-exports `decodeSmsMessagesPage`, so no caller changed.
 */
import {
  SmsContractError,
  type SmsInboxBodyOmittedReason,
  type SmsMessage,
  type SmsMessagesPage,
} from "./smsConversation";
import { isValidSmsInboxBody } from "./smsBodyContract";
import {
  SMS_WIRE_TOKEN,
  wireDirection,
  wireExactKeys,
  wireInteger,
  wireNextCursor,
  wireObject,
  wireOptionalString,
  wireOptionalTimestamp,
  wirePhone,
  wireString,
  wireTenantEnvelope,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export function decodeSmsMessagesPage(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsMessagesPage {
  const src = wireObject(raw, "messages response");
  wireExactKeys(
    src,
    ["tenantId", "messages", "nextCursor", "snapshotAt"],
    "messages response",
  );
  const envelopeTenantId = wireTenantEnvelope(
    src,
    expected.tenantId,
    "messages response",
  );
  const snapshotAt = wireTimestamp(
    src.snapshotAt,
    "messages response.snapshotAt",
  );
  const snapshotTime = Date.parse(snapshotAt);
  if (!Array.isArray(src.messages) || src.messages.length > 100) {
    throw new SmsContractError("messages must be an array of at most 100 rows");
  }
  const seen = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  const messages = src.messages.map((entry, index) => {
    const path = `messages[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(
      row,
      [
        "id",
        "tenant_id",
        "campaign_id",
        "sender_profile_id",
        "phone_e164",
        "provider",
        "provider_message_id",
        "direction",
        "body",
        "body_omitted_reason",
        "media_url",
        "segments",
        "status",
        "error_code",
        "error_message",
        "cost_micros",
        "sent_at",
        "delivered_at",
        "received_at",
        "created_at",
        "dispatch_state",
      ],
      path,
    );
    const id = wireUuid(row.id, `${path}.id`);
    if (seen.has(id))
      throw new SmsContractError(`${path} duplicates message ${id}`);
    seen.add(id);
    const tenantId = wireUuid(row.tenant_id, `${path}.tenant_id`);
    if (tenantId !== expected.tenantId)
      throw new SmsContractError(`${path} belongs to another tenant`);
    const phoneE164 = wirePhone(row.phone_e164, `${path}.phone_e164`);
    if (phoneE164 !== expected.phoneE164)
      throw new SmsContractError(`${path} belongs to another phone`);
    const createdAt = wireTimestamp(row.created_at, `${path}.created_at`);
    const createdTime = Date.parse(createdAt);
    if (createdTime > snapshotTime) {
      throw new SmsContractError(
        `${path}.created_at is newer than the snapshot`,
      );
    }
    if (
      createdTime > previousAt ||
      (createdTime === previousAt && previousId !== "" && id >= previousId)
    ) {
      throw new SmsContractError(`${path} is out of newest-first order`);
    }
    previousAt = createdTime;
    previousId = id;
    const bodyOmittedReason = decodeBodyOmission(row, path);
    const body = wireString(row.body, `${path}.body`, {
      max: 16_384,
      empty: Boolean(bodyOmittedReason),
    });
    if (
      (bodyOmittedReason && body !== "") ||
      (!bodyOmittedReason && !isValidSmsInboxBody(body))
    ) {
      throw new SmsContractError(
        `${path}.body violates the private inbox body contract`,
      );
    }
    return {
      id,
      tenantId,
      phoneE164,
      direction: wireDirection(row.direction, `${path}.direction`),
      body,
      provider: wireString(row.provider, `${path}.provider`, {
        max: 128,
        token: true,
      }),
      status: wireString(row.status, `${path}.status`, {
        max: 128,
        token: true,
      }),
      createdAt,
      segments: wireInteger(row.segments, `${path}.segments`),
      ...(bodyOmittedReason ? { bodyOmittedReason } : {}),
      ...messageOptional(row, path),
    } satisfies SmsMessage;
  });
  const cursor = wireNextCursor(src, "messages response");
  return {
    tenantId: envelopeTenantId,
    messages,
    snapshotAt,
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}

function messageOptional(
  row: Record<string, unknown>,
  path: string,
): Partial<SmsMessage> {
  const senderProfileId =
    row.sender_profile_id === undefined
      ? undefined
      : wireUuid(row.sender_profile_id, `${path}.sender_profile_id`);
  const providerMessageId = wireOptionalString(
    row,
    "provider_message_id",
    path,
    256,
  );
  const errorMessage = wireOptionalString(row, "error_message", path, 2048);
  const mediaUrl = wireOptionalString(row, "media_url", path, 4096);
  if (row.campaign_id !== undefined)
    wireUuid(row.campaign_id, `${path}.campaign_id`);
  wireInteger(row.cost_micros, `${path}.cost_micros`);
  const errorCode = wireOptionalString(row, "error_code", path, 128);
  if (errorCode && !SMS_WIRE_TOKEN.test(errorCode)) {
    throw new SmsContractError(`${path}.error_code is not a valid token`);
  }
  wireOptionalTimestamp(row, "sent_at", path);
  wireOptionalTimestamp(row, "delivered_at", path);
  wireOptionalTimestamp(row, "received_at", path);
  const dispatchState = wireOptionalString(row, "dispatch_state", path, 128);
  if (dispatchState && !SMS_WIRE_TOKEN.test(dispatchState)) {
    throw new SmsContractError(`${path}.dispatch_state is not a valid token`);
  }
  return {
    ...(senderProfileId ? { senderProfileId } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
  };
}

function decodeBodyOmission(
  row: Record<string, unknown>,
  path: string,
): SmsInboxBodyOmittedReason | undefined {
  if (row.body_omitted_reason === undefined) return undefined;
  if (
    row.body_omitted_reason !== "body_exceeds_inbox_limit" &&
    row.body_omitted_reason !== "legacy_body_unavailable"
  ) {
    throw new SmsContractError(`${path}.body_omitted_reason is invalid`);
  }
  return row.body_omitted_reason;
}
