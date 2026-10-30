// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-detail-panels-api.ts — the per-campaign side panels desktop's
 * campaign slideover has and web's campaign page did not: the AI post-send
 * summary, the reviewer feedback thread, the replies threaded against the
 * send, dynamic-content regions, content remix, and the live report stream.
 *
 * The performance numbers themselves are NOT read here: `GET …/report` is
 * owned by lib/campaign-analytics-api.ts (the drill-down's transport) and the
 * panels reuse its reader and its units note rather than growing a second
 * parser for the same payload.
 *
 * | reader / verb                 | route                                                   | gate (server)     |
 * | ----------------------------- | ------------------------------------------------------- | ----------------- |
 * | `getCampaignSummary`          | GET  /api/v1/campaigns/{id}/summary                     | read:reports      |
 * | `regenerateCampaignSummary`   | POST /api/v1/campaigns/{id}/summary/regenerate          | write:campaigns   |
 * | `listCampaignFeedback`        | GET  /api/v1/campaigns/{id}/feedback                    | read:campaigns    |
 * | `createCampaignFeedback`      | POST /api/v1/campaigns/{id}/feedback                    | write:campaigns   |
 * | `resolveCampaignFeedback`     | POST /api/v1/campaigns/{id}/feedback/{fid}/resolve      | write:campaigns   |
 * | `listCampaignReplies`         | GET  /api/v1/campaigns/{id}/replies?limit=&intent=      | read:reports      |
 * | `classifyCampaignReply`       | POST /api/v1/campaigns/{id}/replies/{rid}/classify      | write:campaigns   |
 * | `getCampaignRegions`          | GET  /api/v1/campaigns/{id}/regions                     | read:campaigns    |
 * | `remixCampaign`               | POST /api/v1/campaigns/{id}/remix                       | write:campaigns + admin |
 * | `subscribeCampaignReportStream` | GET /api/v1/campaigns/{id}/events (SSE)               | read:reports      |
 *
 * WHICH REMIX HANDLER ANSWERS. Two packages declare `POST …/remix`:
 * internal/content_remix (synchronous, template-derived assets, 200) and
 * internal/archive_content_remix (an async job queue, 202 + job id). Only the
 * first is imported by production code — server/sending_forms_routes.go mounts
 * `content_remix.MountRoutes`; archive_content_remix is referenced by a DB
 * test and nothing else. So the answer is `{campaign_id, assets, generated_at}`
 * synchronously, and the gate is `RequireScope(write:campaigns, admin)`, which
 * on the session path means OWNER/ADMIN — an editor is refused even though
 * desktop offers the button to editors.
 *
 * Every mutation here is online-only: each one's result is rendered as the
 * server's answer (a posted comment, a stamped resolve, an LLM label), and an
 * offline-queued version of any of them would show the operator something the
 * server has not said yet.
 */

import { api, isApiError } from "@/lib/api";
import { whenStreamsMayOpen } from "@/lib/realtime/stream-gate";
import {
  parseCampaignReport,
  type CampaignReport,
} from "@/lib/campaign-analytics-api";

/* -------------------------------------------------------------------------
 * Shared coercions — trust the gateway for meaning, not for shape.
 * ---------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/* -------------------------------------------------------------------------
 * 1. AI post-send summary (campaigns-58)
 * ---------------------------------------------------------------------- */

/** Mirrors apps/api/internal/campaign_summary::Summary. */
export interface CampaignAISummary {
  campaign_id: string;
  body_markdown: string;
  /** "voice" when the voice service authored it, "deterministic" otherwise. */
  source: string;
  generated_at: string;
}

/** Statuses the regenerate POST refuses with 409 campaign_not_sent. */
const SUMMARY_PRE_SEND_STATUSES = new Set(["draft", "scheduled", "paused"]);

/**
 * Whether a summary can exist for a campaign in this status. The server only
 * summarises a campaign that has sent — draft / scheduled / paused have no
 * engagement to summarise and the regenerate POST refuses them — so the card
 * says so instead of offering a button that is guaranteed a 409.
 */
export function campaignSummaryAvailable(status: string | undefined): boolean {
  return !SUMMARY_PRE_SEND_STATUSES.has((status ?? "draft").toLowerCase());
}

function parseSummary(value: unknown): CampaignAISummary {
  const row = record(value);
  return {
    campaign_id: str(row.campaign_id),
    body_markdown: str(row.body_markdown),
    source: str(row.source),
    generated_at: str(row.generated_at),
  };
}

/**
 * The persisted summary, or `null` when none has been generated yet. The
 * server answers that case with 404 ("no summary yet — call /regenerate"),
 * which is a state of the card, not a failure of it; every other refusal is
 * rethrown so the card can render the server's sentence.
 */
export async function getCampaignSummary(
  campaignId: string,
): Promise<CampaignAISummary | null> {
  try {
    return parseSummary(
      await api.get<unknown>(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/summary`,
      ),
    );
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

/**
 * Generate (or replace) the summary. The server upserts on campaign_id, so a
 * refresh OVERWRITES the previous summary in place — there is no history.
 * `force` stays false: it is admin-only on the server and re-runs the paid
 * voice round trip, and nothing on this surface needs it.
 */
export async function regenerateCampaignSummary(
  campaignId: string,
): Promise<CampaignAISummary> {
  return parseSummary(
    await api.post<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/summary/regenerate`,
      { force: false },
      { requireOnline: true, maxAttempts: 1 },
    ),
  );
}

export type SummaryRun =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string };

/**
 * The summary's markdown subset, as desktop renders it: paragraphs split on
 * blank lines, `**bold**` and `` `code` `` runs, nothing else. Parsed into
 * runs so the card renders React nodes — the body is model-authored text and
 * is never handed to the DOM as HTML.
 */
export function parseSummaryMarkdown(body: string): SummaryRun[][] {
  return body
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== "")
    .map((paragraph) => {
      const runs: SummaryRun[] = [];
      const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(paragraph)) !== null) {
        if (match.index > cursor) {
          runs.push({ kind: "text", text: paragraph.slice(cursor, match.index) });
        }
        if (match[1] !== undefined) runs.push({ kind: "bold", text: match[1] });
        else if (match[2] !== undefined) {
          runs.push({ kind: "code", text: match[2] });
        }
        cursor = pattern.lastIndex;
      }
      if (cursor < paragraph.length) {
        runs.push({ kind: "text", text: paragraph.slice(cursor) });
      }
      return runs;
    });
}

