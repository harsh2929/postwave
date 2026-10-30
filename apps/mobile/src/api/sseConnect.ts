/**
 * api/sseConnect.ts — ONE reconnecting SSE reader, for every SSE route.
 *
 * ── THE CLAIM THIS MODULE RETIRES ──────────────────────────────────────────
 * Five comments across this app said, in one form or another, that "React
 * Native's fetch has no streaming body, so the app cannot consume SSE at all".
 * Three live-tail surfaces were switched off on that basis
 * (`/api/v1/audit/stream`, `/api/v1/track/stream`,
 * `/api/v1/mcp/executions/stream`) and the live-send strip polls a report every
 * ten seconds beside an SSE endpoint it never opens.
 *
 * The claim is HALF true, and the half that is false is the conclusion. React
 * Native's GLOBAL `fetch` is XHR-backed and really does hand back no
 * `ReadableStream`. But this app has not used the global fetch for streams
 * since the event bus was written: `expo/fetch` is a separate networking stack
 * whose `response.body` IS a real `ReadableStream`, and `connectEventBus` has
 * been calling `.getReader()` on it, in production, on every launch — held open
 * by `lib/eventCacheSync`. `api/aiGenerate.ts` is a second independent reader.
 * So the premise is about a fetch this code does not call, and the conclusion
 * ("can never be the mobile answer") was false in the same binary that stated
 * it.
 *
 * ── WHAT IS ACTUALLY EXPENSIVE ─────────────────────────────────────────────
 * Not the capability — the CONNECTION. Each open stream is a socket a phone
 * radio must keep warm, plus a stream-token mint on every reconnect. That is
 * the real reason a surface should think before opening one, and it is a
 * per-surface product judgement rather than a platform limit. Where a poll is
 * already correct and cheap, the honest move is to LAYER a stream on top with
 * the poll intact as the fallback — never to replace a working poll with an
 * unproven stream.
 *
 * ── WHY THIS IS SHARED RATHER THAN COPIED ──────────────────────────────────
 * The hard parts are not the read loop. They are: the single-attempt latch
 * (two overlapping opens mint two tokens and the loser 401s), releasing that
 * latch on the pre-`try` offline return (leaving it set latches the connection
 * shut for the life of the process), the keepalive watchdog (iOS tears a
 * suspended socket without waking the awaiting reader), and equal-jitter
 * backoff so a deploy does not produce a synchronised reconnect wave. Every one
 * of those was learned once, in the event bus, at the cost of a real incident.
 * A second copy would relearn them.
 *
 * The pure decision functions still live in ./eventBusStream, which is
 * import-free and node-tested; this module is the I/O around them, and the
 * per-attempt pieces that need no closure state (the fetch init, dropping a
 * body we decline to read, the gap replay) are in ./sseAttempt.
 */
import { isProbablyOnline } from "@/lib/connectivity";

import { interceptMfaRequiredResponse } from "./auth";
import {
  createSseParser,
  createStallWatchdog,
  EVENT_BUS_INITIAL_BACKOFF_MS,
  EVENT_BUS_MAX_BACKOFF_MS,
  EVENT_BUS_STALL_TIMEOUT_MS,
  initialOpenStatus,
  isEventStreamContentType,
  jitteredBackoff,
  nextBackoff,
  shouldResetBackoff,
  type StallWatchdog,
} from "./eventBusStream";
import {
  cancelUnreadBody,
  runGapReplay,
  streamFetchInit,
  type SseRequest,
} from "./sseAttempt";
import { sseOpenFailureAction } from "./sseAuthPolicy";
import { fetch as expoFetch } from "expo/fetch";

/** One decoded SSE frame: the `event:` name and the accumulated `data:`. */
export interface SseFrame {
  event: string;
  data: string;
}

export type SseStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unsupported"
  | "closed";

export type SseDisconnect = () => void;

// Re-exported so callers that build a request (e.g. ./streamCredentials) still
// import the shape from the module they connect with.
export type { SseRequest };

export interface ConnectSseOptions {
  /**
   * Resolve the URL + credentials for one attempt. Called on EVERY attempt,
   * not once, because short-lived stream tokens expire (2 minutes) and a
   * reconnect after a five-minute server close needs a fresh one.
   */
  buildRequest: () => Promise<SseRequest>;
  /** Every decoded frame, in order. */
  onFrame: (frame: SseFrame) => void;
  onStatus?: (status: SseStatus) => void;
  /**
   * Gap recovery. Awaited after the socket opens and BEFORE live frames are
   * dispatched, so events published while the stream was down are replayed in
   * order. Failures here must not break the tail: a rejection is logged and
   * swallowed.
   */
  onBeforeTail?: () => Promise<void>;
  /** Called once per watchdog-forced reconnect, before the abort. */
  onStall?: () => void;
  /** Watchdog window; exposed for tests. */
  stallTimeoutMs?: number;
  /** Injectable jitter source; exposed for tests. */
  random?: () => number;
  /** Short name used in operator warnings, e.g. "event-bus". */
  label: string;
}

