/**
 * api/smsBroadcasts.ts — transport for SMS broadcast DRAFT management.
 *
 * Routes, auth chain, and the dispatch-hold boundary are documented in
 * `@/lib/smsBroadcastWire`. THIS MODULE HAS NO SEND AND NO CANCEL-DURING-SEND:
 * POST .../{id}/send is release-held (503 `sms_broadcast_dispatch_release_held`
 * until `smsDispatchSagaReleaseReady`), and a client function for it would be
 * a wired 503. The list's own `dispatchAvailable` bit is the screen's honest
 * signal for why no Send control exists.
 */
import {
  decodeSmsBroadcast,
  decodeSmsBroadcastProgress,
  decodeSmsBroadcastsPage,
  smsBroadcastUpsertBody,
  type SmsBroadcast,
  type SmsBroadcastDraftInput,
  type SmsBroadcastProgress,
  type SmsBroadcastsPage,
} from "@/lib/smsBroadcastWire";

import { rawRequest, type AIApiError } from "./request";
import { SmsInboxError } from "./smsInbox";
import { requireUuid } from "./smsInboxContracts";

const BASE = "/api/v1/sms/broadcasts";

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

export async function listSmsBroadcasts(input: {
  tenantId: string;
  cursor?: string | undefined;
  signal?: AbortSignal;
}): Promise<SmsBroadcastsPage> {
  const tenantId = requireUuid(input.tenantId, "Tenant identity");
  const search = input.cursor
    ? `?cursor=${encodeURIComponent(input.cursor)}`
    : "";
  const raw = await call(
    "GET",
    `${BASE}${search}`,
    "Loading broadcasts",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsBroadcastsPage(raw, { tenantId });
}

export async function createSmsBroadcast(input: {
  tenantId: string;
  draft: SmsBroadcastDraftInput;
  signal?: AbortSignal;
}): Promise<SmsBroadcast> {
  requireUuid(input.tenantId, "Tenant identity");
  if (input.draft.name === undefined) {
    throw new Error("The broadcast needs a name.");
  }
  const body = smsBroadcastUpsertBody(input.draft);
  const raw = await call("POST", BASE, "Creating the broadcast", body, {
    signal: input.signal,
  });
  return decodeSmsBroadcast(raw);
}

export async function updateSmsBroadcast(input: {
  tenantId: string;
  id: string;
  draft: SmsBroadcastDraftInput;
  existing: Pick<SmsBroadcast, "listIds" | "segmentId">;
  signal?: AbortSignal;
}): Promise<SmsBroadcast> {
  requireUuid(input.tenantId, "Tenant identity");
  const id = requireUuid(input.id, "Broadcast");
  const body = smsBroadcastUpsertBody(input.draft, input.existing);
  const raw = await call(
    "PATCH",
    `${BASE}/${encodeURIComponent(id)}`,
    "Saving the broadcast",
    body,
    { signal: input.signal },
  );
  return decodeSmsBroadcast(raw);
}

export async function deleteSmsBroadcast(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<void> {
  requireUuid(input.tenantId, "Tenant identity");
  const id = requireUuid(input.id, "Broadcast");
  const raw = await call(
    "DELETE",
    `${BASE}/${encodeURIComponent(id)}`,
    "Deleting the broadcast",
  );
  const receipt = raw as { ok?: unknown };
  if (receipt.ok !== true) {
    throw new Error("The delete receipt was not acknowledged.");
  }
}

export async function getSmsBroadcastProgress(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<SmsBroadcastProgress> {
  requireUuid(input.tenantId, "Tenant identity");
  const id = requireUuid(input.id, "Broadcast");
  const raw = await call(
    "GET",
    `${BASE}/${encodeURIComponent(id)}/progress`,
    "Loading broadcast progress",
    undefined,
    { signal: input.signal },
  );
  return decodeSmsBroadcastProgress(raw);
}
