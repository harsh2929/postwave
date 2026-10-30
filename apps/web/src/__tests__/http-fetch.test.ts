// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared retry/backoff core had no direct coverage. Every authenticated
// request in the app funnels through httpFetch, so the replay-safety rules
// (never re-send a non-idempotent mutation) and the Retry-After parsing are
// the highest-consequence pure logic in src/lib.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NON_RETRYABLE_STATUSES,
  httpFetch,
  isMutationMethod,
  newUUIDv7,
  nextBackoffMs,
  parseRetryAfterHeader,
} from "@/lib/http-fetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Queue of responses/errors consumed one per fetch call. */
function stubFetch(steps: Array<Response | Error>) {
  const calls: RequestInit[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    // Real fetch rejects before touching the network when handed an
    // already-aborted signal; a stub that ignores it would let an abort test
    // pass for the wrong reason.
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const step = steps.shift();
    if (step === undefined) throw new Error("stubFetch: no step queued");
    if (step instanceof Error) throw step;
    return step;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const ok = () => new Response("{}", { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status: code, headers });

describe("parseRetryAfterHeader", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterHeader("30")).toBe(30);
    expect(parseRetryAfterHeader("0")).toBe(0);
  });

  it("treats a whitespace-only header as absent rather than zero seconds", () => {
    // Number("   ") === 0, which would silently convert a back-off signal
    // into an immediate re-send.
    expect(parseRetryAfterHeader("   ")).toBeUndefined();
    expect(parseRetryAfterHeader("\t\n")).toBeUndefined();
  });

  it("rejects absent, negative and unparseable values", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("-5")).toBeUndefined();
    expect(parseRetryAfterHeader("soon")).toBeUndefined();
  });

  it("reads an HTTP-date and returns whole seconds into the future", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const secs = parseRetryAfterHeader(future);
    expect(secs).toBeGreaterThan(40);
    expect(secs).toBeLessThanOrEqual(46);
  });

  it("ignores an HTTP-date already in the past", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBeUndefined();
  });
});

describe("nextBackoffMs", () => {
  it("never returns less than the 200ms floor", () => {
    for (const prev of [0, -1000, 1, 200, 5_000]) {
      expect(nextBackoffMs(prev)).toBeGreaterThanOrEqual(200);
    }
  });

  it("caps at 10s no matter how large the previous delay was", () => {
    for (const prev of [10_000, 1_000_000]) {
      expect(nextBackoffMs(prev)).toBeLessThanOrEqual(10_000);
    }
  });

  it("triples the ceiling each step (decorrelated jitter)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(nextBackoffMs(200)).toBeLessThanOrEqual(600);
    expect(nextBackoffMs(600)).toBeLessThanOrEqual(1800);
  });
});

describe("isMutationMethod", () => {
  it("classifies by method regardless of case", () => {
    for (const m of ["post", "PATCH", "Put", "delete"])
      expect(isMutationMethod(m)).toBe(true);
    for (const m of ["GET", "head", "OPTIONS"])
      expect(isMutationMethod(m)).toBe(false);
  });
});

describe("newUUIDv7", () => {
  it("emits a canonical v7 UUID with the correct variant nibble", () => {
    const id = newUUIDv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("encodes a big-endian millisecond timestamp so ids sort by time", () => {
    // Pin the clock: newUUIDv7 samples Date.now() internally, so reading it
    // again in the test races the millisecond boundary.
    const fixed = 1_767_225_600_123;
    vi.spyOn(Date, "now").mockReturnValue(fixed);
    expect(newUUIDv7().replace(/-/g, "").slice(0, 12)).toBe(
      fixed.toString(16).padStart(12, "0"),
    );
  });

  it("orders lexicographically by generation time", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000_000);
    const earlier = newUUIDv7();
    now.mockReturnValue(1_000_000_001_000);
    const later = newUUIDv7();
    expect(earlier < later).toBe(true);
  });

  it("does not collide across a tight loop", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newUUIDv7()));
    expect(seen.size).toBe(500);
  });
});

