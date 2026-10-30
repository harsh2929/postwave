/**
 * Server-Sent Events helpers for live metrics.
 *
 * Wraps the native EventSource so that callers get:
 *   - typed snapshot payloads (parametrised by the response shape)
 *   - automatic reconnect with exponential backoff (1s, 2s, 4s, 8s, …, capped at 30s)
 *   - a single `disconnect()` function to tear everything down cleanly
 *   - a "reconnecting" status so the UI can show a small hint
 *   - short-lived stream-token auth so long-lived API keys stay out of URLs
 *
 * AUTH CAVEAT
 * -----------
 * The browser's `EventSource` constructor does NOT support custom headers, so
 * we first mint a short-lived `/api/v1/streams/token` credential and place that
 * in the URL. Long-lived API keys are never placed in a query string; when a
 * stream token cannot be minted, callers must surface an unavailable state or
 * use an explicitly authenticated polling path.
 */

import {
  type CampaignReport,
  type DashboardStatsResponse,
  buildStreamUrl,
} from "./api-client";
import { parseJsonStreamPayload } from "./stream-payload";

/** State the wrapper reports back through `onStatus`. */
export type SseStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Returned from every `connect*` helper. Callers store it on a ref / in
 * useEffect cleanup and call it on unmount or when they want to stop.
 *
 * Calling `disconnect()` is idempotent — multiple calls are safe.
 */
export type Disconnect = () => void;

interface ConnectOptions<T> {
  /** Build a fully authenticated EventSource URL for one connection attempt. */
  url: () => Promise<string>;
  /** Called whenever a new snapshot/delta event is received. */
  onSnapshot: (snap: T) => void;
  /** Called on unrecoverable errors (still attempts to reconnect). */
  onError?: (err: { message: string; status?: number }) => void;
  /** Called when the connection state changes. */
  onStatus?: (status: SseStatus) => void;
  /**
   * Names of `event:` types in the SSE stream that should fire `onSnapshot`.
   * The Go server emits `snapshot` (initial) and `delta` (subsequent ticks);
   * default covers both. Callers can override for other endpoints.
   */
  eventNames?: string[];
}

/* ------------------------------------------------------------------ */
/*  Internal generic connector                                         */
/* ------------------------------------------------------------------ */

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * D02-http-auth#11: cap consecutive failed reconnects. A permanently
 * dead session mints an uncredentialed EventSource URL (token endpoint
 * 401s → the connection 401s) →
 * onerror → retry, forever. Without a limit a backgrounded desktop
 * generates an indefinite request storm (one /streams/token POST + one
 * SSE connect per ≤30s) and shows a perpetual "reconnecting" hint. A
 * successful open resets the counter, so genuine transient drops still
 * recover; only a stream that never opens after N tries gives up.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

