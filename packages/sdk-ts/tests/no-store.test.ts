/**
 * The client must never let the platform HTTP cache revalidate for it.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────
 * The API sets `ETag` + `Cache-Control` on collection reads. Left to itself,
 * NSURLSession (and any browser cache) re-issues the request with
 * `If-None-Match`, and the server answers **304 with a zero-byte body**.
 *
 * This client has no body cache to satisfy that 304 from — the callers hold
 * the cache (TanStack Query in the apps) — and `resp.ok` is false for 304, so
 * the response falls past the success path into `mapError` and surfaces as
 * `ApiError: HTTP 304`. A perfectly healthy read becomes a failed query.
 *
 * OBSERVED LIVE on 2026-08-19 against a real API and a real simulator: the
 * mobile dashboard loaded correctly at 10:26:09 (200, 908 bytes), and every
 * refetch from 10:26:41 onward was a 0-byte 304. The screen replaced itself
 * with "Something went wrong loading the dashboard" exactly one refetch
 * interval after opening and never recovered.
 *
 * Node's fetch has no HTTP cache, so no unit test can reproduce the 304 —
 * which is precisely why this asserts the PREVENTION instead: every request
 * must carry `cache: "no-store"`.
 */
import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function spyClient() {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => json({ ok: true }),
  );
  const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
  return { pw, fetch };
}

describe("platform cache revalidation", () => {
  it("sends cache: no-store on a GET", async () => {
    const { pw, fetch } = spyClient();
    await pw.request("GET", "/api/v1/dashboard/stats");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("sends cache: no-store on a write too", async () => {
    const { pw, fetch } = spyClient();
    await pw.request("POST", "/api/v1/campaigns", { body: { name: "x" } });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("RECOVERS from a 304 by busting the cache key", async () => {
    // React Native ignores `cache`, so on iOS a 304 arrives anyway. Without
    // recovery it becomes `ApiError: HTTP 304` and a healthy read fails.
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(null, { status: 304 })
        : json({ subscribers_total: 7 });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    const out = await pw.request<{ subscribers_total: number }>(
      "GET",
      "/api/v1/dashboard/stats",
    );
    expect(out.subscribers_total).toBe(7);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("_cb=");
    expect(calls[1]).toContain("_cb=");
  });

  it("does not retry a 304 on an unsafe method", async () => {
    // Only GET/HEAD are cache-revalidated; replaying a POST would be a second
    // write.
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await expect(
      pw.request("POST", "/api/v1/campaigns", { body: { name: "x" } }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
