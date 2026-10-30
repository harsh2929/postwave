/**
 * api/eventBusStream.ts — the pure half of the realtime transport.
 *
 * `api/eventBus.ts` owns the parts that need React Native (auth store, the
 * `expo/fetch` streaming client, AbortController wiring). Everything that can
 * be reasoned about without a device lives here so it is unit-testable in the
 * node environment: SSE frame parsing, the stall watchdog predicate, and the
 * reconnect backoff schedule.
 *
 * Three defects this module exists to fix (2026-07 maturity audit):
 *
 *   - NATIVE#9: the reader had no keepalive watchdog. The server emits
 *     `:keepalive` every 30s, but comment lines were dropped before anything
 *     observed them, so an iOS socket torn while suspended left `reader.read()`
 *     awaiting forever with the status stuck on "open". `observedFrame()` now
 *     ticks on EVERY chunk (comments included) and `isStreamStalled()` is the
 *     predicate a timer checks.
 *
 *   - NATIVE-V#6: the backoff was a deterministic 1s/2s/4s/8s ladder, so every
 *     device that rode out an outage or a deploy retried in lockstep against
 *     both `/api/v1/events` and `/api/v1/streams/token`. `jitteredBackoff()`
 *     applies equal jitter (0.5–1.0x) — a floor is kept deliberately, since
 *     full jitter can round down to ~0ms and hot-loop on a hard failure.
 */
import { utf8ByteLength } from "../lib/utf8";

/** Largest single SSE `data:` payload we will parse before dropping it. */
export const MAX_EVENT_BUS_FRAME_CHARS = 128 * 1024;
/** Largest unterminated buffer we retain before assuming a broken stream. */
export const MAX_EVENT_BUS_BUFFER_CHARS = 256 * 1024;

/**
 * How long the reader may go without ANY frame — data or the server's 30s
 * `:keepalive` comment — before we treat the socket as half-open. Two missed
 * heartbeats plus margin; short enough that a pocketed phone reconnects
 * promptly, long enough that a slow radio is never torn down mid-heartbeat.
 */
export const EVENT_BUS_STALL_TIMEOUT_MS = 75_000;
/** How often the watchdog evaluates `isStreamStalled`. */
export const EVENT_BUS_STALL_CHECK_MS = 15_000;

export const EVENT_BUS_INITIAL_BACKOFF_MS = 1_000;
export const EVENT_BUS_MAX_BACKOFF_MS = 30_000;

export interface SseFrame {
  event: string;
  data: string;
}

export interface SseParserOptions {
  onFrame: (frame: SseFrame) => void;
  /** Called when a frame or buffer exceeds its byte budget and is dropped. */
  onOverflow?: (reason: "frame" | "buffer") => void;
  maxFrameChars?: number;
  maxBufferChars?: number;
}

export interface SseParser {
  /** Feed a decoded chunk. Returns the number of complete frames emitted. */
  push(chunk: string): number;
  /** Flush a trailing frame that never received its blank-line terminator. */
  flush(): number;
  /** Bytes currently buffered awaiting a terminator (diagnostics/tests). */
  readonly pending: number;
}

function normalizeSseNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Incremental SSE frame parser. Split out of `connectEventBus` so the CRLF,
 * multi-line `data:`, comment-only, and oversized-payload cases can be driven
 * directly by tests instead of only through a live socket.
 */
export function createSseParser(options: SseParserOptions): SseParser {
  const maxFrameChars = options.maxFrameChars ?? MAX_EVENT_BUS_FRAME_CHARS;
  const maxBufferChars = options.maxBufferChars ?? MAX_EVENT_BUS_BUFFER_CHARS;
  let buffer = "";

  function emit(segment: string): number {
    if (!segment.trim()) return 0;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of segment.split("\n")) {
      // Comment lines (`:keepalive`) carry no payload but DO prove liveness;
      // the caller ticks its watchdog on the chunk, not on the frame.
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    // A comment-only segment (`:keepalive`) proves liveness but carries no
    // frame; the caller ticks its watchdog on the chunk, not on this.
    if (dataLines.length === 0) return 0;
    const data = dataLines.join("\n");
    if (utf8ByteLength(data) > maxFrameChars) {
      options.onOverflow?.("frame");
      return 0;
    }
    options.onFrame({ event, data });
    return 1;
  }

  function drain(): number {
    const segments = buffer.split("\n\n");
    buffer = segments.pop() ?? "";
    let emitted = 0;
    for (const segment of segments) emitted += emit(segment);
    return emitted;
  }

  return {
    push(chunk: string): number {
      buffer = normalizeSseNewlines(buffer + chunk);
      if (utf8ByteLength(buffer) > maxBufferChars) {
        buffer = "";
        options.onOverflow?.("buffer");
        return 0;
      }
      return drain();
    },
    flush(): number {
      if (!buffer.trim()) {
        buffer = "";
        return 0;
      }
      const trailing = buffer;
      buffer = "";
      return emit(normalizeSseNewlines(trailing));
    },
    get pending(): number {
      return buffer.length;
    },
  };
}

