/**
 * api/smsQuickReplies.ts — transport for the canned-response library.
 *
 * Routes and contracts documented in `@/lib/smsQuickReply` (validators +
 * decoders, node-tested); this file is routes and envelopes only. All five
 * routes are behind `protectSMSInboxResponse` + `RequireExactTenantAdmin`
 * (inbox_extras.go:70-74); none is release-held. The reply SEND those bodies
 * feed is a different route with its own hold — the picker copy carries that
 * caveat, not this module.
 */
import {
  decodeSmsQuickRepliesPage,
  decodeSmsQuickReplyDelete,
  decodeSmsQuickReplyMutation,
  decodeSmsQuickReplyUse,
  smsQuickReplyBodyError,
  smsQuickReplyLabelError,
  type SmsQuickRepliesPage,
  type SmsQuickReply,
  type SmsQuickReplyDeleteReceipt,
  type SmsQuickReplyUseReceipt,
} from "@/lib/smsQuickReply";

import { rawRequest, type AIApiError } from "./request";
import { SmsInboxError } from "./smsInbox";
import { requireUuid } from "./smsInboxContracts";

const BASE = "/api/v1/sms/quick-replies";

async function call(
  method: string,
  path: string,
  label: string,
  body?: unknown,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<unknown> {
  const res = await rawRequest<unknown>(method, path, body, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.error) throw new SmsInboxError(res.error as AIApiError, label);
  if (res.data == null) throw new Error(`${label} returned no data.`);
  return res.data;
}

export async function listSmsQuickReplies(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<SmsQuickRepliesPage> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  // No query parameters — the route 400s any (inbox_extras.go:645-648).
  const raw = await call("GET", BASE, "Loading quick replies", undefined, {
    signal: input.signal,
  });
  return decodeSmsQuickRepliesPage(raw, { tenantId });
}

export async function createSmsQuickReply(input: {
  tenantId: string;
  label: string;
  body: string;
  signal?: AbortSignal;
}): Promise<SmsQuickReply> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const labelInvalid = smsQuickReplyLabelError(input.label);
  if (labelInvalid) throw new Error(labelInvalid);
  const bodyInvalid = smsQuickReplyBodyError(input.body);
  if (bodyInvalid) throw new Error(bodyInvalid);
  const raw = await call(
    "POST",
    BASE,
    "Saving the quick reply",
    { label: input.label, body: input.body },
    { signal: input.signal },
  );
  return decodeSmsQuickReplyMutation(raw, { tenantId });
}

export async function deleteSmsQuickReply(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<SmsQuickReplyDeleteReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const id = requireUuid(input.id, "Quick reply");
  const raw = await call(
    "DELETE",
    `${BASE}/${encodeURIComponent(id)}`,
    "Deleting the quick reply",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsQuickReplyDelete(raw, { tenantId, id });
}

/**
 * Bump the picker ranking after a PERSISTED send whose body came from this
 * quick reply. Fire only on a persisted receipt — an uncertain or failed
 * dispatch did not "use" anything.
 */
export async function recordSmsQuickReplyUse(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<SmsQuickReplyUseReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const id = requireUuid(input.id, "Quick reply");
  const raw = await call(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/use`,
    "Recording quick reply use",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsQuickReplyUse(raw, { tenantId, id });
}