/* -------------------------------------------------------------------------
 * 2. Feedback thread (campaigns-60)
 * ---------------------------------------------------------------------- */

/** Mirrors apps/api/internal/campaigns/feedback.go::Feedback. */
export interface CampaignFeedback {
  id: string;
  campaign_id: string;
  author_label: string;
  body: string;
  /** Null while open. Resolving is one-way: the gateway mounts no reopen. */
  resolved_at: string | null;
  created_at: string;
}

function parseFeedback(value: unknown): CampaignFeedback {
  const row = record(value);
  return {
    id: str(row.id),
    campaign_id: str(row.campaign_id),
    author_label: str(row.author_label),
    body: str(row.body),
    resolved_at: optionalStr(row.resolved_at),
    created_at: str(row.created_at),
  };
}

/** Newest first, resolved and open together — the card splits them. */
export async function listCampaignFeedback(
  campaignId: string,
): Promise<CampaignFeedback[]> {
  const response = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/feedback`,
    ),
  );
  return list(response.items)
    .map(parseFeedback)
    .filter((row) => row.id !== "");
}

export async function createCampaignFeedback(
  campaignId: string,
  body: string,
): Promise<CampaignFeedback> {
  return parseFeedback(
    await api.post<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/feedback`,
      { body },
      { requireOnline: true },
    ),
  );
}

export async function resolveCampaignFeedback(
  campaignId: string,
  feedbackId: string,
): Promise<CampaignFeedback> {
  return parseFeedback(
    await api.post<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/feedback/${encodeURIComponent(feedbackId)}/resolve`,
      {},
      { requireOnline: true },
    ),
  );
}

/* -------------------------------------------------------------------------
 * 3. Replies threaded against the campaign (campaigns-61)
 * ---------------------------------------------------------------------- */

/** The server's intent vocabulary, in desktop's tab order. */
export const REPLY_INTENTS = [
  "question",
  "praise",
  "unsub",
  "ooo",
  "other",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const REPLY_INTENT_LABELS: Readonly<Record<ReplyIntent, string>> = {
  question: "Question",
  praise: "Praise",
  unsub: "Unsubscribe",
  ooo: "Out of office",
  other: "Other",
};

/** Mirrors apps/api/internal/campaign_replies::Reply. */
export interface CampaignReply {
  id: string;
  from_email: string;
  subject: string;
  body_text: string;
  received_at: string;
  /** True when the body evidence was redacted: it cannot be (re)classified. */
  body_redacted: boolean;
  /** Empty until classified. */
  intent_label: string;
  intent_confidence: number;
}

export interface CampaignRepliesListing {
  campaign_id: string;
  /** Total replies for the campaign when the page was truncated by `limit`. */
  count: number;
  /** Counted over all campaign replies, not just the bounded page. */
  intent_counts: Record<string, number>;
  replies: CampaignReply[];
}

function parseReply(value: unknown): CampaignReply {
  const row = record(value);
  return {
    id: str(row.id),
    from_email: str(row.from_email),
    subject: str(row.subject),
    body_text: str(row.body_text),
    received_at: str(row.received_at),
    body_redacted: row.body_redacted === true,
    intent_label: str(row.intent_label),
    intent_confidence: num(row.intent_confidence),
  };
}

export const REPLIES_PAGE_LIMIT = 50;

export async function listCampaignReplies(
  campaignId: string,
  intent: ReplyIntent | null,
): Promise<CampaignRepliesListing> {
  const params = new URLSearchParams({ limit: String(REPLIES_PAGE_LIMIT) });
  if (intent) params.set("intent", intent);
  const response = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/replies?${params.toString()}`,
    ),
  );
  const counts: Record<string, number> = {};
  for (const [label, count] of Object.entries(record(response.intent_counts))) {
    const value = num(count);
    if (value > 0) counts[label] = value;
  }
  return {
    campaign_id: str(response.campaign_id),
    count: num(response.count),
    intent_counts: counts,
    replies: list(response.replies)
      .map(parseReply)
      .filter((reply) => reply.id !== ""),
  };
}

