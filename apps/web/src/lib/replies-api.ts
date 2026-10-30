/**
 * lib/replies-api.ts — inbound reply intelligence.
 *
 * Three paths desktop reached and no web file did.
 *
 * TWO QUALIFICATIONS THAT DO NOT SURVIVE NAIVE RENDERING:
 *
 * 1. THE WINDOWS DIFFER. `replies/summary` and `replies/timeseries` report
 *    `window_days: 30`; `replies/top-senders` reports 90. Stacking them under
 *    one heading implies a single period and silently triples the span of the
 *    sender table. Each block therefore states its own window, and the page
 *    says so out loud when they disagree.
 *
 * 2. THERE ARE THREE BANDS, NOT TWO. `human_replies` and
 *    `excluded_non_human` do not partition `total` — `unclassified_replies`
 *    is a separate band that has not been decided either way. Folding it into
 *    "human" overstates engagement; folding it into "excluded" understates
 *    it. It is reported as its own number, and any residual left after all
 *    three are subtracted from `total` is surfaced rather than hidden.
 *
 * `matched` / `unmatched` answer a DIFFERENT question — whether a reply was
 * tied to a known subscriber — and are not a re-cut of the human/bot split.
 */
import { api } from "@/lib/api";

export interface ReplySummary {
  total: number;
  human_replies: number;
  excluded_non_human: number;
  unclassified_replies: number;
  matched: number;
  unmatched: number;
  window_days: number;
  top_campaigns: unknown[];
}

export interface ReplyPoint {
  date: string;
  replies: number;
}

export interface ReplySender {
  recipient_email: string;
  replies: number;
  last_at: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getReplySummary(): Promise<ReplySummary> {
  const r = await api.get<Partial<ReplySummary>>("/api/v1/replies/summary");
  return {
    total: num(r?.total),
    human_replies: num(r?.human_replies),
    excluded_non_human: num(r?.excluded_non_human),
    unclassified_replies: num(r?.unclassified_replies),
    matched: num(r?.matched),
    unmatched: num(r?.unmatched),
    window_days: num(r?.window_days),
    top_campaigns: asArray(r?.top_campaigns),
  };
}

export async function getReplyTimeseries(): Promise<{
  points: ReplyPoint[];
  window_days: number;
}> {
  const r = await api.get<{ points?: unknown; window_days?: unknown }>(
    "/api/v1/replies/timeseries",
  );
  return {
    points: asArray<ReplyPoint>(r?.points),
    window_days: num(r?.window_days),
  };
}

/** The gateway's accepted `days` window (reply_analytics.parseDays: 1..365);
 *  anything else would be silently answered with its 30-day default. */
function replyWindowDays(days: number): number {
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}

/**
 * GET /api/v1/replies/timeseries?days=N — the daily reply series over the
 * window the Analytics range selects (desktop getRepliesTimeseries(days)), so
 * the engagement-velocity chart's replies line spans the same dates as its
 * opens and clicks. The response still states `window_days`; callers show
 * the server's figure, not the one they asked for.
 */
export async function getReplyTimeseriesForDays(
  days: number,
  options?: { signal?: AbortSignal },
): Promise<{ points: ReplyPoint[]; window_days: number }> {
  const r = await api.get<{ points?: unknown; window_days?: unknown }>(
    `/api/v1/replies/timeseries?days=${replyWindowDays(days)}`,
    options,
  );
  return {
    points: asArray<Partial<ReplyPoint>>(r?.points)
      .filter((point) => typeof point?.date === "string")
      .map((point) => ({
        date: String(point.date),
        replies: num(point.replies),
      })),
    window_days: num(r?.window_days),
  };
}

export async function getTopReplySenders(): Promise<{
  senders: ReplySender[];
  window_days: number;
}> {
  const r = await api.get<{ senders?: unknown; window_days?: unknown }>(
    "/api/v1/replies/top-senders",
  );
  return {
    senders: asArray<Partial<ReplySender>>(r?.senders).map((sender) => ({
      recipient_email: String(sender?.recipient_email ?? ""),
      replies: num(sender?.replies),
      last_at: String(sender?.last_at ?? ""),
    })),
    window_days: num(r?.window_days),
  };
}

/**
 * The residual left when the three classification bands are subtracted from
 * `total`. Non-zero means the bands do not account for every reply, which is
 * a fact about the data worth showing rather than rounding away.
 */
export function bandResidual(s: ReplySummary): number {
  return (
    s.total - s.human_replies - s.excluded_non_human - s.unclassified_replies
  );
}

/** True when the sender table covers a different period than the summary. */
export function windowsDisagree(
  summaryDays: number,
  sendersDays: number,
): boolean {
  return summaryDays > 0 && sendersDays > 0 && summaryDays !== sendersDays;
}
