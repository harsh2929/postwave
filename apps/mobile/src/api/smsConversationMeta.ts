/**
 * api/smsConversationMeta.ts — transport for per-conversation tags, internal
 * notes, and the activity feed.
 *
 * Routes and their contracts are documented in `@/lib/smsConversationMeta`
 * (validators + decoders, node-tested); this file is routes and envelopes
 * only. All five routes sit behind `protectSMSInboxResponse` +
 * `RequireExactTenantAdmin` (inbox_extras.go:60-65) — the chain the inbox
 * already passes — and none is release-held.
 *
 * The retired shapes are deliberately NOT here: GET search-by-query-string and
 * DELETE .../tags/{tag} both answer 410 permanently (private text must not
 * enter URLs), so the tag for a removal travels in the DELETE body.
 */
import {
  decodeSmsActivityFeed,
  decodeSmsConversationTags,
  decodeSmsNotesReceipt,
  decodeSmsTagMutationReceipt,
  smsNotesError,
  smsTagError,
  type SmsActivityFeed,
  type SmsConversationTagsPage,
  type SmsNotesReceipt,
  type SmsTagMutationReceipt,
} from "@/lib/smsConversationMeta";

import { rawRequest, type AIApiError } from "./request";
import { SmsInboxError } from "./smsInbox";
import { requirePhone, requireUuid } from "./smsInboxContracts";
import { searchSmsConversations } from "./smsInboxOps";

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

function conversationPath(phoneE164: string, leaf: string): string {
  return `/api/v1/sms/conversations/${encodeURIComponent(phoneE164)}/${leaf}`;
}

export async function listSmsConversationTags(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<SmsConversationTagsPage> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const phoneE164 = requirePhone(input.phoneE164);
  const raw = await call(
    "GET",
    conversationPath(phoneE164, "tags"),
    "Loading conversation tags",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsConversationTags(raw, { tenantId, phoneE164 });
}

/**
 * `expectedAbsent: true` asserts the tag was absent from the inventory the
 * operator loaded — the server refuses the write without it, and answers 409
 * when the inventory moved (`tag_state_conflict`) or is full
 * (`tag_limit_reached`, 100 per conversation).
 */
export async function addSmsConversationTag(input: {
  tenantId: string;
  phoneE164: string;
  tag: string;
  signal?: AbortSignal;
}): Promise<SmsTagMutationReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const phoneE164 = requirePhone(input.phoneE164);
  const invalid = smsTagError(input.tag);
  if (invalid) throw new Error(invalid);
  const raw = await call(
    "POST",
    conversationPath(phoneE164, "tags"),
    "Adding the tag",
    { tag: input.tag, expectedAbsent: true },
    { signal: input.signal },
  );
  return decodeSmsTagMutationReceipt(raw, {
    tenantId,
    phoneE164,
    tag: input.tag,
    action: "add",
  });
}

/** CAS'd on the tag's exact `createdAt` from the loaded inventory. */
export async function removeSmsConversationTag(input: {
  tenantId: string;
  phoneE164: string;
  tag: string;
  expectedCreatedAt: string;
  signal?: AbortSignal;
}): Promise<SmsTagMutationReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const phoneE164 = requirePhone(input.phoneE164);
  const invalid = smsTagError(input.tag);
  if (invalid) throw new Error(invalid);
  const raw = await call(
    "DELETE",
    conversationPath(phoneE164, "tags"),
    "Removing the tag",
    { tag: input.tag, expectedCreatedAt: input.expectedCreatedAt },
    { signal: input.signal },
  );
  return decodeSmsTagMutationReceipt(raw, {
    tenantId,
    phoneE164,
    tag: input.tag,
    action: "remove",
  });
}

/**
 * OVERWRITES the conversation's internal notes. `expectedUpdatedAt` is the
 * conversation's lifecycle token (`stateUpdatedAt` from a list/search row), or
 * null for a conversation whose operator state was never touched; a stale
 * token is a 409 `conversation_state_conflict`, surfaced so a concurrent
 * operator's note is never silently clobbered.
 */
export async function setSmsConversationNotes(input: {
  tenantId: string;
  phoneE164: string;
  notes: string;
  expectedUpdatedAt: string | null;
  signal?: AbortSignal;
}): Promise<SmsNotesReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const phoneE164 = requirePhone(input.phoneE164);
  const invalid = smsNotesError(input.notes);
  if (invalid) throw new Error(invalid);
  const raw = await call(
    "POST",
    conversationPath(phoneE164, "notes"),
    "Saving the note",
    { notes: input.notes, expectedUpdatedAt: input.expectedUpdatedAt },
    { signal: input.signal },
  );
  return decodeSmsNotesReceipt(raw, { tenantId, phoneE164 });
}

export async function getSmsConversationActivity(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<SmsActivityFeed> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const phoneE164 = requirePhone(input.phoneE164);
  const raw = await call(
    "GET",
    conversationPath(phoneE164, "activity"),
    "Loading conversation activity",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsActivityFeed(raw, { tenantId, phoneE164 });
}

/**
 * The conversation's CURRENT lifecycle token, fetched via the exact-phone
 * server-side search (the only read that exposes `stateUpdatedAt` to a client
 * that has no list row — the thread screen after a deep link). Null is a real
 * answer: a conversation whose operator state was never touched carries no
 * token, and null is the valid CAS value for it.
 */
export async function fetchSmsLifecycleToken(input: {
  tenantId: string;
  phoneE164: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const phoneE164 = requirePhone(input.phoneE164);
  const page = await searchSmsConversations({
    tenantId: input.tenantId,
    query: phoneE164,
    limit: 50,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const row = page.conversations.find(
    (candidate) => candidate.phoneE164 === phoneE164,
  );
  return row?.stateUpdatedAt ?? null;
}
