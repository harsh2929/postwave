/**
 * api/replyMailboxes.ts — the reply-capture registry.
 *
 *   GET    /api/v1/replies/mailboxes             (read:reports)
 *   POST   /api/v1/replies/mailboxes/{id}/enable (admin)
 *   POST   /api/v1/replies/mailboxes/{id}/disable(admin)
 *   DELETE /api/v1/replies/mailboxes/{id}        (admin)
 *
 * `POST /api/v1/replies/mailboxes` (create) is deliberately absent — its
 * disabled-first form is available on the web and desktop administrator
 * surfaces.
 *
 * NO CREDENTIAL EVER TRANSITS THIS SURFACE. The two secret fields are
 * REFERENCES validated server-side and resolved only at poll time. New tenant
 * registrations are confined to their own `env:POSTWAVE_REPLY_IMAP_TENANT_*`
 * namespace; legacy references can only remain in disabled quarantine.
 */
import { rawRequest, type AIApiError } from "./request";

import {
  decodeReplyMailboxList,
  toReplyMailbox,
  type ReplyMailbox,
} from "@/lib/replyMailboxes";

class ReplyMailboxError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ReplyMailboxError";
    this.status = error.status;
  }
}

const BASE = "/api/v1/replies/mailboxes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

function validID(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error("Invalid reply mailbox id.");
  return normalized;
}

export async function listReplyMailboxes(): Promise<ReplyMailbox[]> {
  const res = await rawRequest<unknown>("GET", BASE, undefined, NO_STORE);
  if (res.error) {
    throw new ReplyMailboxError(res.error, "Couldn't load reply mailboxes.");
  }
  return decodeReplyMailboxList(res.data);
}

/** Start or stop polling one mailbox. The cursor is preserved either way. */
export async function setReplyMailboxEnabled(
  id: string,
  enabled: boolean,
): Promise<ReplyMailbox> {
  const mailboxID = validID(id);
  const res = await rawRequest<unknown>(
    "POST",
    `${BASE}/${encodeURIComponent(mailboxID)}/${enabled ? "enable" : "disable"}`,
    {},
    NO_STORE,
  );
  if (res.error) {
    throw new ReplyMailboxError(
      res.error,
      `Couldn't ${enabled ? "enable" : "disable"} that mailbox.`,
    );
  }
  const mailbox = toReplyMailbox(res.data);
  if (mailbox.id !== mailboxID || mailbox.enabled !== enabled) {
    throw new Error("Mailbox action receipt did not match the reviewed action.");
  }
  return mailbox;
}

/** Remove a registration AND its poll cursor. See mailboxDeleteConsequence. */
export async function deleteReplyMailbox(id: string): Promise<void> {
  const mailboxID = validID(id);
  const res = await rawRequest<unknown>(
    "DELETE",
    `${BASE}/${encodeURIComponent(mailboxID)}`,
    undefined,
    NO_STORE,
  );
  if (res.error) {
    throw new ReplyMailboxError(res.error, "Couldn't remove that mailbox.");
  }
  if (res.data !== undefined && res.data !== null) {
    throw new Error("Unexpected reply mailbox deletion receipt.");
  }
}
