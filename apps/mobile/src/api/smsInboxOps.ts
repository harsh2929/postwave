/**
 * api/smsInboxOps.ts — transport for inbox-level SMS operations: server-side
 * conversation search and bulk lifecycle actions.
 *
 * ROUTES, READ FROM THE MOUNT BLOCK (apps/api/internal/sms/inbox_extras.go):
 *   POST /api/v1/sms/conversations/search  :68  `SearchConversations`
 *   GET  /api/v1/sms/conversations/search  :67  PERMANENTLY 410 — the query-
 *        string shape was retired because search terms carry phones/emails/
 *        message text and URLs reach edge access logs. Never call it.
 *   POST /api/v1/sms/conversations/bulk    :66  `BulkConversationAction`
 *
 * Both are behind `protectSMSInboxResponse` + `RequireExactTenantAdmin` — the
 * exact chain `GET /api/v1/sms/conversations` already passes — and NEITHER is
 * release-held: the SMS holds cover dispatch, A2P registration, and provider
 * callbacks, and neither handler consults a readiness flag.
 *
 * Argument validation and receipt decoding live in the pure siblings
 * `@/lib/smsInboxSearch` and `@/lib/smsBulkAction`, unit-tested in the node
 * vitest environment; this file is routes and envelopes only.
 */
import {
  decodeSmsBulkActionReceipt,
  smsBulkRequestBody,
  type SmsBulkActionInput,
  type SmsBulkActionReceipt,
} from "@/lib/smsBulkAction";
import {
  decodeSmsSearchPage,
  smsSearchQueryError,
  type SmsSearchPage,
} from "@/lib/smsInboxSearch";

import { rawRequest, type AIApiError } from "./request";
import { SmsInboxError } from "./smsInbox";
import { requireUuid } from "./smsInboxContracts";

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

/**
 * Server-side search across message bodies, phone numbers, and subscriber
 * emails. POST-only — see the module header. The server binds the encrypted
 * keyset cursor to the tenant and the normalized query, so a cursor from one
 * query cannot continue another.
 */
export async function searchSmsConversations(input: {
  tenantId: string;
  query: string;
  cursor?: string | undefined;
  limit?: number | undefined;
  signal?: AbortSignal;
}): Promise<SmsSearchPage> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const query = input.query.trim();
  const invalid = smsSearchQueryError(query);
  if (invalid) throw new Error(invalid);
  const raw = await call(
    "POST",
    "/api/v1/sms/conversations/search",
    "Searching conversations",
    {
      query,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    },
    { signal: input.signal },
  );
  return decodeSmsSearchPage(raw, { tenantId });
}

/**
 * One lifecycle change across up to 200 conversations. Every target carries
 * its own `expectedUpdatedAt` (the row's `stateUpdatedAt`, or null for a row
 * that has never had lifecycle state); the server applies all-or-nothing and
 * answers 409 `bulk_action_conflict` when any row moved since it was loaded.
 */
export async function bulkSmsConversationAction(
  input: SmsBulkActionInput & { tenantId: string; signal?: AbortSignal },
): Promise<SmsBulkActionReceipt> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const body = smsBulkRequestBody(input);
  const raw = await call(
    "POST",
    "/api/v1/sms/conversations/bulk",
    "Applying the bulk action",
    body,
    { ...(input.signal ? { signal: input.signal } : {}) },
  );
  return decodeSmsBulkActionReceipt(raw, {
    tenantId,
    action: input.action,
    phones: body.conversations.map((row) => row.phoneE164),
  });
}
