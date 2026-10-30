import { afterEach, describe, it, expect, vi } from "vitest";
import { PostwaveClient } from "../src/index.js";

function mockFetch(handler: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    return handler({ url, init: init ?? {} });
  });
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PostwaveClient — Idempotency-Key", () => {
  it("auto-mints a UUID for POST requests", async () => {
    let captured: string | undefined;
    const fetch = mockFetch(({ init }) => {
      const headers = init.headers as Record<string, string>;
      captured = headers["Idempotency-Key"];
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("POST", "/api/v1/forms", { body: { name: "x" } });
    expect(captured).toBeDefined();
    expect(captured).toMatch(UUID_V4_RE);
  });

  it("keeps RFC v4 variant bits in the Math.random fallback", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let captured: string | undefined;
    const fetch = mockFetch(({ init }) => {
      captured = (init.headers as Record<string, string>)["Idempotency-Key"];
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });
    await pw.request("POST", "/api/v1/forms", { body: { name: "x" } });
    expect(captured).toBe("00000000-0000-4000-8000-000000000000");
    expect(captured).toMatch(UUID_V4_RE);
  });

  it("auto-mints for PATCH and DELETE", async () => {
    const seenKeys: (string | undefined)[] = [];
    const fetch = mockFetch(({ init }) => {
      seenKeys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
      return new Response(null, { status: 204 });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("PATCH", "/api/v1/forms/f_1", { body: {} });
    await pw.request("DELETE", "/api/v1/forms/f_1");
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toMatch(UUID_V4_RE);
    expect(seenKeys[1]).toMatch(UUID_V4_RE);
    expect(seenKeys[0]).not.toEqual(seenKeys[1]);
  });

  it("does NOT auto-mint on GET", async () => {
    const fetch = mockFetch(({ init }) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBeUndefined();
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("GET", "/api/v1/me");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses caller-supplied idempotencyKey when provided", async () => {
    let captured: string | undefined;
    const fetch = mockFetch(({ init }) => {
      captured = (init.headers as Record<string, string>)["Idempotency-Key"];
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("POST", "/api/v1/forms", {
      body: { name: "x" },
      idempotencyKey: "explicit-deterministic-key",
    });
    expect(captured).toBe("explicit-deterministic-key");
  });

  it("opts out of auto-mint when idempotencyKey is null", async () => {
    let captured: string | undefined = "set-to-something-truthy";
    const fetch = mockFetch(({ init }) => {
      captured = (init.headers as Record<string, string>)["Idempotency-Key"];
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("POST", "/api/v1/forms", {
      body: { name: "x" },
      idempotencyKey: null,
    });
    expect(captured).toBeUndefined();
  });

  it("reuses the SAME key across retries (the whole point)", async () => {
    let attempt = 0;
    const seenKeys: (string | undefined)[] = [];
    const fetch = mockFetch(({ init }) => {
      seenKeys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
      attempt += 1;
      if (attempt < 3) {
        // First two attempts: 500 — triggers retry.
        return new Response(JSON.stringify({ error: "transient" }), {
          status: 500,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 3 });
    await pw.request("POST", "/api/v1/forms", { body: {} });
    expect(seenKeys).toHaveLength(3);
    // Critical invariant: every retry sends the same key. Without this,
    // the server can't dedup and a network blip creates 3 rows.
    expect(new Set(seenKeys).size).toBe(1);
    expect(seenKeys[0]).toMatch(UUID_V4_RE);
  });

  it("respects an explicit Idempotency-Key passed via headers", async () => {
    let captured: string | undefined;
    const fetch = mockFetch(({ init }) => {
      captured = (init.headers as Record<string, string>)["Idempotency-Key"];
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
    await pw.request("POST", "/api/v1/forms", {
      body: {},
      headers: { "Idempotency-Key": "header-supplied" },
    });
    expect(captured).toBe("header-supplied");
  });
});
