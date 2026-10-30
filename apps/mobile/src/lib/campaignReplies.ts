/**
 * lib/campaignReplies.ts — reading the inbound-reply feed for one campaign.
 *
 * WHAT THE ENDPOINT ANSWERS. `GET /api/v1/replies/by-campaign/{id}`
 * (apps/api/internal/reply_analytics/reply_analytics.go:54,119) returns:
 *
 *   {campaign_id, replies, distinct_replyers, unique_recipients,
 *    reply_rate, recent: [{recipient_email, subject, body_snippet,
 *                          source, received_at}]}   // most recent 50
 *
 * `reply_rate` is already a FRACTION on the wire — the handler computes
 * `distinct_replyers / unique_recipients` and does not multiply by 100
 * (reply_analytics.go:158-161). Every other rate this app renders arrives the
 * same way, and getting it wrong here would report a 4% reply rate as 4 basis
 * points or as 400%. It is converted exactly once, here.
 *
 * A REPLY IS UNADDRESSABLE FROM THIS PAYLOAD. The `recent` rows carry no `id`
 * (see the anonymous `reply` struct at reply_analytics.go:174-180), so no client
 * can name a row to the classify endpoint from THIS response.
 *
 * That was previously recorded here as "a server-side gap, not a mobile one",
 * which was the wrong conclusion (ASSURE#11). A different route —
 * GET /api/v1/campaigns/{id}/replies, campaign_replies.go:128 — returns rows
 * carrying `id`, `body_redacted` and `intent_label`. The addressable surface
 * existed; mobile was reading the analytics rollup for a job the rollup cannot do.
 * See lib/replyClassification, which reads the right one.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 */

/** Cap on rendered rows. The server sends at most 50; this is belt-and-braces. */
export const MAX_RENDERED_REPLIES = 50;
/** A snippet is a preview, not a message body. */
export const MAX_SNIPPET_CHARS = 280;

export interface CampaignRepliesWire {
  replies?: unknown;
  distinct_replyers?: unknown;
  unique_recipients?: unknown;
  reply_rate?: unknown;
  recent?: unknown;
}

export interface CampaignReplyRow {
  /** Stable within one render — the wire carries no id. */
  key: string;
  email: string;
  subject: string;
  snippet: string;
  source: string;
  /** Epoch ms, or null when unparseable. */
  receivedAt: number | null;
}

export interface CampaignRepliesReading {
  replies: number;
  distinctReplyers: number;
  uniqueRecipients: number;
  /** PERCENT (0-100), converted once from the wire's fraction. */
  replyRatePercent: number;
  rows: CampaignReplyRow[];
  /** True when the campaign has no replies at all. */
  empty: boolean;
  /** True when the server capped at 50 and there are more behind it. */
  truncated: boolean;
}

export const EMPTY_REPLIES: CampaignRepliesReading = {
  replies: 0,
  distinctReplyers: 0,
  uniqueRecipients: 0,
  replyRatePercent: 0,
  rows: [],
  empty: true,
  truncated: false,
};

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function readCampaignReplies(
  body: CampaignRepliesWire | null | undefined,
): CampaignRepliesReading {
  if (body == null || typeof body !== "object") return EMPTY_REPLIES;

  const replies = asCount(body.replies);
  const distinctReplyers = asCount(body.distinct_replyers);
  const uniqueRecipients = asCount(body.unique_recipients);

  // Clamped, not merely converted: a rate above 1 would mean more distinct
  // repliers than recipients, which is a server-side counting disagreement
  // between two different tables — not something to render as "137%".
  const rawRate =
    typeof body.reply_rate === "number" && Number.isFinite(body.reply_rate)
      ? body.reply_rate
      : 0;
  const replyRatePercent = Math.max(0, Math.min(1, rawRate)) * 100;

  const recent = Array.isArray(body.recent) ? body.recent : [];
  const rows: CampaignReplyRow[] = [];
  for (let i = 0; i < recent.length && rows.length < MAX_RENDERED_REPLIES; i++) {
    const raw = recent[i];
    if (raw == null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const email = asText(r.recipient_email);
    const snippetRaw = asText(r.body_snippet);
    const snippet =
      snippetRaw.length > MAX_SNIPPET_CHARS
        ? `${snippetRaw.slice(0, MAX_SNIPPET_CHARS)}…`
        : snippetRaw;
    const receivedAt = asTimestamp(r.received_at);
    // A row with neither an address nor any text is not a reply anyone can
    // read; rendering it would be an empty card with a timestamp.
    if (!email && !snippet && !asText(r.subject)) continue;
    rows.push({
      // The wire has no id, so the key is composed. Index is included because
      // two replies from one address in the same second are possible.
      key: `${email}-${receivedAt ?? "na"}-${i}`,
      email,
      subject: asText(r.subject),
      snippet,
      source: asText(r.source),
      receivedAt,
    });
  }

  return {
    replies,
    distinctReplyers,
    uniqueRecipients,
    replyRatePercent,
    rows,
    empty: replies === 0 && rows.length === 0,
    truncated: replies > rows.length && rows.length >= MAX_RENDERED_REPLIES,
  };
}

/**
 * The exact spoken form for the reply-rate stat.
 *
 * "4.1%" alone is not a fact a person can act on; the denominator is what makes
 * it one, and a screen reader has no visual column of counts to fall back on.
 */
export function replyRateSpoken(reading: CampaignRepliesReading): string {
  if (reading.uniqueRecipients === 0) {
    return "Reply rate unavailable — no recipients recorded for this campaign.";
  }
  return `${reading.replyRatePercent.toFixed(1)} percent reply rate: ${reading.distinctReplyers} of ${reading.uniqueRecipients} recipients replied.`;
}
