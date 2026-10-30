/**
 * subscriberTimeline — GET /api/v1/subscribers/{id}/timeline.
 *
 * Lifted out of app/(tabs)/subscribers/[id].tsx, where it was the only
 * resource in the app whose fetcher lived inside a route file. That
 * placement cost it two things this module restores:
 *
 *  - it collapsed EVERY non-404/405/501 failure into an anonymous
 *    `{ok:false}`, so the retry UI could only ever say "check your
 *    connection" even for a 500 or an auth failure. The original error is
 *    carried on the result now.
 *  - it duplicated the page wire type next to (but out of sync with)
 *    SubscriberTimelineEvent in src/api/mobileParity.ts.
 *
 * Note: the endpoint is mounted in Go
 * (apps/api/internal/subscribers/handlers.go) but is NOT in openapi.json.
 */
import type { SubscriberTimelineEvent } from "@/api/mobileParity";
import { getClient } from "@/api/sdkClient";

/** Stats block the detail header, gauge and sparkline all read from. */
export interface SubscriberTimelineStatsWire {
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  replied_count: number;
  open_rate: number;
  click_rate: number;
  engagement_score: number;
  engagement_daily_30d: number[];
  subscribed_at: string;
  last_active_at?: string;
  current_status: string;
}

export interface TimelinePage {
  subscriber_id: string;
  email: string;
  stats: SubscriberTimelineStatsWire;
  events: SubscriberTimelineEvent[];
  pagination: {
    before?: string;
    next_cursor?: string;
    limit: number;
    has_more: boolean;
  };
}

export interface TimelineFetchResult {
  ok: boolean;
  /** The deployment does not expose the endpoint at all (404/405/501). */
  unavailable: boolean;
  page?: TimelinePage;
  /** The real failure, for an honest ErrorState. Absent when ok. */
  error?: unknown;
}

/** Events per request. */
export const TIMELINE_PAGE_SIZE = 50;

/**
 * How many pages the list auto-fetches on scroll before it stops and asks.
 * 10 × 50 = 500 events, which is far more than anyone reads in one sitting
 * and far less than the unbounded accumulation this replaces.
 */
export const TIMELINE_AUTO_PAGE_LIMIT = 10;

/** HTTP statuses that mean "this deployment has no timeline endpoint". */
export function isTimelineUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** Best-effort numeric status off an unknown thrown value. */
export function errorStatus(err: unknown): number {
  if (!err || typeof err !== "object" || !("status" in err)) return 0;
  return Number((err as { status?: unknown }).status) || 0;
}

/**
 * Build the page URL.
 *
 * The cursor MUST be sent as `?cursor=`, not `?before=`. They are two
 * different parameters on the same handler
 * (apps/api/internal/subscribers/handlers.go Timeline):
 *
 *   cursor — the opaque base64(JSON) composite position the response's
 *            `pagination.next_cursor` carries.
 *   before — an RFC3339 TIMESTAMP, the legacy coarse form.
 *
 * Feeding `next_cursor` into `before` made the server try
 * `time.Parse(RFC3339, "<base64>")`, which fails and answers 400
 * `bad_before`. Because a failed page contributes no events and only the
 * FIRST page drives the error state, page 2 silently never arrived: the
 * timeline just stopped at 50 events with no error and no spinner.
 */
export function timelinePath(id: string, cursor: string | null): string {
  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  qs.set("limit", String(TIMELINE_PAGE_SIZE));
  return `/api/v1/subscribers/${encodeURIComponent(id)}/timeline?${qs.toString()}`;
}

export async function fetchTimelinePage(
  id: string,
  cursor: string | null,
): Promise<TimelineFetchResult> {
  const { client } = getClient();
  try {
    const res = await client.request<TimelinePage>(
      "GET",
      timelinePath(id, cursor),
    );
    return { ok: true, unavailable: false, page: res };
  } catch (err) {
    if (isTimelineUnavailableStatus(errorStatus(err))) {
      return { ok: false, unavailable: true };
    }
    return { ok: false, unavailable: false, error: err };
  }
}
