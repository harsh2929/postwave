// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface BestSendTime {
  email?: string;
  best_hour_utc: number;
  computed_at: string;
  sample_size: number;
}

export interface ScheduleByBestTimeResult {
  campaign_id: string;
  scheduled: number;
  within_days: number;
  tenant_mean: number;
  first_5: Array<{ email: string; send_at: string; best_hour_utc: number }>;
}

/**
 * Per-subscriber send-time-optimization. The best hour is the modal
 * hour-of-week (0-167) at which a subscriber has historically opened
 * email; cold subscribers (< 5 opens) fall back to the tenant mean.
 */

/**
 * Identifies the segment to aggregate. The gateway requires exactly one route
 * to a segment; a campaign id resolves to the segment it targets.
 */
export interface SegmentSendTimeParams {
  segment_id?: string;
  campaign_id?: string;
}

export interface SegmentBestSendTime {
  segment_id?: string;
  /** UTC hour-of-day, e.g. "14:00". */
  best_hour_utc?: string;
  confidence?: number;
  /** Below the server's minimum (30 subscribers with history) the API 404s. */
  sample_size?: number;
  computed_at?: string;
}

/**
 * The aggregated 7×24 grid for a segment.
 *
 * Field names mirror `send_time_opt.SegmentPattern` EXACTLY. The first version
 * of this interface invented `sample_size` where the server sends
 * `subscribers_with_data`, which typechecks perfectly and reads as `undefined`
 * at runtime forever — a wrong name is worse than a missing one, because
 * nothing ever errors.
 */
export interface SegmentSendTimeHeatmap {
  segment_id?: string;
  /** How many subscribers had usable history. Below the server minimum it 404s. */
  subscribers_with_data?: number;
  /** Normalised 7-by-24 grid, averaged so power users do not dominate. */
  grid?: number[][];
  best_dow?: number;
  best_hour?: number;
  secondary_dow?: number;
  secondary_hour?: number;
  has_secondary_window?: boolean;
  computed_at?: string;
}

/**
 * Narrows the params to the client's query shape, dropping absent keys rather
 * than sending `segment_id=undefined` — which the gateway would read as an
 * empty string and reject with a confusing 400.
 */
function segmentQuery(
  params: SegmentSendTimeParams,
): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (params.segment_id) query.segment_id = params.segment_id;
  if (params.campaign_id) query.campaign_id = params.campaign_id;
  return query;
}

export class SendTimeResource extends Resource {
  getBestTime(subscriberId: string): Promise<BestSendTime> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/best-send-time`,
    );
  }

  /**
   * A SEGMENT's best send hour, rather than one subscriber's.
   *
   * Declared in the curated surface spec as `getSegmentBestSendTime` and absent
   * from this SDK until a drift gate compared the two. Callers wanting the
   * segment-level answer had to reach past the client entirely.
   *
   * Either `segment_id` or `campaign_id` is required — the gateway resolves a
   * campaign to its segment. Passing neither is a 400 rather than a default,
   * because "the best hour for nobody in particular" is not a question with an
   * answer.
   */
  getSegmentBestTime(params: SegmentSendTimeParams): Promise<SegmentBestSendTime> {
    return this.client.request("GET", "/api/v1/send-time-opt", {
      query: segmentQuery(params),
    });
  }

  /**
   * The 7×24 engagement grid behind that hour.
   *
   * The heatmap is what makes the single number reviewable: an hour with a flat
   * grid behind it is noise, and the API returns both so a caller is not asked
   * to trust one figure.
   */
  getSegmentHeatmap(params: SegmentSendTimeParams): Promise<SegmentSendTimeHeatmap> {
    return this.client.request("GET", "/api/v1/send-time-opt/heatmap", {
      query: segmentQuery(params),
    });
  }

  scheduleCampaignByBestTime(campaignId: string, withinDays: number): Promise<ScheduleByBestTimeResult> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/schedule-by-best-time`,
      { body: { within_days: withinDays } },
    );
  }
}
