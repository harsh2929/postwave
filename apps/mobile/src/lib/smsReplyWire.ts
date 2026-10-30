/**
 * smsReplyWire — the strict decoder for the reply dispatch receipt.
 *
 * Moved verbatim out of `smsConversationWire.ts` (via `smsContextWire.ts`) to
 * keep every wire module under the 450-line source budget; the checks are
 * unchanged. `smsConversation.ts` re-exports `decodeSmsReplyResponse`.
 */
import {
  SmsContractError,
  type SmsReplyMessageReceipt,
  type SmsReplyResponse,
} from "./smsConversation";
import {
  wireExactKeys,
  wireInteger,
  wireObject,
  wireOptionalString,
  wireOptionalTimestamp,
  wireString,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export function decodeSmsReplyResponse(
  raw: unknown,
  expected: { tenantId: string; senderProfileId: string },
): SmsReplyResponse {
  const src = wireObject(raw, "reply response");
  const receipt = wireObject(
    src.providerReceipt,
    "reply response.providerReceipt",
  );
  const provider = wireString(
    receipt.provider,
    "reply response.providerReceipt.provider",
    {
      max: 128,
      token: true,
    },
  );
  const status = wireString(
    receipt.status,
    "reply response.providerReceipt.status",
    {
      max: 128,
      token: true,
    },
  );
  if (src.disposition === "reconciliation_required") {
    wireExactKeys(
      src,
      ["disposition", "code", "intentMessageId", "providerReceipt"],
      "reply response",
    );
    wireExactKeys(
      receipt,
      ["provider", "providerMessageId", "status"],
      "reply response.providerReceipt",
    );
    if (src.code !== "reply_reconciliation_required") {
      throw new SmsContractError(
        "reply response has an unknown reconciliation code",
      );
    }
    const providerMessageId = wireOptionalString(
      receipt,
      "providerMessageId",
      "reply response.providerReceipt",
      256,
    );
    return {
      disposition: "reconciliation_required",
      code: "reply_reconciliation_required",
      intentMessageId: wireUuid(
        src.intentMessageId,
        "reply response.intentMessageId",
      ),
      providerReceipt: {
        provider,
        status,
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    };
  }
  if (src.disposition !== "persisted") {
    throw new SmsContractError("reply response has an unknown disposition");
  }
  wireExactKeys(
    src,
    ["disposition", "message", "providerReceipt"],
    "reply response",
  );
  wireExactKeys(
    receipt,
    ["provider", "providerMessageId", "status"],
    "reply response.providerReceipt",
  );
  const providerMessageId = wireString(
    receipt.providerMessageId,
    "reply response.providerReceipt.providerMessageId",
    { max: 256 },
  );
  const providerReceipt = { provider, providerMessageId, status };
  const message = decodeReplyMessage(src.message, expected);
  if (
    message.provider !== providerReceipt.provider ||
    message.providerMessageId !== providerReceipt.providerMessageId ||
    message.status !== providerReceipt.status
  ) {
    throw new SmsContractError("reply message and provider receipt disagree");
  }
  return { disposition: "persisted", message, providerReceipt };
}

function decodeReplyMessage(
  raw: unknown,
  expected: { tenantId: string; senderProfileId: string },
): SmsReplyMessageReceipt {
  const row = wireObject(raw, "reply response.message");
  wireExactKeys(
    row,
    [
      "id",
      "tenant_id",
      "sender_profile_id",
      "provider",
      "provider_message_id",
      "direction",
      "segments",
      "status",
      "cost_micros",
      "sent_at",
      "created_at",
    ],
    "reply response.message",
  );
  const tenantId = wireUuid(row.tenant_id, "reply response.message.tenant_id");
  const senderProfileId = wireUuid(
    row.sender_profile_id,
    "reply response.message.sender_profile_id",
  );
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError("reply message belongs to another tenant");
  }
  if (senderProfileId !== expected.senderProfileId) {
    throw new SmsContractError("reply message belongs to another sender");
  }
  if (row.direction !== "outbound") {
    throw new SmsContractError("reply message direction must be outbound");
  }
  const sentAt = wireOptionalTimestamp(row, "sent_at", "reply response.message");
  return {
    id: wireUuid(row.id, "reply response.message.id"),
    tenantId,
    senderProfileId,
    provider: wireString(row.provider, "reply response.message.provider", {
      max: 128,
      token: true,
    }),
    providerMessageId: wireString(
      row.provider_message_id,
      "reply response.message.provider_message_id",
      { max: 256 },
    ),
    direction: "outbound",
    segments: wireInteger(row.segments, "reply response.message.segments"),
    status: wireString(row.status, "reply response.message.status", {
      max: 128,
      token: true,
    }),
    costMicros: wireInteger(
      row.cost_micros,
      "reply response.message.cost_micros",
    ),
    createdAt: wireTimestamp(
      row.created_at,
      "reply response.message.created_at",
    ),
    ...(sentAt ? { sentAt } : {}),
  };
}