/**
 * Open a reconnecting SSE stream. Returns a disconnect function that aborts
 * the in-flight read and stops further attempts.
 */
export function connectSse(options: ConnectSseOptions): SseDisconnect {
  const { label } = options;
  let stopped = false;
  let backoffMs = EVENT_BUS_INITIAL_BACKOFF_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  const stallTimeoutMs = options.stallTimeoutMs ?? EVENT_BUS_STALL_TIMEOUT_MS;

  const setStatus = (s: SseStatus): void => {
    options.onStatus?.(s);
  };

  const newParser = () =>
    createSseParser({
      onFrame: (frame) => {
        options.onFrame(frame);
      },
      onOverflow: (reason) => {
        console.warn(
          reason === "frame"
            ? `[postwave-mobile] ${label} payload too large; dropped`
            : `[postwave-mobile] ${label} buffer too large; dropped`,
        );
      },
    });

  // ONE connection attempt at a time.
  //
  // `open()` awaits a credential build before it fetches, and that await is a
  // window in which a second `open()` can start. Measured on a simulator: two
  // token mints 104ms apart at launch, because the shell effect re-ran as
  // `hydrated` and `canUseOnlineServices` both flipped during startup.
  //
  // The loser of that race is what produced a 401 beside every healthy stream
  // -- 14 x 200 against 7 x 401 in one session -- and, because a failed connect
  // sets the status, the header chip read RECONNECTING while a stream was held
  // open the whole time. (Stream tokens are freely reusable inside their
  // 2-minute TTL and reject only after it, both confirmed against the running
  // server, so the 401 is always an EXPIRED token from a connect that lost.)
  let opening = false;

  // Consecutive 401s. Reset by ANY other outcome — a successful open, or a
  // failure with a different status — because the budget in ./sseAuthPolicy is
  // about a credential being refused over and over, not about a flaky network
  // that happened to include one 401.
  let unauthorizedAttempts = 0;

  const open = async (): Promise<void> => {
    if (stopped || opening) return;
    opening = true;
    if (!isProbablyOnline()) {
      // RELEASE THE LATCH BEFORE RETURNING. This return is above the `try`
      // whose `finally` clears `opening`, so leaving it set here latches the
      // connection shut permanently: every scheduled retry then dies on
      // `if (stopped || opening) return` and realtime never recovers for the
      // life of the process. Starting the app with no connectivity was enough
      // to trigger it. (`eventBusReconnect.test.ts`.)
      opening = false;
      setStatus("reconnecting");
      scheduleRetry();
      return;
    }
    setStatus(initialOpenStatus({ hasPriorSocket: abort != null, backoffMs }));
    const requestAbort = new AbortController();
    abort = requestAbort;
    const request = await options.buildRequest();
    if (stopped) {
      opening = false;
      if (abort === requestAbort) abort = null;
      return;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let watchdog: StallWatchdog | null = null;
    let stalled = false;
    try {
      const res = await interceptMfaRequiredResponse(
        await expoFetch(
          request.url,
          streamFetchInit(request, requestAbort.signal),
        ),
        request.origin ?? new URL(request.url).origin,
      );
      if (!res.ok) {
        unauthorizedAttempts =
          res.status === 401 ? unauthorizedAttempts + 1 : 0;
        console.warn(
          `[postwave-mobile] ${label} open failed:`,
          res.status,
          res.statusText,
        );
        // AN AUTHORIZATION REFUSAL IS NOT A RETRYABLE CONDITION.
        //
        // Every attempt re-runs `buildRequest`, which mints a fresh stream
        // token. Backing off on a 403 therefore does not reduce the load, it
        // just paces it: one token mint and one refusal every 30s for as long
        // as the surface is mounted, on a route whose answer cannot change
        // without a new session. `./sseAuthPolicy` explains why 401 keeps a
        // bounded retry and 403 does not.
        //
        // Stopping is safe because no SSE surface in this app is the only
        // path to its data — each one layers on a poll that is left running.
        if (
          sseOpenFailureAction({ status: res.status, unauthorizedAttempts }) ===
          "stop"
        ) {
          console.warn(
            `[postwave-mobile] ${label} refused (${res.status}); not retrying`,
          );
          stopped = true;
          setStatus("closed");
          return;
        }
        scheduleRetry();
        return;
      }
      unauthorizedAttempts = 0;
      // A 200 IS NOT PROOF OF A STREAM.
      //
      // `Accept: text/event-stream` is a request, not a guarantee. A buffering
      // proxy, a gateway error page, or a server on the far side of a version
      // skew answers 200 with a JSON document, and reading THAT as a stream is
      // how an idle app reached ~215 requests/minute: the body arrived as one
      // chunk (so the read loop saw "data"), then ended (so the loop finished),
      // then reconnected ~1s later because the ex-`sawData` rule called it
      // healthy. Every cycle also re-minted a stream token and re-ran the gap
      // replay, which is why the storm was three requests wide.
      //
      // A response that is not a stream is a FAILED ATTEMPT: no frames, no
      // "open" status, and `scheduleRetry` grows the backoff to the 30s ceiling
      // exactly as it does for a 503.
      const wasEventStream = isEventStreamContentType(
        res.headers?.get("content-type"),
      );
      if (!wasEventStream) {
        console.warn(
          `[postwave-mobile] ${label} answered`,
          res.headers?.get("content-type") ?? "no content-type",
          "not text/event-stream; treating as a failed attempt",
        );
        // Release the socket we are deliberately not reading. Left dangling it
        // would hold a connection open per failed attempt — on the exact code
        // path whose whole purpose is to stop burning connections.
        await cancelUnreadBody(res.body);
        scheduleRetry();
        return;
      }
      if (!res.body) {
        console.warn(
          `[postwave-mobile] ${label} streaming is unsupported by this runtime`,
        );
        setStatus("unsupported");
        return;
      }
      const openedAt = Date.now();
      let sawData = false;
      setStatus("open");
      // Recover anything published while the stream was down, before the
      // first live frame is dispatched, so replayed and live events stay in
      // order. Never fatal to the tail.
      await runGapReplay(options.onBeforeTail, label);
      reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder("utf-8");
      const parser = newParser();
      watchdog = createStallWatchdog({
        timeoutMs: stallTimeoutMs,
        onStall: () => {
          // The socket has gone silent through two keepalives: the OS tore it
          // down without waking the awaiting read. Abort so the catch below
          // reconnects instead of waiting forever.
          console.warn(`[postwave-mobile] ${label} stalled; forcing reconnect`);
          stalled = true;
          // Report before aborting: a throwing observer must not be able to
          // skip the abort and leave the read hanging forever.
          try {
            options.onStall?.();
          } catch {
            /* ignore */
          }
          try {
            requestAbort.abort();
          } catch {
            /* ignore */
          }
        },
      });
      while (!stopped) {
        const { done, value } = await reader.read();
        // Every chunk proves liveness — including a comment-only keepalive,
        // which carries no frame at all.
        watchdog.tick();
        if (done) break;
        if (value) {
          sawData = true;
          parser.push(decoder.decode(value, { stream: true }));
        }
      }
      // `wasEventStream` is true on this line — the guard above returns when it
      // is not — and it is passed as the variable rather than a literal on
      // purpose: the two halves of the fix are independent. If a later change
      // ever softens the guard (tolerating a stripped header, say), the reset
      // rule still refuses to call a non-stream's bytes evidence of health.
      if (
        shouldResetBackoff({
          sawData,
          wasEventStream,
          openedAt,
          now: Date.now(),
        })
      ) {
        backoffMs = EVENT_BUS_INITIAL_BACKOFF_MS;
      }
      parser.push(decoder.decode());
      parser.flush();
      if (!stopped) scheduleRetry();
    } catch (err) {
      if (stopped) return;
      if (stalled) {
        // Expected: our own watchdog aborted the read.
        scheduleRetry();
        return;
      }
      console.warn(`[postwave-mobile] ${label} stream errored:`, err);
      scheduleRetry();
    } finally {
      // Released here, not at the fetch: the whole read loop is one attempt,
      // and a retry is scheduled from inside this block.
      opening = false;
      watchdog?.clear();
      watchdog = null;
      try {
        await reader?.cancel();
      } catch {
        /* ignore */
      }
      if (abort === requestAbort) {
        abort = null;
      }
    }
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (timer !== null) return;
    setStatus("reconnecting");
    // Equal jitter (0.5–1.0x) so a deploy or brief outage does not produce a
    // synchronised reconnect wave against the route AND the stream-token mint
    // at the same instants.
    const wait = jitteredBackoff(backoffMs, options.random);
    backoffMs = nextBackoff(backoffMs, EVENT_BUS_MAX_BACKOFF_MS);
    timer = setTimeout(() => {
      timer = null;
      void open();
    }, wait);
  };

  void open();

  return (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (abort) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
      abort = null;
    }
    setStatus("closed");
  };
}
