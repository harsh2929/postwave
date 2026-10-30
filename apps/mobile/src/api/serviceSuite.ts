/** Tenant-bound transport for the exact-admin service-suite Helpdesk. */
import { getClient } from "@/api/client";
import {
  helpdeskStrongEntityTag,
  helpdeskUtf8Bytes,
  isHelpdeskConversationStatus,
  normalizeServiceCatalog,
  normalizeServiceConversation,
  normalizeServiceConversationPage,
  normalizeServiceInternalNote,
  normalizeServiceMessagePage,
  normalizeHelpdeskId,
  normalizeHelpdeskIdempotencyKey,
  normalizeHelpdeskInternalNoteBody,
  normalizeHelpdeskOpaqueCursor,
  type HelpdeskCatalog,
  type HelpdeskConversation,
  type HelpdeskConversationPage,
  type HelpdeskMessage,
  type HelpdeskMessagePage,
} from "@/lib/helpdesk";

const BASE = "/api/v1/service-suite";
const PAGE_LIMIT = 50;
const INTERNAL_NOTE_DEFINITIVE_NO_EFFECT_STATUSES = new Set([
  400, 401, 403, 404, 412, 428, 429,
]);
const INTERNAL_NOTE_DEFINITIVE_NO_EFFECT_CONFLICT_CODES = new Set([
  "customer_agent_draft_write_held",
  "helpdesk_channel_create_held",
  "helpdesk_conversation_create_held",
  "helpdesk_create_replay_unavailable",
  "helpdesk_delivery_unavailable",
  "helpdesk_macro_create_held",
  "helpdesk_ticket_create_held",
  "helpdesk_view_create_held",
  "macro_usage_evidence_unavailable",
  "spam_assessment_write_held",
]);
const VERSIONED_MUTATION_DEFINITIVE_NO_EFFECT_STATUSES = new Set([
  400, 401, 403, 404, 409, 412, 428, 429,
]);

export const HELPDESK_PATHS = {
  catalog: BASE + "/catalog",
  conversations: BASE + "/conversations",
} as const;

export interface HelpdeskRequestOptions {
  signal?: AbortSignal;
}

export interface HelpdeskPageRequestOptions extends HelpdeskRequestOptions {
  cursor?: string;
  limit?: number;
}

export interface HelpdeskInternalNoteReceipt {
  note: HelpdeskMessage;
  replayed: boolean;
}

export interface HelpdeskConversationResource {
  conversation: HelpdeskConversation;
  etag: string;
}

export interface HelpdeskMutationOptions extends HelpdeskRequestOptions {
  ifMatch: string;
  expectedVersion: string;
}

/**
 * Whether an internal-note failure could have happened after the server
 * committed the note. Ambiguous outcomes retain their original durable key;
 * only an authoritative pre-effect rejection may retire it.
 */
export function helpdeskInternalNoteOutcomeIsAmbiguous(
  error: unknown,
): boolean {
  if (!error || typeof error !== "object") return true;
  const tagged = error as { status?: unknown; code?: unknown };
  const status =
    typeof tagged.status === "number" && Number.isSafeInteger(tagged.status)
      ? tagged.status
      : 0;
  const code = typeof tagged.code === "string" ? tagged.code : "";
  if (
    code === "idempotency_key_conflict" ||
    code === "internal_note_result_unavailable" ||
    code === "helpdesk_identity_retired"
  ) {
    return true;
  }
  if (INTERNAL_NOTE_DEFINITIVE_NO_EFFECT_STATUSES.has(status)) return false;
  return !(
    status === 409 &&
    INTERNAL_NOTE_DEFINITIVE_NO_EFFECT_CONFLICT_CODES.has(code)
  );
}

/**
 * Whether a versioned status/assignment failure could have arrived after the
 * server committed a replacement resource. A timeout, 5xx, or strict success
 * decoder failure is ambiguous and the cached revision must be discarded.
 * These routes' frozen 4xx verdicts are authoritative pre-effect refusals.
 */
export function helpdeskVersionedMutationOutcomeIsAmbiguous(
  error: unknown,
): boolean {
  if (!error || typeof error !== "object") return true;
  const tagged = error as { status?: unknown };
  const status =
    typeof tagged.status === "number" && Number.isSafeInteger(tagged.status)
      ? tagged.status
      : 0;
  return !VERSIONED_MUTATION_DEFINITIVE_NO_EFFECT_STATUSES.has(status);
}

function conversationPath(id: string): string {
  const canonical = normalizeHelpdeskId(id);
  if (!canonical)
    throw new Error("Helpdesk conversation id must be a canonical UUID");
  return BASE + "/conversations/" + encodeURIComponent(canonical);
}

