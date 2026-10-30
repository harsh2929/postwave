import { rawRequest, type AIApiResult } from "./request";

export interface SegmentBestSendTime {
  segment_id?: string;
  /** UTC hour-of-day rendered by the gateway as `HH:00`. */
  best_hour_utc: string;
  confidence?: number;
  sample_size?: number;
  computed_at: string;
  [extra: string]: unknown;
}

export function parseBestHourUTC(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):00$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

export function nextBestSendOccurrence(
  recommendation: SegmentBestSendTime,
  now = new Date(),
): string | null {
  const hour = parseBestHourUTC(recommendation.best_hour_utc);
  if (hour == null) return null;
  const target = new Date(now);
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(hour);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

export async function getSegmentBestSendTime(opts: {
  segmentId?: string | null;
  campaignId?: string | number | null;
}): Promise<AIApiResult<SegmentBestSendTime>> {
  const params = new URLSearchParams();
  if (opts.segmentId) params.set("segment_id", String(opts.segmentId));
  if (opts.campaignId != null && opts.campaignId !== "") {
    params.set("campaign_id", String(opts.campaignId));
  }
  const qs = params.toString();
  const path = `/api/v1/send-time-opt${qs ? `?${qs}` : ""}`;
  const res = await rawRequest<SegmentBestSendTime | null>("GET", path);
  if (res.error) return { data: null, error: res.error };
  return { data: (res.data ?? {}) as SegmentBestSendTime, error: null };
}
