/**
 * api/replyAnalytics.ts — the three workspace reply-intelligence reads.
 *
 *   GET /api/v1/replies/summary?days=N              (viewer · read:reports)
 *   GET /api/v1/replies/timeseries?days=N           (viewer · read:reports)
 *   GET /api/v1/replies/top-senders?days=N&limit=L  (viewer · read:reports)
 *
 * All mounted by apps/api/internal/reply_analytics/reply_analytics.go:54-57;
 * routeauth/manifest.json lists each with session_minimum_role "viewer", so
 * there is no role gate here — the section renders for everyone the
 * Analytics screen renders for.
 *
 * Two outcomes are deliberately NOT errors:
 *
 *  - 404 / 405 / 501 resolve to `null` (summary) or `[]` (the lists). A
 *    deployment without the reply subsystem is not a fault, and the section
 *    says the capability is absent rather than painting a red state for
 *    something never installed. Same contract as `useCampaignReplies`, which
 *    reads the per-campaign face of the same package.
 *  - `days` is a control the server HONOURS (parseDays, :325), unlike the
 *    benchmark and cohort reads on the same screen, so the window is passed
 *    through rather than fixed.
 *
 * A 2xx body the parser cannot read IS an error (`ReplyAnalyticsShapeError`):
 * a truncated response rendered as "No replies" would be a fact about the
 * audience, not about the connection.
 */
import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

import {
  parseReplySummary,
  parseReplyTimeseries,
  parseReplyTopSenders,
  TOP_SENDERS_LIMIT,
  type ReplyPoint,
  type ReplySummary,
  type ReplyTopSender,
} from "@/lib/replyAnalytics";
import { WireShapeError } from "@/lib/wireShapeError";

export class ReplyAnalyticsError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "ReplyAnalyticsError";
  }
}

/** A WireShapeError, so errorCopy and every `instanceof` check read it as one. */
export class ReplyAnalyticsShapeError extends WireShapeError {
  constructor(resource: string) {
    super(resource);
    this.name = "ReplyAnalyticsShapeError";
  }
}

export function replySummaryPath(days: number): string {
  return `/api/v1/replies/summary?days=${days}`;
}

export function replyTimeseriesPath(days: number): string {
  return `/api/v1/replies/timeseries?days=${days}`;
}

export function replyTopSendersPath(
  days: number,
  limit: number = TOP_SENDERS_LIMIT,
): string {
  return `/api/v1/replies/top-senders?days=${days}&limit=${limit}`;
}

/** The statuses that mean "this deployment has no reply subsystem". */
function isAbsentEndpoint(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** `null` when the deployment does not expose reply analytics. */
export async function fetchReplySummary(
  days: number,
): Promise<ReplySummary | null> {
  const res = await rawRequest<unknown>("GET", replySummaryPath(days));
  if (res.error) {
    if (isAbsentEndpoint(res.error.status)) return null;
    throw new ReplyAnalyticsError(res.error, "Couldn't load reply analytics.");
  }
  const parsed = parseReplySummary(res.data);
  if (!parsed) throw new ReplyAnalyticsShapeError("reply summary");
  return parsed;
}

/** Empty when the deployment does not expose reply analytics. */
export async function fetchReplyTimeseries(days: number): Promise<ReplyPoint[]> {
  const res = await rawRequest<unknown>("GET", replyTimeseriesPath(days));
  if (res.error) {
    if (isAbsentEndpoint(res.error.status)) return [];
    throw new ReplyAnalyticsError(res.error, "Couldn't load the reply trend.");
  }
  const parsed = parseReplyTimeseries(res.data);
  if (!parsed) throw new ReplyAnalyticsShapeError("reply timeseries");
  return parsed;
}

/** Empty when the deployment does not expose reply analytics. */
export async function fetchReplyTopSenders(
  days: number,
  limit: number = TOP_SENDERS_LIMIT,
): Promise<ReplyTopSender[]> {
  const res = await rawRequest<unknown>(
    "GET",
    replyTopSendersPath(days, limit),
  );
  if (res.error) {
    if (isAbsentEndpoint(res.error.status)) return [];
    throw new ReplyAnalyticsError(res.error, "Couldn't load the top responders.");
  }
  const parsed = parseReplyTopSenders(res.data);
  if (!parsed) throw new ReplyAnalyticsShapeError("top responders");
  return parsed;
}