function connect<T>(opts: ConnectOptions<T>): Disconnect {
  if (!isSseSupported()) {
    opts.onStatus?.("closed");
    return (): void => {
      /* no-op */
    };
  }
  const events = opts.eventNames ?? ["snapshot", "delta", "message"];

  let es: EventSource | null = null;
  let backoffMs = MIN_BACKOFF_MS;
  let retryTimer: number | null = null;
  let stopped = false;
  // Consecutive reconnect attempts that never reached a successful open.
  // Reset in es.onopen; checked in scheduleRetry (see MAX_CONSECUTIVE_FAILURES).
  let consecutiveFailures = 0;

  const setStatus = (s: SseStatus): void => {
    opts.onStatus?.(s);
  };

  const cleanup = (): void => {
    if (es) {
      // Remove handlers explicitly so any in-flight callbacks are dropped.
      es.onopen = null;
      es.onerror = null;
      for (const name of events) {
        es.removeEventListener(name, onMessage as EventListener);
      }
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
  };

  const onMessage = (ev: MessageEvent<string>): void => {
    if (stopped) return;
    const parsed = parseJsonStreamPayload<T>(ev.data);
    if (!parsed.ok) {
      opts.onError?.({ message: parsed.message });
      return;
    }
    opts.onSnapshot(parsed.value);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    setStatus(
      es == null && backoffMs === MIN_BACKOFF_MS
        ? "connecting"
        : "reconnecting",
    );

    let url: string;
    try {
      url = await opts.url();
    } catch (err) {
      if (stopped) return;
      opts.onError?.({
        message:
          err instanceof Error ? err.message : "Could not build stream URL",
      });
      scheduleRetry();
      return;
    }
    if (stopped) return;
    try {
      es = new EventSource(url);
    } catch (err) {
      opts.onError?.({
        message:
          err instanceof Error
            ? err.message
            : "EventSource construction failed",
      });
      scheduleRetry();
      return;
    }

    es.onopen = (): void => {
      if (stopped) return;
      backoffMs = MIN_BACKOFF_MS; // successful open resets the backoff window
      consecutiveFailures = 0; // …and the give-up counter (D02-http-auth#11)
      setStatus("open");
    };

    // Bind every named event to the same parser. Default `message` is also
    // wired so endpoints that don't set an `event:` line still work.
    for (const name of events) {
      es.addEventListener(name, onMessage as EventListener);
    }

    es.onerror = (): void => {
      if (stopped) return;
      // EventSource doesn't surface the HTTP status on error events. The
      // browser silently sets readyState to CLOSED for terminal failures
      // (4xx incl. 401) and CONNECTING for transient drops. Either way we
      // close and schedule a reconnect with backoff. The 401-specific
      // detection that the spec calls for is delegated to the caller via
      // a polling fallback when reconnects keep failing.
      const wasClosed = es?.readyState === EventSource.CLOSED;
      opts.onError?.({
        message: wasClosed
          ? "Stream closed by server"
          : "Stream connection error",
      });
      cleanup();
      scheduleRetry();
    };
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (retryTimer != null) return;
    // D02-http-auth#11: give up after too many opens that never succeeded
    // (a terminal auth failure loops here forever otherwise). Report a
    // distinct terminal error and go to "closed" so the UI stops spinning
    // a "reconnecting" hint and the request storm ends.
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopped = true;
      opts.onError?.({
        message:
          "Live updates stopped after repeated connection failures — reload or sign in again to resume.",
      });
      cleanup();
      setStatus("closed");
      return;
    }
    setStatus("reconnecting");
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void open();
    }, wait);
  };

  // Kick off the first connection attempt synchronously so callers can
  // observe `onStatus("connecting")` in the same tick they call connect.
  void open();

  return (): void => {
    if (stopped) return;
    stopped = true;
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    cleanup();
    setStatus("closed");
  };
}

/* ------------------------------------------------------------------ */
/*  Public connectors                                                  */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to live `CampaignReport` snapshots for one campaign.
 *
 * Backed by `GET /api/v1/campaigns/{id}/events` (Phase 10). The Go handler
 * emits an initial `snapshot` event followed by `delta` events on each tick
 * where any count changed. Both shapes are full `CampaignReport` payloads.
 *
 * Returns a disconnect function — store it on a ref and call from
 * `useEffect` cleanup.
 */
export function connectCampaignEvents(
  campaignId: string | number,
  onSnapshot: (snap: CampaignReport) => void,
  onError?: (err: { message: string; status?: number }) => void,
  onStatus?: (status: SseStatus) => void,
): Disconnect {
  const path = `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/events`;
  const opts: ConnectOptions<CampaignReport> = {
    url: () => buildStreamUrl(path),
    onSnapshot,
    eventNames: ["snapshot", "delta", "message"],
  };
  if (onError) opts.onError = onError;
  if (onStatus) opts.onStatus = onStatus;
  return connect(opts);
}

/**
 * Subscribe to live dashboard stats.
 *
 * Backed by GET /api/v1/dashboard/live. The server emits `event: stats` blocks
 * with the same payload shape as /api/v1/dashboard/stats.
 */
export function connectDashboardLive(
  onSnapshot: (snap: DashboardStatsResponse) => void,
  onError?: (err: { message: string; status?: number }) => void,
  onStatus?: (status: SseStatus) => void,
): Disconnect {
  const opts: ConnectOptions<DashboardStatsResponse> = {
    url: () => buildStreamUrl("/api/v1/dashboard/live"),
    onSnapshot,
    eventNames: ["stats", "snapshot", "delta", "message"],
  };
  if (onError) opts.onError = onError;
  if (onStatus) opts.onStatus = onStatus;
  return connect(opts);
}

/**
 * Whether the browser supports SSE at all. Tauri's webview always does, but
 * this lets us guard the public helpers in unit tests / mock environments.
 */
export function isSseSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.EventSource !== "undefined"
  );
}