describe("httpFetch replay safety", () => {
  it("retries a GET through transient 5xx and returns the eventual success", async () => {
    const { fn } = stubFetch([status(503), status(502), ok()]);
    const r = await httpFetch("/x", { method: "GET" }, { maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r.res?.status).toBe(200);
    expect(r.attempts).toBe(3);
  });

  it("leaves a server-side retry's cache mode to the caller", async () => {
    // Only a browser has an HTTP cache that could answer a retry; on the
    // server a caller's `next.revalidate` + `force-cache` must reach Next
    // unchanged on every attempt (browser retries: api-fetch-cache-mode).
    const { calls } = stubFetch([status(503), ok()]);
    await httpFetch(
      "/x",
      { method: "GET", cache: "force-cache" },
      { maxAttempts: 2 },
    );
    expect(calls.map((init) => init.cache)).toEqual([
      "force-cache",
      "force-cache",
    ]);
  });

  it("never re-sends a POST without an Idempotency-Key", async () => {
    const { fn } = stubFetch([status(503), ok()]);
    const r = await httpFetch("/x", { method: "POST" }, { maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.res?.status).toBe(503);
  });

  it("re-sends a POST that carries an Idempotency-Key", async () => {
    const { fn } = stubFetch([status(503), ok()]);
    const idempotencyKey = newUUIDv7();
    const r = await httpFetch(
      "/x",
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
      { maxAttempts: 3 },
    );
    expect(fn).toHaveBeenCalledTimes(2);
    for (const [, init] of fn.mock.calls) {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
        idempotencyKey,
      );
    }
    expect(r.res?.status).toBe(200);
  });

  it("never retries a permanent client error", async () => {
    for (const code of NON_RETRYABLE_STATUSES) {
      const { fn } = stubFetch([status(code), ok()]);
      const r = await httpFetch("/x", { method: "GET" }, { maxAttempts: 3 });
      expect(fn, `status ${code}`).toHaveBeenCalledTimes(1);
      expect(r.res?.status).toBe(code);
      vi.unstubAllGlobals();
    }
  });

  // The API's capability envelope (httperror.WriteUnavailable) for a
  // deployment running without Campaign Assurance, byte for byte.
  const notEnabled = () =>
    new Response(
      '{"error":{"code":"campaign_assurance_not_enabled","message":"Campaign Assurance is not enabled on this deployment","retryable":false}}\n',
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );

  it("does not re-send a 503 that says retrying cannot help", async () => {
    const { fn } = stubFetch([notEnabled(), ok(), ok()]);
    const r = await httpFetch("/x", { method: "GET" }, { maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.res?.status).toBe(503);
    // The caller still reads the envelope it was given.
    await expect(r.res?.json()).resolves.toMatchObject({
      error: { code: "campaign_assurance_not_enabled", retryable: false },
    });
  });

  it("still retries a 503 that is retryable or says nothing", async () => {
    const retryable = new Response(
      '{"error":{"code":"campaign_assurance_unavailable","message":"retry","retryable":true}}',
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const { fn } = stubFetch([retryable, status(503), ok()]);
    const r = await httpFetch("/x", { method: "GET" }, { maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r.res?.status).toBe(200);
  });

  it("retries 429 and honours a numeric Retry-After", async () => {
    const { fn } = stubFetch([status(429, { "retry-after": "0" }), ok()]);
    const r = await httpFetch("/x", { method: "GET" }, { maxAttempts: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.res?.status).toBe(200);
  });

  it("does not replay a transport failure on a bare mutation", async () => {
    const { fn } = stubFetch([new TypeError("network down"), ok()]);
    const r = await httpFetch("/x", { method: "PATCH" }, { maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.err).toBeInstanceOf(TypeError);
    expect(r.exhausted).toBe(true);
  });

  it("replays a transport failure when the caller opts in", async () => {
    const { fn } = stubFetch([new TypeError("network down"), ok()]);
    const r = await httpFetch(
      "/x",
      { method: "PATCH" },
      { maxAttempts: 3, retryOnTransport: () => true },
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.res?.status).toBe(200);
  });

  it("stops immediately when the caller's signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { fn } = stubFetch([ok()]);
    const r = await httpFetch("/x", { method: "GET" }, { signal: ctrl.signal });
    expect(r.err).toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports timedOut when the per-attempt deadline fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const r = await httpFetch(
      "/x",
      { method: "POST" },
      { timeoutMs: 5, maxAttempts: 1 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exhausted).toBe(true);
  });
});
