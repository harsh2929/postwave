// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/** One file on a transactional email. Provide exactly one of `content`
 *  (base64) or `path` (a remote https URL fetched at send time). */
export interface EmailAttachment {
  filename: string;
  content?: string;
  path?: string;
  content_type?: string;
  /** Set to render the part inline (cid: reference). */
  content_id?: string;
}

/** A per-message key/value tag (surfaced on delivery webhooks). */
export interface EmailTag {
  name: string;
  value: string;
}

/** Body of POST /api/v1/emails. `to`/`cc`/`bcc`/`reply_to` accept a string or
 *  an array. One of `html`/`text` is required; `from` defaults to the tenant's
 *  configured sender when omitted. */
export interface SendEmailInput {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: EmailTag[];
  attachments?: EmailAttachment[];
  /** RFC3339 timestamp; a future value schedules the send. */
  scheduled_at?: string;
}

export interface SendEmailResult {
  id: string;
  /** sent | scheduled | failed | skipped */
  status: string;
  error?: string;
  suppressed?: number;
}

export interface EmailRecord {
  id: string;
  from: string;
  to: string[];
  subject: string;
  status: string;
  scheduled_at?: string | null;
  provider_message_id?: string;
  last_error?: string;
  source: string;
  suppressed: number;
  created_at: string;
  sent_at?: string | null;
}

/** Transactional email — fire a single message (or a batch) from your app. */
export class EmailsResource extends Resource {
  /** Send one transactional email. */
  send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!input.html && !input.text) {
      throw new Error("emails.send: pass `html` or `text`");
    }
    return this.client.request("POST", "/api/v1/emails", { body: input });
  }

  /** Send up to 100 distinct emails in one call. */
  sendBatch(emails: SendEmailInput[]): Promise<{ data: SendEmailResult[] }> {
    return this.client.request("POST", "/api/v1/emails/batch", { body: { emails } });
  }

  /** Fetch a single email's status. */
  get(id: string): Promise<EmailRecord> {
    return this.client.request("GET", `/api/v1/emails/${encodeURIComponent(id)}`);
  }

  /** List recent transactional sends. */
  list(params?: { limit?: number }): Promise<{ data: EmailRecord[] }> {
    return this.client.request("GET", "/api/v1/emails", { query: params });
  }
}