function pageQuery(
  options: HelpdeskPageRequestOptions,
): Record<string, string | number> {
  const limit = options.limit ?? PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      "Helpdesk page limit must be an integer from 1 through 100",
    );
  }
  const cursor =
    options.cursor === undefined
      ? undefined
      : normalizeHelpdeskOpaqueCursor(options.cursor);
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export async function fetchHelpdeskCatalog(
  options: HelpdeskRequestOptions = {},
): Promise<HelpdeskCatalog> {
  const { client } = getClient();
  return normalizeServiceCatalog(
    await client.request<unknown>("GET", HELPDESK_PATHS.catalog, {
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
}

export async function listHelpdeskConversations(
  options: HelpdeskPageRequestOptions & { status?: string } = {},
): Promise<HelpdeskConversationPage> {
  const { client, tenantId } = getClient();
  if (
    options.status !== undefined &&
    !isHelpdeskConversationStatus(options.status)
  ) {
    throw new Error("Helpdesk status is invalid");
  }
  return normalizeServiceConversationPage(
    await client.request<unknown>("GET", HELPDESK_PATHS.conversations, {
      query: {
        ...pageQuery(options),
        ...(options.status ? { status: options.status } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    tenantId,
  );
}

export async function fetchHelpdeskConversation(
  id: string,
  options: HelpdeskRequestOptions = {},
): Promise<HelpdeskConversationResource> {
  const { client, tenantId } = getClient();
  let responseTag: string | null = null;
  const conversation = normalizeServiceConversation(
    await client.request<unknown>("GET", conversationPath(id), {
      onResponseHeaders: (headers) => {
        responseTag = headers.get("ETag");
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    tenantId,
  );
  return {
    conversation,
    etag: helpdeskStrongEntityTag(responseTag, conversation.version),
  };
}

export async function listHelpdeskMessages(
  id: string,
  options: HelpdeskPageRequestOptions & { order?: "desc" | "asc" } = {},
): Promise<HelpdeskMessagePage> {
  const { client, tenantId } = getClient();
  const order = options.order ?? "desc";
  return normalizeServiceMessagePage(
    await client.request<unknown>("GET", conversationPath(id) + "/messages", {
      query: { ...pageQuery(options), order },
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    tenantId,
    id,
    order,
  );
}

/**
 * Records an internal workspace note. This function cannot express delivery:
 * the exact request body has no direction, sender, provider, or recipient.
 */
export async function recordHelpdeskInternalNote(
  id: string,
  bodyText: string,
  idempotencyKey: string,
  options: HelpdeskRequestOptions = {},
): Promise<HelpdeskInternalNoteReceipt> {
  const { client, tenantId } = getClient();
  const body = normalizeHelpdeskInternalNoteBody(bodyText);
  const retainedKey = normalizeHelpdeskIdempotencyKey(idempotencyKey);
  let replayed = false;
  const raw = await client.request<unknown>(
    "POST",
    conversationPath(id) + "/internal-notes",
    {
      body: { body_text: body },
      idempotencyKey: retainedKey,
      onResponseHeaders: (headers) => {
        replayed =
          headers.get("Idempotency-Replayed")?.toLowerCase() === "true";
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const note = normalizeServiceInternalNote(raw, tenantId, id);
  return { note, replayed };
}

export async function setHelpdeskConversationStatus(
  id: string,
  status: string,
  options: HelpdeskMutationOptions,
): Promise<HelpdeskConversationResource> {
  const { client, tenantId } = getClient();
  if (!isHelpdeskConversationStatus(status)) {
    throw new Error("Helpdesk status is invalid");
  }
  const ifMatch = helpdeskStrongEntityTag(
    options.ifMatch,
    options.expectedVersion,
  );
  let responseTag: string | null = null;
  const conversation = normalizeServiceConversation(
    await client.request<unknown>("POST", conversationPath(id) + "/status", {
      body: { status },
      headers: { "If-Match": ifMatch },
      onResponseHeaders: (headers) => {
        responseTag = headers.get("ETag");
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    tenantId,
  );
  return {
    conversation,
    etag: helpdeskStrongEntityTag(responseTag, conversation.version),
  };
}

export async function claimHelpdeskConversation(
  id: string,
  action: "assign_self" | "unassign",
  options: HelpdeskMutationOptions & { reason?: string },
): Promise<HelpdeskConversationResource> {
  const { client, tenantId } = getClient();
  const reason = options.reason?.trim() ?? "";
  if (helpdeskUtf8Bytes(reason) > 1024) {
    throw new Error("Helpdesk assignment reason is too long");
  }
  const ifMatch = helpdeskStrongEntityTag(
    options.ifMatch,
    options.expectedVersion,
  );
  let responseTag: string | null = null;
  const conversation = normalizeServiceConversation(
    await client.request<unknown>("POST", conversationPath(id) + "/assign", {
      body: {
        action,
        ...(reason ? { reason } : {}),
      },
      headers: { "If-Match": ifMatch },
      onResponseHeaders: (headers) => {
        responseTag = headers.get("ETag");
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    tenantId,
  );
  return {
    conversation,
    etag: helpdeskStrongEntityTag(responseTag, conversation.version),
  };
}