/** Runs the intent classifier (LLM with a heuristic short-circuit) once. */
export async function classifyCampaignReply(
  campaignId: string,
  replyId: string,
): Promise<CampaignReply> {
  return parseReply(
    await api.post<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/replies/${encodeURIComponent(replyId)}/classify`,
      {},
      { requireOnline: true, maxAttempts: 1 },
    ),
  );
}

/* -------------------------------------------------------------------------
 * 4. Dynamic content regions (campaigns-54)
 * ---------------------------------------------------------------------- */

/** Mirrors apps/api/internal/campaigns/compose.go::Region. */
export interface CampaignRegion {
  key: string;
  /** Go UTF-8 BYTE offset into the persisted body — not a JS string index. */
  start: number;
  end: number;
  true_branch: string;
  false_branch: string;
  has_else: boolean;
  children: CampaignRegion[];
}

export interface CampaignRegions {
  campaign_id: string;
  /** Which persisted field the server parsed: `body_html`, else `plain_text`. */
  source: "body_html" | "plain_text";
  regions: CampaignRegion[];
}

function parseRegion(value: unknown): CampaignRegion {
  const row = record(value);
  return {
    key: str(row.key),
    start: num(row.start),
    end: num(row.end),
    true_branch: str(row.true_branch),
    false_branch: str(row.false_branch),
    has_else: row.has_else === true,
    children: list(row.children).map(parseRegion),
  };
}

export async function getCampaignRegions(
  campaignId: string,
): Promise<CampaignRegions> {
  const response = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/regions`,
    ),
  );
  return {
    campaign_id: str(response.campaign_id),
    source: response.source === "plain_text" ? "plain_text" : "body_html",
    regions: list(response.regions)
      .map(parseRegion)
      .filter((region) => region.key !== ""),
  };
}

/** Appended by "+ Region" — the syntax compose.go::ParseRegions reads. */
export const REGION_SKELETON =
  "\n{{#if EXAMPLE_FLAG}}\n  <p>Shown when EXAMPLE_FLAG is true.</p>\n{{else}}\n  <p>Default copy for everyone else.</p>\n{{/if}}\n";

export type RegionBranchPick = "default" | "true" | "false";

/**
 * Byte offset → UTF-16 index. The server reports region boundaries as Go
 * byte offsets, JS slices by UTF-16 code unit, and any non-ASCII character
 * before a region (an "é" is two bytes, an emoji four) shifts every later
 * boundary. Splicing raw byte offsets corrupts the preview.
 */
function byteToUtf16Map(body: string): number[] {
  const encoder = new TextEncoder();
  const map: number[] = [];
  let bytePos = 0;
  let jsPos = 0;
  while (jsPos < body.length) {
    const codePoint = body.codePointAt(jsPos);
    if (codePoint === undefined) break;
    const unit = String.fromCodePoint(codePoint);
    const bytes = encoder.encode(unit).length;
    for (let b = 0; b < bytes; b += 1) map[bytePos + b] = jsPos;
    bytePos += bytes;
    jsPos += unit.length;
  }
  map[bytePos] = jsPos;
  return map;
}

/**
 * The body as a subscriber in the picked state would see it: each top-level
 * region collapsed to its true branch, its else branch (empty when it has
 * none), or left as authored for "default". Only valid against the body the
 * server parsed — the caller must not apply it to an unsaved draft.
 */
