/**
 * api/sseAttempt.ts — the pieces of ONE connection attempt.
 *
 * `connectSse` owns the lifecycle across attempts: the single-attempt latch,
 * the backoff ladder, the stall watchdog, the read loop. These three helpers
 * are what a single attempt needs on either side of that loop — how it asks,
 * how it lets go of an answer it will not read, and how it recovers the gap
 * before the tail starts. They live here rather than beside it because
 * `sseConnect.ts` is at its 450-line ceiling and `open()` was at its complexity
 * ceiling, and because none of the three needs the closure's state.
 */
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";

/** Where to connect, and as whom, for ONE attempt. */
export interface SseRequest {
  /** Absolute URL, credentials already applied (e.g. a `stream_token` query). */
  url: string;
  /** `Authorization: Bearer` value, or null to fall back to cookies. */
  bearer?: string | null;
  /** `X-Tenant-Slug` value, or null to omit. */
  tenantSlug?: string | null;
  /**
   * Origin used to resolve an MFA-required interception. Falls back to the
   * URL's own origin, which throws on a bare path — so a caller that may hand
   * back a bare path (no configured base URL) should set this.
   */
  origin?: string | null;
}

/** The fetch init `connectSse` uses for one attempt. */
export interface SseFetchInit {
  method: "GET";
  headers: Record<string, string>;
  credentials?: "include";
  signal: AbortSignal;
}

/**
 * Credentials and headers for ONE attempt.
 *
 * Bearer and cookies are exclusive on purpose: sending `credentials:
 * "include"` alongside an `Authorization` header lets the server choose between
 * two identities that need not be the same one (an API-key session and a
 * signed-in user), and which it picks is not ours to guess.
 *
 * `Accept: text/event-stream` is a request, not a guarantee — see the
 * content-type gate in `connectSse` for what happens when the answer is not one.
 */
export function streamFetchInit(
  request: SseRequest,
  signal: AbortSignal,
): SseFetchInit {
  const bearer = request.bearer ?? null;
  return {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...NATIVE_CLIENT_HEADERS,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(request.tenantSlug ? { "X-Tenant-Slug": request.tenantSlug } : {}),
    },
    ...(bearer ? {} : { credentials: "include" as const }),
    signal,
  };
}

/**
 * Drop a body we decided not to read, so a declined answer does not hold a
 * connection open. Never throws: a runtime whose response body is not
 * cancellable must not turn a handled non-stream answer into an unhandled
 * rejection, which would take the retry down with it.
 */
export async function cancelUnreadBody(body: unknown): Promise<void> {
  try {
    await (body as ReadableStream<Uint8Array> | null | undefined)?.cancel();
  } catch {
    /* ignore */
  }
}

/** Gap recovery must never be able to break the live tail. */
export async function runGapReplay(
  onBeforeTail: (() => Promise<void>) | undefined,
  label: string,
): Promise<void> {
  if (!onBeforeTail) return;
  try {
    await onBeforeTail();
  } catch (err) {
    console.warn(`[postwave-mobile] ${label} gap replay failed:`, err);
  }
}
