/**
 * api/eventReplay.ts — realtime gap recovery (NATIVE#8).
 *
 * Runs the walk planned by `eventReplayPlan.ts` against
 * `GET /api/v1/events/replay`. Called by `lib/eventCacheSync.ts` on every
 * successful stream open, BEFORE live frames are dispatched, so events
 * published while the socket was closed (the server's 5-minute max-duration
 * cut, a backgrounded app, a tunnel) still reach the cache.
 *
 * Cold start runs in DISCOVERY mode: there is no server endpoint that reports
 * the current head, so the first walk exists purely to learn a cursor and
 * dispatches nothing. That is not a compromise — a cold start has just fetched
 * every visible query, so invalidating them again would be pure waste.
 */
import type { MobileEventBusEvent } from "./eventBus";
import {
  buildEventReplayPath,
  EVENT_REPLAY_DISCOVERY_LIMIT,
  EVENT_REPLAY_DISCOVERY_MAX_PAGES,
  EVENT_REPLAY_MAX_PAGES,
  EVENT_REPLAY_PAGE_LIMIT,
  parseEventReplayPage,
  planNextReplayStep,
  type ReplayStopReason,
} from "./eventReplayPlan";

export interface EventReplayResult {
  /** Cursor to carry into the next walk. */
  cursor: number;
  /** Whether this walk was cursor discovery (no events dispatched). */
  discovery: boolean;
  /** Rows read from the log. */
  read: number;
  /** Rows handed to `onEvent`. */
  dispatched: number;
  reason: ReplayStopReason | "request-failed";
}

type ReplayRequest = (path: string) => Promise<{ data: unknown; error: unknown }>;

/**
 * Imported lazily on first use. `api/request.ts` reaches the auth store and
 * therefore React Native; deferring it keeps the walk itself unit-testable in
 * the node environment with an injected request.
 */
const defaultRequest: ReplayRequest = async (path) => {
  const { rawRequest } = await import("./request");
  return rawRequest<unknown>("GET", path);
};

/**
 * Walk the retained event log forward from `cursor`.
 *
 * Pass `cursor: null` for the first walk of a process (discovery). Never
 * throws: a failed request ends the walk with the cursor we already held, so a
 * replay outage degrades to "no gap recovery", never to a broken stream.
 */
export async function runEventReplay(input: {
  cursor: number | null;
  onEvent?: (event: MobileEventBusEvent) => void;
  request?: ReplayRequest;
}): Promise<EventReplayResult> {
  const request = input.request ?? defaultRequest;
  const discovery = input.cursor === null;
  const limit = discovery
    ? EVENT_REPLAY_DISCOVERY_LIMIT
    : EVENT_REPLAY_PAGE_LIMIT;
  const maxPages = discovery
    ? EVENT_REPLAY_DISCOVERY_MAX_PAGES
    : EVENT_REPLAY_MAX_PAGES;

  let cursor = discovery ? 0 : (input.cursor ?? 0);
  let read = 0;
  let dispatched = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const res = await request(buildEventReplayPath(cursor, limit));
    if (res.error || res.data === undefined) {
      return { cursor, discovery, read, dispatched, reason: "request-failed" };
    }
    const page = parseEventReplayPage(res.data);
    if (page) {
      read += page.events.length;
      if (!discovery && input.onEvent) {
        for (const event of page.events) {
          input.onEvent({
            topic: event.topic,
            tenant_id: "",
            at: event.at,
            ...(event.payload ? { payload: event.payload } : {}),
          });
          dispatched += 1;
        }
      }
    }
    const step = planNextReplayStep({
      previousCursor: cursor,
      pageIndex,
      page,
      maxPages,
    });
    cursor = step.cursor;
    if (step.done) {
      return {
        cursor,
        discovery,
        read,
        dispatched,
        reason: step.reason ?? "caught-up",
      };
    }
  }
  return { cursor, discovery, read, dispatched, reason: "page-budget" };
}