export function applyRegionPicks(
  body: string,
  regions: readonly CampaignRegion[],
  picks: Readonly<Record<string, RegionBranchPick>>,
): string {
  const map = byteToUtf16Map(body);
  const toJs = (byteOffset: number): number => map[byteOffset] ?? body.length;
  let out = body;
  // Back to front, so earlier offsets stay valid while later ranges change.
  for (const region of [...regions].sort((a, b) => b.start - a.start)) {
    const pick = picks[region.key] ?? "default";
    if (pick === "default") continue;
    const startJs = toJs(region.start);
    const endJs = toJs(region.end);
    const replacement =
      pick === "true"
        ? region.true_branch
        : region.has_else
          ? region.false_branch
          : "";
    out = out.slice(0, startJs) + replacement + out.slice(endJs);
  }
  return out;
}

/* -------------------------------------------------------------------------
 * 5. Content remix (campaigns-51)
 * ---------------------------------------------------------------------- */

/** Mirrors content_remix.go::normalizeChannels defaults, in that order. */
export const REMIX_CHANNELS = [
  { id: "web_teaser", label: "Web teaser" },
  { id: "sms", label: "SMS" },
  { id: "social", label: "Social" },
  { id: "podcast_outline", label: "Podcast outline" },
] as const;
export type RemixChannel = (typeof REMIX_CHANNELS)[number]["id"];

export interface RemixAsset {
  channel: string;
  title: string;
  body: string;
}

export interface RemixResult {
  campaign_id: string;
  assets: RemixAsset[];
  generated_at: string;
}

/**
 * Derive cross-channel assets from the SAVED campaign body (the handler reads
 * the row, not the editor). Nothing is persisted, so the request is not
 * replayable offline and carries no idempotency key.
 */
export async function remixCampaign(
  campaignId: string,
  input: { channels: readonly RemixChannel[]; tone: string },
): Promise<RemixResult> {
  const tone = input.tone.trim();
  const response = record(
    await api.post<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/remix`,
      {
        channels: [...input.channels],
        ...(tone ? { tone } : {}),
      },
      { requireOnline: true, maxAttempts: 1, idempotencyKey: null },
    ),
  );
  return {
    campaign_id: str(response.campaign_id),
    generated_at: str(response.generated_at),
    assets: list(response.assets).map((value) => {
      const row = record(value);
      return {
        channel: str(row.channel),
        title: str(row.title),
        body: str(row.body),
      };
    }),
  };
}

/* -------------------------------------------------------------------------
 * 6. Web version (campaigns-57) — the campaign half of the archive link
 * ---------------------------------------------------------------------- */

/**
 * `archive_public` / `archive_slug` ride on the campaign row
 * (campaigns/types.go, `omitempty`) but are not part of web's `Campaign`
 * type, so they are read defensively from the payload the page already has.
 */
export function campaignArchiveFields(campaign: unknown): {
  archivePublic: boolean;
  archiveSlug: string;
} {
  const row = record(campaign);
  return {
    archivePublic: row.archive_public === true,
    archiveSlug: str(row.archive_slug).trim(),
  };
}

/* -------------------------------------------------------------------------
 * 7. Live report stream (campaigns-56's live dot)
 * ---------------------------------------------------------------------- */

export type ReportStreamStatus = "connecting" | "open" | "closed";

/**
 * Subscribe to `GET /api/v1/campaigns/{id}/events`. The server sends a
 * `snapshot` frame on connect and a `delta` frame whenever a count moves, and
 * each frame is a whole CampaignReport — so the consumer paints over the
 * report it already has. Connection state is reported separately from
 * frames: an idle stream is not a broken one.
 *
 * Returns the unsubscribe function. Where EventSource is unavailable the
 * status is reported `closed` at once rather than left on "connecting".
 */
export function subscribeCampaignReportStream(
  campaignId: string,
  handlers: {
    onStatus: (status: ReportStreamStatus) => void;
    onReport: (report: CampaignReport) => void;
  },
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    handlers.onStatus("closed");
    return () => undefined;
  }
  const deliver = (event: MessageEvent<string>) => {
    try {
      handlers.onReport(parseCampaignReport(JSON.parse(event.data)));
    } catch {
      // One malformed frame costs one frame, never the subscription.
    }
  };
  let source: EventSource | null = null;
  let stopped = false;
  // Opening waits for the page to finish loading and go idle once; see
  // realtime/stream-gate.ts. An EventSource is a high-priority request, and the
  // report this stream refreshes has to arrive over the ordinary fetch first.
  const cancelPendingOpen = whenStreamsMayOpen(() => {
    if (stopped) return;
    try {
      source = new EventSource(
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/events`,
        { withCredentials: true },
      );
    } catch {
      handlers.onStatus("closed");
      return;
    }
    handlers.onStatus("connecting");
    source.onopen = () => handlers.onStatus("open");
    source.addEventListener("snapshot", deliver as EventListener);
    source.addEventListener("delta", deliver as EventListener);
    source.onerror = () => handlers.onStatus("connecting");
  });
  return () => {
    stopped = true;
    cancelPendingOpen();
    source?.close();
    handlers.onStatus("closed");
  };
}
