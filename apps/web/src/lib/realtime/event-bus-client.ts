// SPDX-License-Identifier: AGPL-3.0-only
//
// Lightweight browser client for the realtime event bus
// (GET /api/v1/events, see apps/api/internal/events). One EventSource per
// session, cookie-session authenticated (the web app already runs every /api
// request in a same-origin session context, so EventSource(withCredentials)
// authenticates the stream without a query-param token — mirrors
// subscribeMigrationEvents in lib/migration-progress-api.ts).
//
// The bus exposes a single onEvent(handler) subscription that fires for every
// in-scope topic; the cache-invalidation wiring lives in
// use-realtime-invalidation.ts which feeds events into
// event-query-map::queryKeysForEvent.
//
// Reconnect: exponential backoff (1s → 30s), reset on a clean open. Named SSE
// events do NOT fall through to onmessage, so we register one listener per
// concrete topic the server may emit plus the bootstrap `ready` event.

import { parseJsonStreamPayload } from "@/lib/stream-payload";

import {
  advanceReplayCursor,
  usableEventTopicFilters,
  parseReplayResponse,
  replayRequestPath,
  EMPTY_REPLAY_CURSOR,
  type ReplayCursor,
} from "@postwave/query-contract";

import { WEB_INVALIDATION_TOPICS, type RealtimeEvent } from "./event-query-map";
import { whenStreamsMayOpen } from "./stream-gate";

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

export type RealtimeHandler = (evt: RealtimeEvent) => void;
export type Unsubscribe = () => void;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Pages of gap recovery per reconnect. A client back after hours does not need
 * the entire retained log replayed into its cache — the newest window restores
 * freshness, and everything older is past the staleTime that would have
 * refetched it anyway.
 */
/**
 * How far back a time-mode resume reaches beyond the client's own cursor.
 *
 * `at` is stamped by whichever API replica published the event, so a row
 * written by a lagging replica can land behind a cursor advanced from a
 * leading one — and no later page ever covers it, because the window has moved
 * past. Replay is idempotent by design, so re-reading a few seconds costs one
 * redundant refetch and closes a permanent hole.
 */
const REPLAY_SKEW_GRACE_MS = 5_000;

const REPLAY_MAX_PAGES = 5;

/**
 * Concrete (non-wildcard) topic names the server emits that this client cares
 * about. EventSource only delivers a named `event: <topic>` to an
 * addEventListener(topic) listener — there is no catch-all for named events —
 * so every concrete topic needs its own listener. Keep roughly in sync with
 * the Go emitters; an unmapped topic is simply not delivered (safe no-op).
 */
const CONCRETE_TOPICS = WEB_INVALIDATION_TOPICS;

export interface RealtimeBusOptions {
  /** Build the SSE URL. Defaults to the same-origin /api/v1/events endpoint. */
  buildUrl?: (topicsCsv: string) => string;
  /** Topic globs to negotiate with the server. Defaults to the web set. */
  topics?: readonly string[];
  /**
   * Replay the gap on reconnect. Default true. Set false for connections that
   * carry only ephemeral state (presence), where a replayed row is a stale
   * snapshot that lands AFTER the fresh one and wins.
   */
  recover?: boolean;
}

function defaultBuildUrl(topicsCsv: string): string {
  return `/api/v1/events?topics=${encodeURIComponent(topicsCsv)}`;
}

/**
 * Build the `?topics=` CSV, dropping anything the gateway would reject.
 *
 * Web previously did a bare `topics.join(",")` — no grammar check, no bound —
 * which is how `subscriber.lifecycle_stage_changed` sat in this list for as
 * long as it did while the server silently discarded it. Validating here means
 * a bad topic fails a test rather than becoming an invisible dead subscription,
 * and `isValidEventTopicFilter` is the SAME predicate the gateway compiles, so
 * the two cannot drift.
 */
export function buildTopicsCsv(topics: readonly string[]): string {
  // The bounds live in @postwave/query-contract so the STREAM and the REPLAY
  // path cannot degrade differently — two hand-copied caps is how one silent
  // failure becomes two.
  const usable = usableEventTopicFilters(topics);
  // Truncating mid-list would silently narrow the subscription; falling back to
  // the wildcard keeps the stream useful and is what the native clients do.
  return usable === null ? "*" : usable.join(",");
}

/**
 * Open the realtime stream and invoke `handler` for every parsed event.
 * Browser-only — returns a no-op disconnect under SSR / when EventSource is
 * unavailable. The returned function tears the stream down and stops retries.
 */
