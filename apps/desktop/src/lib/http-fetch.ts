/**
 * Shared httpFetch core.
 *
 * Owns retry policy (decorrelated jitter, base 200ms, cap 10s), per-call
 * timeout, signal chaining, and UUIDv7 idempotency-key minting for
 * mutations. Used by the api-client request<T>() wrapper so call sites
 * keep the existing ApiResult<T> shape.
 */

import { tauriApi } from "./tauri";

const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 409, 412, 422]);

export interface HttpFetchOptions {
  /** Per-call timeout override (replaces the legacy 5s hard cap). */
  timeoutMs?: number;
  /** Caller-supplied signal — aborts cascade into the internal controller. */
  signal?: AbortSignal | null;
  /** Maximum attempts including the first try. Default 3. */
  maxAttempts?: number;
  /**
   * Predicate gating non-GET retries on transport errors when the request
   * never reached the wire (DNS/connect fail). GETs/HEADs always retry.
   * Non-GETs only retry when this returns true OR an Idempotency-Key was
   * minted (which is now always the case for mutations).
   */
  retryOnTransport?: () => boolean;
}

export interface HttpFetchResult {
  res?: Response;
  err?: unknown;
  /** True only if the final attempt errored after exhausting retries. */
  exhausted: boolean;
  /** Number of attempts actually performed (>= 1). */
  attempts: number;
}

/**
 * Decorrelated jitter: next = min(cap, random_between(base, prev*3))
 * AWS-Architecture-pattern backoff that avoids thundering herds while
 * staying responsive on quick blips.
 */
export function nextBackoffMs(prevMs: number): number {
  const lower = BASE_BACKOFF_MS;
  const upper = Math.min(MAX_BACKOFF_MS, Math.max(prevMs, BASE_BACKOFF_MS) * 3);
  const span = Math.max(0, upper - lower);
  return Math.floor(lower + Math.random() * span);
}

/** UUIDv7 generator with no extra deps. Falls back to v4 if crypto missing. */
export function newUUIDv7(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 48-bit big-endian unix-ms timestamp
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;
  // Version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // RFC 4122 variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = new Array(16);
  for (let i = 0; i < 16; i += 1)
    hex[i] = bytes[i].toString(16).padStart(2, "0");
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

/** Cross-realm Retry-After parser (numeric seconds or HTTP-date). */
export function parseRetryAfterHeader(
  value: string | null,
): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return seconds;
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
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

/**
 * Core HTTP fetch with retries, jittered backoff, per-call timeout, and
 * signal chaining. Returns whichever attempt was final (success or last
 * error). Callers post-process the result to fit their result shape.
 */
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const ctrl = new AbortController();
    let sentFlag = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
    }
    const onCallerAbort = (): void => ctrl.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        ctrl.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    // Mark sent once fetch resolves OR begins streaming a response. We
    // approximate by flipping the flag right before awaiting fetch; any
    // failure after this point counts as "init sent" for the retry gate.
    try {
      sentFlag = true;
      const requestInit = { ...init, signal: ctrl.signal };
      const res =
        (await tauriApi.fetchWithApiBroker(url, {
          ...requestInit,
          __postwaveTimeoutMs: timeoutMs,
        } as RequestInit)) ??
        (await tauriApi.fetchWithSessionBroker(url, {
          ...requestInit,
          __postwaveTimeoutMs: timeoutMs,
        } as RequestInit)) ??
        (await fetch(url, requestInit));
      if (res.ok || !isRetryableStatus(res.status) || attempt === maxAttempts) {
        return { res, exhausted: attempt === maxAttempts && !res.ok, attempts };
      }
      // Honor server Retry-After when present; else jitter.
      const retryAfter = parseRetryAfterHeader(res.headers.get("retry-after"));
      const waitMs =
        retryAfter !== undefined
          ? Math.min(MAX_BACKOFF_MS, Math.max(0, retryAfter * 1000))
          : nextBackoffMs(prevBackoff);
      prevBackoff = waitMs;
      // Drain the body so the underlying connection can be reused.
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
        };
      }
      try {
        await sleep(waitMs, callerSignal ?? new AbortController().signal);
      } catch (sleepErr) {
        return { err: sleepErr, exhausted: true, attempts };
      }
      continue;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      // Caller-driven abort is terminal. Timeouts (our internal abort)
      // are retryable if the request never sent or the method is safe.
      if (aborted && callerSignal?.aborted) {
        return { err, exhausted: true, attempts };
      }
      const retryable =
        attempt < maxAttempts &&
        (isSafe || hasIdem || !sentFlag || transportRetry());
      if (!retryable) {
        return { err, exhausted: true, attempts };
      }
      const waitMs = nextBackoffMs(prevBackoff);
      prevBackoff = waitMs;
      try {
        await sleep(waitMs, callerSignal ?? new AbortController().signal);
      } catch (sleepErr) {
        return { err: sleepErr, exhausted: true, attempts };
      }
      continue;
    } finally {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
  // Should be unreachable — loop always returns inside.
  return {
    err: new Error("httpFetch: exhausted without result"),
    exhausted: true,
    attempts,
  };
}

/** Convenience: mutation methods that need an Idempotency-Key minted. */
export function isMutationMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}
