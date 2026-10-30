// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber drill-down timeline endpoint. Backend:
// apps/api/internal/subscribers/timeline.go.

import { api } from "./api";

export const SUBSCRIBER_TIMELINE_CATEGORIES = [
  "all",
  "engagement",
  "delivery",
  "consent",
  "profile",
] as const;
export type SubscriberTimelineCategory =
  (typeof SUBSCRIBER_TIMELINE_CATEGORIES)[number];

export interface SubscriberTimelineEvent {
  type: string;
  occurred_at: string;
  subject_id?: string;
  subject?: string;
  campaign_id?: string;
  detail?: Record<string, unknown>;
  source: string;
}

export interface SubscriberTimelineStats {
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  replied_count: number;
  open_rate: number;
  click_rate: number;
  engagement_score: number;
  subscribed_at: string;
  last_active_at?: string;
  current_status: string;
}

export interface SubscriberTimelinePagination {
  before?: string;
  next_cursor?: string;
  limit: number;
  has_more: boolean;
}

export interface SubscriberTimeline {
  subscriber_id: string;
  email: string;
  stats: SubscriberTimelineStats;
  events: SubscriberTimelineEvent[];
  pagination: SubscriberTimelinePagination;
}

export function getSubscriberTimeline(
  id: string,
  opts: {
    cursor?: string;
    limit?: number;
    category?: SubscriberTimelineCategory;
    signal?: AbortSignal;
  } = {},
): Promise<SubscriberTimeline> {
  return api
    .get<unknown>(`/api/v1/subscribers/${encodeURIComponent(id)}/timeline`, {
      query: {
        cursor: opts.cursor,
        limit: opts.limit,
        category: opts.category === "all" ? undefined : opts.category,
      },
      signal: opts.signal,
    })
    .then((value) => parseSubscriberTimeline(value, id));
}

const timelineRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const timelineTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

const timelineNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseSubscriberTimeline(
  value: unknown,
  expectedSubscriberId: string,
): SubscriberTimeline {
  if (
    !timelineRecord(value) ||
    value.subscriber_id !== expectedSubscriberId ||
    typeof value.email !== "string" ||
    value.email.length < 3 ||
    value.email.length > 320 ||
    !timelineRecord(value.stats) ||
    !Array.isArray(value.events) ||
    value.events.length > 200 ||
    !timelineRecord(value.pagination)
  ) {
    throw new Error("The subscriber timeline returned an invalid response.");
  }
  const stats = value.stats;
  const countKeys = [
    "sent_count",
    "opened_count",
    "clicked_count",
    "bounced_count",
    "replied_count",
  ] as const;
  if (
    !countKeys.every(
      (key) => Number.isSafeInteger(stats[key]) && Number(stats[key]) >= 0,
    ) ||
    !["open_rate", "click_rate", "engagement_score"].every((key) =>
      timelineNumber(stats[key]),
    ) ||
    Number(stats.open_rate) > 1 ||
    Number(stats.click_rate) > 1 ||
    Number(stats.engagement_score) > 1 ||
    !timelineTimestamp(stats.subscribed_at) ||
    !(
      stats.last_active_at === undefined ||
      timelineTimestamp(stats.last_active_at)
    ) ||
    typeof stats.current_status !== "string" ||
    stats.current_status.length > 64
  ) {
    throw new Error("The subscriber timeline returned invalid statistics.");
  }
  const events: SubscriberTimelineEvent[] = value.events.map((candidate) => {
    if (
      !timelineRecord(candidate) ||
      typeof candidate.type !== "string" ||
      candidate.type.length < 1 ||
      candidate.type.length > 96 ||
      !timelineTimestamp(candidate.occurred_at) ||
      typeof candidate.source !== "string" ||
      candidate.source.length < 1 ||
      candidate.source.length > 96 ||
      !(
        candidate.subject_id === undefined ||
        (typeof candidate.subject_id === "string" &&
          candidate.subject_id.length <= 256)
      ) ||
      !(
        candidate.subject === undefined ||
        (typeof candidate.subject === "string" &&
          candidate.subject.length <= 512)
      ) ||
      !(
        candidate.campaign_id === undefined ||
        (typeof candidate.campaign_id === "string" &&
          candidate.campaign_id.length <= 256)
      ) ||
      !(candidate.detail === undefined || timelineRecord(candidate.detail))
    ) {
      throw new Error("The subscriber timeline returned an invalid event.");
    }
    return candidate as unknown as SubscriberTimelineEvent;
  });
  const pagination = value.pagination;
  if (
    !Number.isSafeInteger(pagination.limit) ||
    Number(pagination.limit) < 1 ||
    Number(pagination.limit) > 200 ||
    typeof pagination.has_more !== "boolean" ||
    !(
      pagination.next_cursor === undefined ||
      (typeof pagination.next_cursor === "string" &&
        pagination.next_cursor.length > 0 &&
        pagination.next_cursor.length <= 2_048)
    ) ||
    !(
      pagination.before === undefined ||
      (typeof pagination.before === "string" &&
        timelineTimestamp(pagination.before))
    ) ||
    (pagination.has_more && typeof pagination.next_cursor !== "string")
  ) {
    throw new Error("The subscriber timeline returned invalid pagination.");
  }
  return {
    subscriber_id: expectedSubscriberId,
    email: value.email,
    stats: stats as unknown as SubscriberTimelineStats,
    events,
    pagination: pagination as unknown as SubscriberTimelinePagination,
  };
}