/**
 * True when no frame has been observed for `timeoutMs`. A zero/negative
 * `lastFrameAt` means "never saw one", which is also a stall once the window
 * has elapsed since the stream opened — callers seed it with the open time.
 */
export function isStreamStalled(
  lastFrameAt: number,
  now: number,
  timeoutMs: number = EVENT_BUS_STALL_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastFrameAt) || lastFrameAt <= 0) return false;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  return now - lastFrameAt > timeoutMs;
}

export interface StallWatchdog {
  /** Record liveness. Call on EVERY chunk, including keepalive comments. */
  tick(now?: number): void;
  /** Stop observing (stream closed / reconnecting). Idempotent. */
  clear(): void;
}

/**
 * Arm a keepalive watchdog over a stream read loop. Fires `onStall` at most
 * once, then stops — the caller's job on a stall is to abort and reconnect,
 * and a second abort would be noise.
 */
export function createStallWatchdog(options: {
  onStall: () => void;
  timeoutMs?: number;
  checkMs?: number;
  now?: () => number;
}): StallWatchdog {
  const timeoutMs = options.timeoutMs ?? EVENT_BUS_STALL_TIMEOUT_MS;
  const checkMs = Math.min(
    options.checkMs ?? EVENT_BUS_STALL_CHECK_MS,
    Math.max(1_000, timeoutMs),
  );
  const clock = options.now ?? (() => Date.now());
  let lastFrameAt = clock();
  let fired = false;
  let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (fired || !isStreamStalled(lastFrameAt, clock(), timeoutMs)) return;
    fired = true;
    options.onStall();
  }, checkMs);

  return {
    tick(now?: number): void {
      lastFrameAt = now ?? clock();
    },
    clear(): void {
      if (handle === null) return;
      clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * Equal jitter: wait a random point in [base/2, base). Keeps the exponential
 * shape (so a hard outage still backs off) while decorrelating the fleet, and
 * keeps a hard floor so a pathological failure cannot become a hot loop.
 *
 * `random` is injectable so tests can pin the distribution.
 */
export function jitteredBackoff(
  baseMs: number,
  random: () => number = Math.random,
): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  if (base === 0) return 0;
  const roll = random();
  const factor = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5;
  return Math.round(base * (0.5 + factor * 0.5));
}

/** Next backoff step, clamped to the ceiling. */
export function nextBackoff(
  currentMs: number,
  maxMs: number = EVENT_BUS_MAX_BACKOFF_MS,
): number {
  const current =
    Number.isFinite(currentMs) && currentMs > 0
      ? currentMs
      : EVENT_BUS_INITIAL_BACKOFF_MS;
  return Math.min(current * 2, maxMs);
}

/**
 * How long a socket must survive before an immediate close counts as a
 * HEALTHY connection rather than a flap. Below this — and with no data seen —
 * the backoff must keep growing, otherwise a server that accepts and instantly
 * drops the connection produces an unthrottled reconnect loop.
 */
export const MIN_HEALTHY_OPEN_MS = 5_000;

/**
 * Whether a response's `Content-Type` actually declares an SSE stream.
 *
 * Asking for `Accept: text/event-stream` does not make the answer one. A
 * buffering proxy, a gateway error page, or a server on the other side of a
 * version skew can all reply 200 with a JSON document. Read as a stream that
 * body arrives as one chunk and then ends immediately, which is a socket that
 * opened, "delivered data", and closed — indistinguishable, to the old rule
 * below, from a healthy stream. See `shouldResetBackoff` for what that cost.
 *
 * Matching is on the media type alone: it is case-insensitive per RFC 9110,
 * parameters are legal and common (`text/event-stream; charset=utf-8`), and a
 * missing header is NOT a stream — HTTP's default for an undeclared body is
 * `application/octet-stream`, and every SSE route this app opens sets the
 * header explicitly.
 */
export function isEventStreamContentType(
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "text/event-stream";
}

/**
 * Whether a stream that just ended earned a backoff reset. Extracted from
 * `connectEventBus` because getting this wrong is invisible in a screenshot
 * and expensive on a fleet: reset too eagerly and every device hammers a
 * failing server at 1s forever.
 *
 * That is not hypothetical — it was measured. An idle simulator issued ~215
 * requests/minute (72 stream-token mints, 72 opens, 71 replays in 60s) against
 * an endpoint answering 200 with a JSON body: one chunk set `sawData`, this
 * function returned true on the first line, `MIN_HEALTHY_OPEN_MS` never got a
 * vote, and the next attempt followed ~1s later, forever. So bytes are only
 * evidence of health when they came off a connection that WAS a stream; the
 * duration floor is the fallback for a genuine stream that stayed silent.
 */
export function shouldResetBackoff(input: {
  /** At least one chunk arrived (a keepalive comment counts — it is a chunk). */
  sawData: boolean;
  /**
   * The response declared `text/event-stream`. Required rather than optional:
   * an omitted flag defaulting to "yes" would silently reinstate the storm,
   * and every caller already knows the answer — it is the same header that
   * decided whether to read the body at all.
   */
  wasEventStream: boolean;
  openedAt: number;
  now: number;
  minHealthyOpenMs?: number;
}): boolean {
  if (input.sawData && input.wasEventStream) return true;
  const floor = input.minHealthyOpenMs ?? MIN_HEALTHY_OPEN_MS;
  if (!Number.isFinite(input.openedAt) || !Number.isFinite(input.now)) {
    return false;
  }
  return input.now - input.openedAt >= floor;
}

/**
 * The status to publish as a connection attempt begins. "connecting" is only
 * honest on the FIRST attempt of a session; every later attempt is a
 * reconnect, and the offline/stale banners branch on the difference.
 */
export function initialOpenStatus(input: {
  /** A socket from a previous attempt is still being torn down. */
  hasPriorSocket: boolean;
  backoffMs: number;
}): "connecting" | "reconnecting" {
  return !input.hasPriorSocket && input.backoffMs === EVENT_BUS_INITIAL_BACKOFF_MS
    ? "connecting"
    : "reconnecting";
}

/** The minimum shape `parseEventBusFrame` guarantees to its caller. */
export interface EventBusFramePayload {
  topic: string;
  [key: string]: unknown;
}

export type EventBusFrameResult =
  | { ok: true; event: EventBusFramePayload }
  /** Blank `data:` — a keepalive artefact, not an error worth logging. */
  | { ok: false; reason: "empty" }
  /** Not JSON at all. Worth a warning: the wire contract is broken. */
  | { ok: false; reason: "malformed" }
  /** JSON, but carries no topic — unroutable, and silently dropping it is right. */
  | { ok: false; reason: "untopiced" };

/**
 * Decode one SSE `data:` payload into a routable event.
 *
 * The three rejection reasons are distinct on purpose: only `malformed` means
 * the server sent something it should not have, and only that one deserves a
 * console warning. Collapsing them (the previous inline `try/catch`) made an
 * ordinary keepalive indistinguishable from a protocol break in the logs.
 */
export function parseEventBusFrame(data: string): EventBusFrameResult {
  if (!data) return { ok: false, reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "untopiced" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.topic !== "string" || !candidate.topic) {
    return { ok: false, reason: "untopiced" };
  }
  return { ok: true, event: candidate as EventBusFramePayload };
}

/** Largest JSON body the stream-token mint may return before we give up. */
export const MAX_STREAM_TOKEN_RESPONSE_BYTES = 64 * 1024;

export class EventBusBodyTooLargeError extends Error {
  constructor() {
    super("Response body too large");
    this.name = "EventBusBodyTooLargeError";
  }
}

/**
 * Structural shape of the responses `readBoundedResponseText` accepts. Typed
 * structurally rather than as `Response` so this module stays free of any
 * React Native import and the no-`body` path (which a real `fetch` Response
 * never takes in node) is reachable from a test.
 */
export interface BoundedBodyResponse {
  headers: { get(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}

/**
 * Read a response body with a hard byte ceiling, aborting mid-stream rather
 * than after the fact.
 *
 * This guards the stream-token mint, which is called on EVERY reconnect. A
 * captive portal or a compromised proxy answering `/api/v1/streams/token` with
 * an endless body would otherwise grow the JS heap until the app is killed —
 * and the reconnect loop would do it again on the next attempt.
 */
export async function readBoundedResponseText(
  res: BoundedBodyResponse,
  maxBytes: number = MAX_STREAM_TOKEN_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EventBusBodyTooLargeError();
  }
  if (!res.body) {
    const text = await res.text();
    if (utf8ByteLength(text) > maxBytes) throw new EventBusBodyTooLargeError();
    return text;
  }

  const reader = (
    res.body as ReadableStream<Uint8Array>
  ).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new EventBusBodyTooLargeError();
    }
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
