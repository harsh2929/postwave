// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared httpFetch core for the Next.js app.
 *
 * Owns retry policy (decorrelated jitter, base 200ms, cap 10s), per-call
 * timeout, signal chaining, and UUIDv7 idempotency-key minting for
 * mutations. Consumed by the api.ts request wrapper so call sites keep
 * throwing ApiError on failure exactly as before.
 */

const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
// Permanent client errors — retrying them just re-sends a doomed request.
// Exported so the React Query mutation-retry policy (outbox.ts) shares the
// exact same definition of "do not retry" as this fetch layer.
export const NON_RETRYABLE_STATUSES = new Set([
  400, 401, 403, 404, 409, 412, 422,
]);

export interface HttpFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  maxAttempts?: number;
  retryOnTransport?: () => boolean;
}

export interface HttpFetchResult {
  res?: Response;
  err?: unknown;
  exhausted: boolean;
  attempts: number;
  timedOut: boolean;
}

export function nextBackoffMs(prevMs: number): number {
  const lower = BASE_BACKOFF_MS;
  const upper = Math.min(MAX_BACKOFF_MS, Math.max(prevMs, BASE_BACKOFF_MS) * 3);
  const span = Math.max(0, upper - lower);
  return Math.floor(lower + Math.random() * span);
}

export function newUUIDv7(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = new Array(16);
  for (let i = 0; i < 16; i += 1) hex[i] = bytes[i].toString(16).padStart(2, "0");
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  // Number("") and Number("   ") are both 0, not NaN. Without the trim guard a
  // whitespace-only header reads as "retry after 0 seconds" and turns a
  // back-off signal into an immediate re-send.
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return seconds;
  }
  return undefined;
}

/**
 * A retry exists because the previous answer was unacceptable, so in a browser
 * it must reach the network. Given any cache mode that consults the HTTP
 * cache, a retry of a read could be answered with the very response it is
 * retrying — a stored 503 replayed three times in a few milliseconds without
 * the request leaving the browser. The first attempt keeps the caller's mode,
 * and server-side requests are left alone: pairing a caller's
 * `next.revalidate` with `no-store` hands Next two conflicting directives.
 */
function retryCacheMode(
  isSafe: boolean,
  attempt: number,
): { cache?: RequestCache } {
  return attempt > 1 && isSafe && typeof window !== "undefined"
    ? { cache: "no-store" }
    : {};
}

function isRetryableStatus(status: number): boolean {
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * True when a 503 says, in the API's error envelope, that asking again cannot
 * help: `{"error":{"code":"…","retryable":false}}` is how the server reports a
 * feature that is not enabled or a service that is not deployed. Re-sending
 * would only delay that answer by the whole backoff. Reads a clone, so the
 * caller still gets the body.
 */
async function declaresNotRetryable(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  if (!/json/i.test(res.headers.get("content-type") ?? "")) return false;
  try {
    const body = (await res.clone().json()) as {
      error?: { retryable?: unknown };
    } | null;
    return body?.error?.retryable === false;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function httpFetch(
  url: string,
  init: RequestInit,
  opts: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const method = (init.method ?? "GET").toUpperCase();
  const isSafe = method === "GET" || method === "HEAD";
  const hasIdem =
    init.headers !== undefined &&
    new Headers(init.headers as HeadersInit).has("Idempotency-Key");
  const transportRetry = opts.retryOnTransport ?? (() => false);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const callerSignal = opts.signal ?? init.signal ?? null;
  const timeoutMs = opts.timeoutMs ?? 0;

  let attempts = 0;
  let prevBackoff = BASE_BACKOFF_MS;
  let lastTimedOut = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const ctrl = new AbortController();
    let timedOutThisAttempt = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOutThisAttempt = true;
        ctrl.abort();
      }, timeoutMs);
    }
    const onCallerAbort = (): void => ctrl.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        ctrl.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    try {
      const res = await fetch(url, {
        ...init,
        ...retryCacheMode(isSafe, attempt),
        signal: ctrl.signal,
      });
      const canReplayStatusFailure = isSafe || hasIdem;
      if (
        res.ok ||
        !isRetryableStatus(res.status) ||
        !canReplayStatusFailure ||
        attempt === maxAttempts ||
        (await declaresNotRetryable(res))
      ) {
        return {
          res,
          exhausted: attempt === maxAttempts && !res.ok,
          attempts,
          timedOut: false,
        };
      }
      const retryAfter = parseRetryAfterHeader(res.headers.get("retry-after"));
      const waitMs =
        retryAfter !== undefined
          ? Math.min(MAX_BACKOFF_MS, Math.max(0, retryAfter * 1000))
          : nextBackoffMs(prevBackoff);
      prevBackoff = waitMs;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (callerSignal?.aborted) {
        return {
          err: new DOMException("Aborted", "AbortError"),
          exhausted: true,
          attempts,
          timedOut: false,
        };
      }
      try {
        await sleep(waitMs, callerSignal ?? new AbortController().signal);
      } catch (sleepErr) {
        return { err: sleepErr, exhausted: true, attempts, timedOut: false };
      }
      continue;
    } catch (err) {
      lastTimedOut = timedOutThisAttempt;
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && callerSignal?.aborted) {
        return { err, exhausted: true, attempts, timedOut: false };
      }
      // A rejected fetch cannot tell us whether bytes reached the server, so a
      // non-idempotent mutation is never replayed on transport failure unless
      // the caller opts in via retryOnTransport(). (An earlier `!sentFlag`
      // term here was unreachable — it was assigned true before the await —
      // and implied a pre-send check the Fetch API does not expose.)
      const retryable =
        attempt < maxAttempts && (isSafe || hasIdem || transportRetry());
      if (!retryable) {
        return { err, exhausted: true, attempts, timedOut: lastTimedOut };
      }
      const waitMs = nextBackoffMs(prevBackoff);
      prevBackoff = waitMs;
      try {
        await sleep(waitMs, callerSignal ?? new AbortController().signal);
      } catch (sleepErr) {
        return { err: sleepErr, exhausted: true, attempts, timedOut: false };
      }
      continue;
    } finally {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
  return {
    err: new Error("httpFetch: exhausted without result"),
    exhausted: true,
    attempts,
    timedOut: lastTimedOut,
  };
}

export function isMutationMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}
