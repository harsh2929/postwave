/**
 * smsContextWire — strict decoders for the SMS thread's context, sender and
 * reply-receipt responses.
 *
 * Moved verbatim out of `smsConversationWire.ts` to bring that file back under
 * the 450-line source budget; the checks are unchanged. `smsConversation.ts`
 * re-exports all three decoders, so no caller changed.
 */
import {
  SmsContractError,
  type SmsConsentStatus,
  type SmsConversationContext,
  type SmsSenderProfile,
} from "./smsConversation";
import {
  wireBoolean,
  wireExactKeys,
  wireInteger,
  wireObject,
  wireOptionalString,
  wireOptionalTimestamp,
  wirePhone,
  wireString,
  wireTenantEnvelope,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export function decodeSmsConversationContext(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsConversationContext {
  const src = wireObject(raw, "conversation context");
  wireExactKeys(
    src,
    [
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
    ],
    "conversation context",
  );
  wireTenantEnvelope(src, expected.tenantId, "conversation context");
  const phoneE164 = wirePhone(src.phoneE164, "conversation context.phoneE164");
  if (phoneE164 !== expected.phoneE164) {
    throw new SmsContractError("context belongs to another phone");
  }
  const consentStatus = String(src.consentStatus);
  if (!["opted_in", "opted_out", "pending", "none"].includes(consentStatus)) {
    throw new SmsContractError(
      "conversation context has an unknown consentStatus",
    );
  }
  if (!Array.isArray(src.eligibleLists) || src.eligibleLists.length > 100) {
    throw new SmsContractError(
      "conversation context.eligibleLists must be an array",
    );
  }
  const seen = new Set<string>();
  const eligibleLists = src.eligibleLists.map((entry, index) => {
    const path = `conversation context.eligibleLists[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(
      row,
      ["id", "name", "description", "consentSource", "consentAt"],
      path,
    );
    const id = wireUuid(row.id, `${path}.id`);
    if (seen.has(id))
      throw new SmsContractError(`${path} duplicates list ${id}`);
    seen.add(id);
    const consentSource = wireOptionalString(row, "consentSource", path, 128);
    const consentAt = wireOptionalTimestamp(row, "consentAt", path);
    return {
      id,
      name: wireString(row.name, `${path}.name`, { max: 256 }),
      description: wireString(row.description, `${path}.description`, {
        max: 2048,
        empty: true,
      }),
      ...(consentSource ? { consentSource } : {}),
      ...(consentAt ? { consentAt } : {}),
    };
  });
  const suppressionReason = wireOptionalString(
    src,
    "suppressionReason",
    "conversation context",
    128,
  );
  const replyDispatchUnavailableReason = wireOptionalString(
    src,
    "replyDispatchUnavailableReason",
    "conversation context",
    128,
  );
  const identityAmbiguous = wireBoolean(
    src.identityAmbiguous,
    "conversation context.identityAmbiguous",
  );
  const consentEvidenceSufficient = wireBoolean(
    src.consentEvidenceSufficient,
    "conversation context.consentEvidenceSufficient",
  );
  const optional = contextOptional(src);
  const subscribedLists = wireInteger(
    src.subscribedLists,
    "conversation context.subscribedLists",
  );
  const suppressed = wireBoolean(
    src.suppressed,
    "conversation context.suppressed",
  );
  const suppressionReversible = wireBoolean(
    src.suppressionReversible,
    "conversation context.suppressionReversible",
  );
  const replyDispatchAvailable = wireBoolean(
    src.replyDispatchAvailable,
    "conversation context.replyDispatchAvailable",
  );
  if (identityAmbiguous && optional.subscriberEmail) {
    throw new SmsContractError(
      "conversation context.subscriberEmail must be omitted for ambiguous identity",
    );
  }
  if (!consentEvidenceSufficient && eligibleLists.length > 0) {
    throw new SmsContractError(
      "conversation context.eligibleLists require sufficient consent evidence",
    );
  }
  if (
    eligibleLists.length > subscribedLists ||
    (consentStatus !== "opted_in" && eligibleLists.length > 0)
  ) {
    throw new SmsContractError(
      "conversation context.eligibleLists disagree with current consent",
    );
  }
  if (
    suppressed !== Boolean(suppressionReason) ||
    (suppressionReversible && (!suppressed || suppressionReason !== "manual"))
  ) {
    throw new SmsContractError(
      "conversation context suppression authority is inconsistent",
    );
  }
  if (replyDispatchAvailable && replyDispatchUnavailableReason) {
    throw new SmsContractError(
      "conversation context dispatch availability is inconsistent",
    );
  }
  return {
    phoneE164,
    consentStatus: consentStatus as SmsConsentStatus,
    subscribedLists,
    totalMessages: wireInteger(
      src.totalMessages,
      "conversation context.totalMessages",
    ),
    suppressed,
    suppressionReversible,
    hasInboundThread: wireBoolean(
      src.hasInboundThread,
      "conversation context.hasInboundThread",
    ),
    eligibleLists,
    consentMixed: wireBoolean(
      src.consentMixed,
      "conversation context.consentMixed",
    ),
    identityAmbiguous,
    consentEvidenceSufficient,
    replyDispatchAvailable,
    ...optional,
    ...(suppressionReason ? { suppressionReason } : {}),
    ...(replyDispatchUnavailableReason
      ? { replyDispatchUnavailableReason }
      : {}),
  };
}

function contextOptional(
  src: Record<string, unknown>,
): Partial<SmsConversationContext> {
  const path = "conversation context";
  const subscriberEmail = wireOptionalString(src, "subscriberEmail", path, 320);
  const consentSource = wireOptionalString(src, "consentSource", path, 128);
  const consentAt = wireOptionalTimestamp(src, "consentAt", path);
  const optOutAt = wireOptionalTimestamp(src, "optOutAt", path);
  const firstSeenAt = wireOptionalTimestamp(src, "firstSeenAt", path);
  const lastReadAt = wireOptionalTimestamp(src, "lastReadAt", path);
  return {
    ...(subscriberEmail ? { subscriberEmail } : {}),
    ...(consentSource ? { consentSource } : {}),
    ...(consentAt ? { consentAt } : {}),
    ...(optOutAt ? { optOutAt } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastReadAt ? { lastReadAt } : {}),
  };
}

export function decodeSmsSenders(
  raw: unknown,
  expectedTenant: string,
): SmsSenderProfile[] {
  const src = wireObject(raw, "senders response");
  wireExactKeys(src, ["tenantId", "items"], "senders response");
  wireTenantEnvelope(src, expectedTenant, "senders response");
  if (!Array.isArray(src.items) || src.items.length > 100) {
    throw new SmsContractError(
      "senders response.items must be an array of at most 100 rows",
    );
  }
  const seen = new Set<string>();
  return src.items.map((entry, index) => {
    const path = `senders[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(
      row,
      [
        "id",
        "tenant_id",
        "provider",
        "country",
        "sender_type",
        "phone_number",
        "messaging_service_sid",
        "brand_registration_sid",
        "campaign_registration_sid",
        "registration_status",
        "capabilities",
        "metadata",
        "created_at",
        "updated_at",
      ],
      path,
    );
    const id = wireUuid(row.id, `${path}.id`);
    if (seen.has(id))
      throw new SmsContractError(`${path} duplicates sender ${id}`);
    seen.add(id);
    const tenantId = wireUuid(row.tenant_id, `${path}.tenant_id`);
    if (tenantId !== expectedTenant)
      throw new SmsContractError(`${path} belongs to another tenant`);
    const metadata =
      row.metadata === undefined
        ? {}
        : wireObject(row.metadata, `${path}.metadata`);
    const sending =
      metadata.sending === undefined
        ? {}
        : wireObject(metadata.sending, `${path}.metadata.sending`);
    const phoneNumber = wireOptionalString(row, "phone_number", path, 32);
    wireOptionalString(row, "messaging_service_sid", path, 256);
    wireOptionalString(row, "brand_registration_sid", path, 256);
    wireOptionalString(row, "campaign_registration_sid", path, 256);
    if (row.capabilities !== undefined) {
      wireObject(row.capabilities, `${path}.capabilities`);
    }
    wireTimestamp(row.created_at, `${path}.created_at`);
    wireTimestamp(row.updated_at, `${path}.updated_at`);
    return {
      id,
      tenantId,
      provider: wireString(row.provider, `${path}.provider`, {
        max: 128,
        token: true,
      }),
      country: wireString(row.country, `${path}.country`, {
        max: 8,
        token: true,
      }),
      senderType: wireString(row.sender_type, `${path}.sender_type`, {
        max: 128,
        token: true,
      }),
      registrationStatus: wireString(
        row.registration_status,
        `${path}.registration_status`,
        {
          max: 128,
          token: true,
        },
      ),
      paused: metadata.paused === true || sending.paused === true,
      ...(phoneNumber ? { phoneNumber } : {}),
    };
  });
}
