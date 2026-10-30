import { describe, it, expect, vi } from "vitest";
import { PostwaveClient, computeBackoff } from "../src/client.js";

describe("computeBackoff", () => {
  it("honors numeric Retry-After header", () => {
    const ms = computeBackoff({ attempt: 0, retryAfterSecondsHeader: "2" });
    expect(ms).toBe(2000);
  });

  it("honors HTTP-date Retry-After header", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = computeBackoff({ attempt: 0, retryAfterSecondsHeader: future });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it("falls back to exponential + jitter", () => {
    const a0 = computeBackoff({ attempt: 0 });
    const a3 = computeBackoff({ attempt: 3 });
    expect(a0).toBeGreaterThanOrEqual(250);
    expect(a3).toBeGreaterThanOrEqual(2000);
    expect(a3).toBeLessThanOrEqual(30_000);
  });

  it("body retry_after_seconds wins over header", () => {
    const ms = computeBackoff({
      attempt: 0,
      retryAfterSecondsHeader: "10",
      retryAfterSecondsBody: 1,
    });
    expect(ms).toBe(1000);
  });
});

describe("client retry behavior", () => {
  it("retries 429 once then succeeds", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { code: "rl", message: "slow down", retry_after_seconds: 0 } }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } },
        );
      }
      return new Response(JSON.stringify({ items: [], total: 0, page: 1, per_page: 50 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 2 });
    const out = await pw.subscribers.list();
    expect(out.total).toBe(0);
    expect(calls).toBe(2);
  });

  it("does not retry on 4xx (besides 429)", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: "bad", message: "no" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 3 });
    await expect(pw.subscribers.list()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("a request the server cannot deduplicate is not retried", () => {
  // Retrying is only safe when the server can recognise the repeat: a
  // semantically idempotent verb, or any request carrying an Idempotency-Key.
  //
  // `idempotencyKey: null` was documented purely as "opt out of auto-minting",
  // and retries carried on regardless — three attempts at a keyless POST. The
  // network/timeout path is where it bites hardest, because a timeout says
  // nothing about whether the server processed the request: the write may have
  // committed and only the response been lost. On a campaign send that is a
  // second send.
  function clientThatAlwaysFails(retries: number) {
    let attempts = 0;
    const client = new PostwaveClient({
      apiKey: `pw_${"a".repeat(20)}`,
      baseUrl: "https://api.test",
      retries,
      timeoutMs: 200,
      fetch: (async () => {
        attempts += 1;
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    } as never);
    const request = (
      client as unknown as {
        request: (m: string, p: string, o: unknown) => Promise<unknown>;
      }
    ).request.bind(client);
    return { attempts: () => attempts, request };
  }

  it.each([
    ["POST", { body: {}, idempotencyKey: null }],
    ["PATCH", { body: {}, idempotencyKey: null }],
    ["DELETE", { idempotencyKey: null }],
  ])("makes exactly one attempt for a keyless %s", async (method, opts) => {
    const c = clientThatAlwaysFails(2);
    await expect(c.request(method, "/api/v1/campaigns", opts)).rejects.toThrow();
    expect(c.attempts()).toBe(1);
  });

  it.each([
    ["POST", { body: {} }],
    ["DELETE", {}],
  ])("still retries %s when a key was auto-minted", async (method, opts) => {
    // Guard the guard: a change that stopped retrying writes altogether would
    // satisfy every assertion above.
    const c = clientThatAlwaysFails(2);
    await expect(c.request(method, "/api/v1/campaigns", opts)).rejects.toThrow();
    expect(c.attempts()).toBe(3);
  });

  it.each([
    ["GET", {}],
    ["PUT", { body: {} }],
  ])("still retries the idempotent verb %s without a key", async (method, opts) => {
    // GET and PUT are safe to repeat by definition, so they must keep retrying
    // even though neither mints a key.
    const c = clientThatAlwaysFails(2);
    await expect(c.request(method, "/api/v1/campaigns", opts)).rejects.toThrow();
    expect(c.attempts()).toBe(3);
  });

  it("also gates the status-based retry path", async () => {
    // A 500 can arrive after the write committed, so the same rule applies to
    // 429/5xx as to a transport failure.
    let attempts = 0;
    const client = new PostwaveClient({
      apiKey: `pw_${"a".repeat(20)}`,
      baseUrl: "https://api.test",
      retries: 2,
      timeoutMs: 200,
      fetch: (async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    } as never);
    const request = (
      client as unknown as {
        request: (m: string, p: string, o: unknown) => Promise<unknown>;
      }
    ).request.bind(client);
    await expect(
      request("POST", "/api/v1/campaigns", { body: {}, idempotencyKey: null }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