export function connectRealtimeBus(
  handler: RealtimeHandler,
  onStatus?: (s: RealtimeStatus) => void,
  opts: RealtimeBusOptions = {},
): Unsubscribe {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    onStatus?.("closed");
    return () => {};
  }

  const topics = opts.topics ?? WEB_INVALIDATION_TOPICS;
  const buildUrl = opts.buildUrl ?? defaultBuildUrl;
  const topicsCsv = buildTopicsCsv(topics);
  // Gap recovery. SSE has no redelivery: everything published while the stream
  // was down is simply lost, and the UI stays quietly wrong until some query's
  // staleTime happens to expire. The cursor tracks the newest event seen so a
  // reconnect can replay the window instead of resuming blind.
  let cursor: ReplayCursor = EMPTY_REPLAY_CURSOR;
  let recovering = false;
  let inFlight: AbortController | null = null;
  // Ephemeral topics opt out. Presence rows are persisted like everything
  // else, so a reconnect would replay a HISTORICAL viewer list on top of the
  // fresh snapshot the re-subscribe just produced — and the stale one wins,
  // because it arrives second. There is no gap worth recovering in state that
  // is only ever "right now".
  const recover = opts.recover !== false;

  let es: EventSource | null = null;
  let stopped = false;
  let backoffMs = MIN_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: RealtimeStatus): void => onStatus?.(s);

  const dispatch = (ev: MessageEvent<string>): void => {
    if (stopped) return;
    const parsed = parseJsonStreamPayload<RealtimeEvent>(ev.data);
    if (!parsed.ok) return;
    const value = parsed.value;
    if (!value || typeof value.topic !== "string") return;
    cursor = advanceReplayCursor(cursor, value as never);
    try {
      handler(value);
    } catch {
      /* a throwing handler must not kill the stream */
    }
  };

  /**
   * Replay everything published while the stream was down, then resume live.
   *
   * Bounded by `maxPages` so a client returning after a long absence cannot
   * spin through the entire retained log; the newest page is the one that
   * matters for freshness, and anything older is already past most staleTimes.
   * Every failure path is silent and non-fatal — recovery is best-effort, and
   * an exception here would take the live subscription down with it, turning a
   * recoverable gap into no realtime at all.
   */
  const recoverGap = async (): Promise<void> => {
    if (recovering) return;
    recovering = true;
    const abort = new AbortController();
    inFlight = abort;
    try {
      for (let page = 0; page < REPLAY_MAX_PAGES; page += 1) {
        // `disconnect()` runs on tenant switch, role change and logout. A walk
        // that does not check here keeps calling `handler` afterwards, and the
        // handler invalidates against the PREVIOUS identity's query keys.
        if (stopped) return;
        // Widen only the FIRST page, and only in time mode. The grace absorbs
        // skew between the replicas that stamp `at`; applying it to every page
        // would re-request the window the previous page just returned.
        const path = replayRequestPath(
          cursor,
          topics,
          page === 0 ? { skewGraceMs: REPLAY_SKEW_GRACE_MS } : {},
        );
        if (path === null) return; // first connection: nothing to recover
        const res = await fetch(path, {
          credentials: "same-origin",
          signal: abort.signal,
        });
        if (!res.ok || stopped) return;
        const raw = await res.json();
        // Re-check AFTER the body read, not only after the fetch. The headers
        // can arrive before `disconnect()` and the body after it, and a page is
        // up to 200 events — every one of which would invalidate against the
        // previous identity's query keys on a tenant switch or logout.
        if (stopped) return;
        const body = parseReplayResponse(raw);
        for (const evt of body.events) {
          cursor = advanceReplayCursor(cursor, evt as never);
          try {
            handler(evt as unknown as RealtimeEvent);
          } catch {
            /* one bad handler call must not abort the rest of the page */
          }
        }
        // Only trust a cursor the server actually advanced; otherwise a page
        // that scanned nothing would loop forever on the same request.
        if (body.cursor.sinceAt || body.cursor.sequenceId !== null) {
          cursor = advanceReplayCursor(cursor, {
            ts: body.cursor.sinceAt ?? undefined,
            sequence_id: body.cursor.sequenceId ?? undefined,
          });
        }
        if (!body.hasMore) return;
      }
    } catch {
      /* offline, aborted, malformed — resume live without recovery */
    } finally {
      recovering = false;
      if (inFlight === abort) inFlight = null;
    }
  };

  const cleanup = (): void => {
    // Cancel any recovery walk in flight. Storing the controller without ever
    // calling abort() made it write-only state: the walk kept running and kept
    // dispatching, which is the whole failure this was meant to prevent.
    if (inFlight) {
      try {
        inFlight.abort();
      } catch {
        /* already settled */
      }
      inFlight = null;
    }
    if (es) {
      es.onopen = null;
      es.onerror = null;
      es.onmessage = null;
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer != null) return;
    setStatus("reconnecting");
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, wait);
  };

  const open = (): void => {
    if (stopped) return;
    setStatus(backoffMs === MIN_BACKOFF_MS ? "connecting" : "reconnecting");
    try {
      es = new EventSource(buildUrl(topicsCsv), { withCredentials: true });
    } catch {
      scheduleRetry();
      return;
    }

    es.onopen = (): void => {
      if (stopped) return;
      const wasReconnect = backoffMs !== MIN_BACKOFF_MS;
      backoffMs = MIN_BACKOFF_MS;
      setStatus("open");
      // Only after a RECONNECT. A first open has no gap by definition, and
      // replaying from nothing would deliver the whole retained log.
      if (wasReconnect && recover) void recoverGap();
    };

    // Named events (event: campaign.sent) only reach a same-named listener, so
    // register one per topic we care about. This MUST include the caller's
    // negotiated `topics` (e.g. presence.update / presence.entity) — not just
    // the default invalidation set — or those named frames are silently dropped
    // even though the server is asked to send them via ?topics=. `topics`
    // already resolves to opts.topics ?? WEB_INVALIDATION_TOPICS above.
    const listenTopics = new Set<string>([...CONCRETE_TOPICS, ...topics]);
    for (const name of listenTopics) {
      es.addEventListener(name, dispatch as EventListener);
    }
    // Unnamed events still flow through onmessage.
    es.onmessage = dispatch;

    es.onerror = (): void => {
      if (stopped) return;
      cleanup();
      scheduleRetry();
    };
  };

  // The FIRST open waits for the page to finish loading and go idle once; see
  // stream-gate.ts. An EventSource is a high-priority request, and on a link
  // Chrome rates as slow it queues ahead of the lazy chunks and first queries
  // the dashboard needs to become interactive at all. Reconnects go straight
  // through `open()` with the backoff above, unchanged.
  const cancelPendingOpen = whenStreamsMayOpen(open);

  return (): void => {
    stopped = true;
    cancelPendingOpen();
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    cleanup();
    setStatus("closed");
  };
}
