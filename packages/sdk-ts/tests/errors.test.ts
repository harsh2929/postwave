import { describe, it, expect, vi } from "vitest";
import {
  PostwaveClient,
  AuthError,
  NotFoundError,
  ValidationError,
  ConflictError,
  RateLimitError,
  ServerError,
  PostwaveError,
  NetworkError,
  TimeoutError,
  RequestAbortedError,
  ParseError,
} from "../src/index.js";

function fetchReturning(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

describe("error mapping", () => {
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };

  it("maps 401 → AuthError", async () => {
    const fetch = fetchReturning(401, {
      error: { code: "no_tenant", message: "tenant required" },
    });
    const pw = new PostwaveClient({ ...opts, fetch });
    await expect(pw.subscribers.list()).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 404 → NotFoundError with code + message", async () => {
    const fetch = fetchReturning(404, {
      error: { code: "not_found", message: "no such form" },
    });
    const pw = new PostwaveClient({ ...opts, fetch });
    try {
      await pw.forms.get("missing");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      const err = e as NotFoundError;
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("no such form");
    }
  });

  it("maps 409 → ConflictError", async () => {
    const fetch = fetchReturning(409, {
      error: { code: "slug_taken", message: "taken" },
    });
    const pw = new PostwaveClient({ ...opts, fetch });
    await expect(
      pw.forms.create({ name: "x", slug: "x", optInMode: "single" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps 422 → ValidationError with fields[]", async () => {
    const fetch = fetchReturning(422, {
      error: {
        code: "invalid",
        message: "bad input",
        fields: [{ path: "/email", message: "must be email" }],
      },
    });
    const pw = new PostwaveClient({ ...opts, fetch });
    try {
      await pw.subscribers.create({ email: "bad" });
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).fields).toHaveLength(1);
    }
  });

  it("maps 5xx → ServerError after retries", async () => {
    const fetch = fetchReturning(500, {
      error: { code: "boom", message: "kaboom" },
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });
    await expect(pw.subscribers.list()).rejects.toBeInstanceOf(ServerError);
  });

  it("supports flat `{error: 'string'}` envelopes", async () => {
    const fetch = fetchReturning(404, { error: "no rollback for this job" });
    const pw = new PostwaveClient({ ...opts, fetch });
    try {
      await pw.migrations.rollbackStatus("jx");
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as PostwaveError).message).toBe("no rollback for this job");
    }
  });

  it("captures request_id from header", async () => {
    const fetch = fetchReturning(
      404,
      { error: { code: "not_found", message: "missing" } },
      { "x-request-id": "req_xyz" },
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    try {
      await pw.subscribers.get("nope");
      expect.fail();
    } catch (e) {
      expect((e as PostwaveError).requestId).toBe("req_xyz");
    }
  });

  it("captures request_id from the canonical error envelope", async () => {
    const fetch = fetchReturning(500, {
      error: {
        code: "internal_server_error",
        message: "internal",
        request_id: "req_body",
      },
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });
    try {
      await pw.subscribers.list();
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(ServerError);
      expect((e as PostwaveError).requestId).toBe("req_body");
    }
  });

  it("supports flat top-level error envelopes", async () => {
    const fetch = fetchReturning(422, {
      code: "invalid_contact",
      message: "Email is invalid",
      request_id: "req_flat",
      fields: [{ path: "/email", message: "must be email" }],
    });
    const pw = new PostwaveClient({ ...opts, fetch });
    try {
      await pw.subscribers.create({ email: "bad" });
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as PostwaveError).code).toBe("invalid_contact");
      expect((e as PostwaveError).message).toBe("Email is invalid");
      expect((e as PostwaveError).requestId).toBe("req_flat");
      expect((e as ValidationError).fields).toEqual([
        { path: "/email", message: "must be email" },
      ]);
    }
  });

  it("maps 429 → RateLimitError", async () => {
    const fetch = fetchReturning(
      429,
      {
        error: {
          code: "rate_limited",
          message: "too many",
          retry_after_seconds: 1,
        },
      },
      { "retry-after": "1" },
    );
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });
    await expect(pw.subscribers.list()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps fetch failures to NetworkError", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });
    await expect(pw.subscribers.list()).rejects.toBeInstanceOf(NetworkError);
    await expect(pw.subscribers.list()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("maps request timeouts to TimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(
              () => reject(new DOMException("aborted", "AbortError")),
              20,
            );
          }),
      );
      const pw = new PostwaveClient({
        ...opts,
        fetch,
        retries: 0,
        timeoutMs: 5,
      });
      const promise = expect(pw.subscribers.list()).rejects.toBeInstanceOf(
        TimeoutError,
      );
      await vi.advanceTimersByTimeAsync(20);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry caller-cancelled requests", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 3 });
    const ac = new AbortController();
    const promise = pw.request("GET", "/api/v1/subscribers", {
      signal: ac.signal,
    });
    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a signal that was aborted before the request starts", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 3 });
    const ac = new AbortController();
    ac.abort();
    await expect(
      pw.request("GET", "/api/v1/subscribers", { signal: ac.signal }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts while waiting for retry backoff", async () => {
    const fetch = fetchReturning(
      500,
      { error: { code: "internal_server_error", message: "try later" } },
      { "retry-after": "30" },
    );
    const pw = new PostwaveClient({ ...opts, fetch, retries: 3 });
    const ac = new AbortController();
    const promise = pw.request("GET", "/api/v1/subscribers", {
      signal: ac.signal,
    });

    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not parse oversized error bodies", async () => {
    const body = "x".repeat(70 * 1024);
    const fetch = fetchReturning(500, body, {
      "content-length": String(body.length),
      "content-type": "text/plain",
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });

    await expect(pw.subscribers.list()).rejects.toBeInstanceOf(ServerError);
    await expect(pw.subscribers.list()).rejects.toMatchObject({
      status: 500,
      code: "http_500",
    });
  });

  it("normalizes unsafe timeout and retry options", () => {
    const fetch = fetchReturning(200, { ok: true });
    const defaults = new PostwaveClient({
      ...opts,
      fetch,
      retries: -1,
      timeoutMs: 0,
    });
    const clamped = new PostwaveClient({
      ...opts,
      fetch,
      retries: 999,
      timeoutMs: 999_999,
    });

    expect(defaults.retries).toBe(3);
    expect(defaults.timeoutMs).toBe(30_000);
    expect(clamped.retries).toBe(10);
    expect(clamped.timeoutMs).toBe(120_000);
  });

  it("maps malformed successful JSON to ParseError instead of NetworkError", async () => {
    const fetch = fetchReturning(200, "{nope", {
      "content-type": "application/json",
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });

    await expect(
      pw.request("GET", "/api/v1/subscribers"),
    ).rejects.toBeInstanceOf(ParseError);
    await expect(
      pw.request("GET", "/api/v1/subscribers"),
    ).rejects.toMatchObject({
      status: 200,
      code: "invalid_json",
    });
  });

  it("rejects oversized successful JSON responses instead of treating them as empty", async () => {
    const body = JSON.stringify({ items: [], blob: "x".repeat(2 * 1024 * 1024) });
    const fetch = fetchReturning(200, body, {
      "content-length": String(body.length),
      "content-type": "application/json",
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });

    await expect(
      pw.request("GET", "/api/v1/subscribers"),
    ).rejects.toMatchObject({
      status: 200,
      code: "response_too_large",
    });
  });

  it("rejects oversized successful text exports instead of returning an empty string", async () => {
    const body = "x".repeat(2 * 1024 * 1024 + 1);
    const fetch = fetchReturning(200, body, {
      "content-length": String(body.length),
      "content-type": "text/csv",
    });
    const pw = new PostwaveClient({ ...opts, fetch, retries: 0 });

    await expect(
      pw.request("GET", "/api/v1/export.csv", { asText: true }),
    ).rejects.toMatchObject({
      status: 200,
      code: "response_too_large",
    });
  });
});
