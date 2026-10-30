/**
 * Mailpit REST API client.
 *
 * Mailpit (https://mailpit.axllent.org) ships an HTTP API at /api/v1 that
 * lets us list, fetch, and delete captured messages. The docker-compose
 * test stack exposes it on http://localhost:8025 by default.
 *
 * The shape we care about:
 *
 *   GET /api/v1/messages?query=to:...&limit=50
 *     → { messages: [{ ID, To: [{Address}], Subject, ... }], ... }
 *
 *   GET /api/v1/message/{ID}
 *     → { ID, Subject, Text, HTML, To: [...], ... }
 *
 *   DELETE /api/v1/messages
 *     → wipes the inbox
 */

const DEFAULT_MAILPIT_BASE = process.env.POSTWAVE_E2E_MAILPIT_BASE ?? 'http://localhost:8025';

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string; Name: string }>;
  From: { Address: string; Name: string };
  Created: string;
}

export interface MailpitMessage extends MailpitMessageSummary {
  Text: string;
  HTML: string;
}

export interface MailpitListResponse {
  messages: MailpitMessageSummary[];
  messages_count: number;
  total: number;
}

/**
 * Wipe the mailpit inbox. Call from beforeEach so tests don't leak mail
 * between journeys.
 */
export async function clearMailpit(base = DEFAULT_MAILPIT_BASE): Promise<void> {
  const res = await fetch(`${base}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`mailpit: clear failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Poll mailpit for a message addressed to `recipient` whose subject matches
 * the optional regex. Returns the full message body on success.
 *
 * Times out after `timeoutMs` (default 30s) with an error that includes the
 * last seen inbox summary so failures are debuggable from CI logs.
 */
export async function waitForMessage(opts: {
  recipient: string;
  subjectMatch?: RegExp;
  timeoutMs?: number;
  base?: string;
}): Promise<MailpitMessage> {
  const base = opts.base ?? DEFAULT_MAILPIT_BASE;
  const timeout = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;

  let lastSeen: MailpitMessageSummary[] = [];
  while (Date.now() < deadline) {
    const list = await listMessages(opts.recipient, base);
    lastSeen = list.messages;
    const hit = list.messages.find((m) => {
      const matchesTo = m.To.some(
        (to) => to.Address.toLowerCase() === opts.recipient.toLowerCase(),
      );
      if (!matchesTo) return false;
      if (opts.subjectMatch && !opts.subjectMatch.test(m.Subject)) return false;
      return true;
    });
    if (hit) {
      return await fetchMessage(hit.ID, base);
    }
    await sleep(500);
  }

  throw new Error(
    `mailpit: no message to ${opts.recipient} matching ${opts.subjectMatch ?? '*'} ` +
      `within ${timeout}ms. Last inbox snapshot: ` +
      JSON.stringify(
        lastSeen.map((m) => ({ to: m.To.map((t) => t.Address), subject: m.Subject })),
      ),
  );
}

export async function listMessages(
  recipient?: string,
  base = DEFAULT_MAILPIT_BASE,
): Promise<MailpitListResponse> {
  const url = new URL(`${base}/api/v1/messages`);
  url.searchParams.set('limit', '50');
  if (recipient) {
    url.searchParams.set('query', `to:${recipient}`);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`mailpit: list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as MailpitListResponse;
}

export async function fetchMessage(id: string, base = DEFAULT_MAILPIT_BASE): Promise<MailpitMessage> {
  const res = await fetch(`${base}/api/v1/message/${id}`);
  if (!res.ok) {
    throw new Error(`mailpit: fetch ${id} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as MailpitMessage;
}

/**
 * Extract the first URL from a message body that matches `urlPattern`.
 *
 * Email clients HTML-encode links, so we strip common entities before the
 * match. Returns null when nothing matches.
 */
export function extractLink(msg: MailpitMessage, urlPattern: RegExp): string | null {
  const haystack = `${msg.Text}\n${msg.HTML.replace(/&amp;/g, '&')}`;
  const m = haystack.match(urlPattern);
  return m ? m[0] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
