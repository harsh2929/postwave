// Tests the ApiError thrown by lib/api.ts. Pinning the shape matters
// because every call site discriminates on `.status` to decide
// between "show toast" and "redirect to login" — a regression where
// status comes through as undefined would silently break that gate.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      authorization: "Bearer server-secret",
      cookie: "pw_session=server-session; pw_ref=affiliate-cookie",
    }),
}));

import {
  api,
  ApiError,
  apiErrorMessage,
  flushQueuedMutations,
} from "@/lib/api";
import { fetchPublicStatus } from "@/lib/public-status-api";
import {
  readOfflineQueue,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
  writeOfflineQueue,
  type OfflineMutation,
} from "@/lib/offline-store";

afterEach(() => {
  resetOfflineStorageIdentity();
  vi.unstubAllGlobals();
  try {
    // @ts-expect-error test-only global cleanup
    delete globalThis.navigator;
  } catch {
    /* ignore */
  }
});

describe("ApiError", () => {
  it("preserves status, message, and body", () => {
    const err = new ApiError("boom", 503, { error: "down" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("boom");
    expect(err.status).toBe(503);
    expect(err.body).toEqual({ error: "down" });
  });

  it("name is set so structured logs can filter on it", () => {
    const err = new ApiError("boom", 500);
    expect(err.name).toBe("ApiError");
  });

  it("body is optional", () => {
    const err = new ApiError("nothing", 404);
    expect(err.body).toBeUndefined();
  });

  it("preserves structured error metadata from API responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "not_found",
              message: "Subscriber not found",
              request_id: "req_body",
            },
          }),
          {
            status: 404,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_header",
            },
          },
        );
      }),
    );

    await expect(api.get("/api/v1/subscribers/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "Subscriber not found",
      requestId: "req_header",
    });
  });

  it("captures retry-after seconds from rate-limit responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: "Slow down",
              retry_after_seconds: 3,
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    try {
      await api.get("/api/v1/subscribers");
      expect.fail("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retryAfterSeconds).toBe(3);
    }
  });

  it("wraps network failures in an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    try {
      await api.get("/api/v1/subscribers");
      expect.fail("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(0);
      expect((err as ApiError).code).toBe("network_error");
      expect((err as ApiError).kind).toBe("network");
    }
  });

  it("rejects oversized successful API responses instead of treating them as empty success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("{}", {
          status: 200,
          headers: { "content-length": String(3 * 1024 * 1024) },
        });
      }),
    );

    await expect(api.get("/api/v1/subscribers")).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      code: "response_too_large",
      kind: "parse",
      message: "API response was too large to process",
    });
  });

  it("posts raw multipart bodies through the shared request shell", async () => {
    const form = new FormData();
    form.append("file", new Blob(["email\nx@y.com"], { type: "text/csv" }));
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ total_rows: 1, rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.postRaw("/api/v1/subscribers/import", form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/subscribers/import");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({ Accept: "application/json" });
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  it("does not forward server cookies or auth when credentials are omitted", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/public/status", { credentials: "omit" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ Accept: "application/json" });
    expect(init.headers).not.toHaveProperty("cookie");
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("still forwards server cookies and auth by default for signed-in API calls", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/v1/subscribers");

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      authorization: "Bearer server-secret",
      cookie: "pw_session=server-session; pw_ref=affiliate-cookie",
    });
  });

  it("fetches public status without credentials and fails soft", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicStatus()).resolves.toMatchObject({
      overall_status: "down",
      services: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("short-circuits known browser-offline requests", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn());

    try {
      await api.get("/api/v1/subscribers");
      expect.fail("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(0);
      expect((err as ApiError).code).toBe("offline");
      expect((err as ApiError).kind).toBe("offline");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a reviewed read-only POST without an Idempotency-Key", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.post(
        "/api/v1/sms/suppressions/query",
        { phone: "+12025550101" },
        {
          headers: { "idempotency-key": "caller-key-must-not-leak" },
          idempotencyKey: null,
          requireOnline: true,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never queues a reviewed read-only POST while offline", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
    });
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setOfflineStorageIdentity("user_1", "tenant_1");

    await expect(
      api.post(
        "/api/v1/sms/suppressions/query",
        { phone: "+12025550101" },
        { idempotencyKey: null, requireOnline: true },
      ),
    ).rejects.toMatchObject({ status: 0, code: "offline", kind: "offline" });
    expect(readOfflineQueue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replays only pending offline mutations and leaves conflicts for manual review", async () => {
    const storage = new Map<string, string>();
    const eventTarget = new EventTarget();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal("window", {
      localStorage,
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    });
    vi.stubGlobal(
      "CustomEvent",
      class TestCustomEvent extends Event {
        detail: unknown;
        constructor(type: string, init?: CustomEventInit) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      configurable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    setOfflineStorageIdentity("user_1", "tenant_1");

    const base: Omit<OfflineMutation, "id" | "status"> = {
      method: "PATCH",
      path: "/api/v1/forms/form_1",
      body: { name: "Updated" },
      idempotencyKey: "idem",
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    writeOfflineQueue([
      { ...base, id: "pending", status: "pending" },
      { ...base, id: "conflict", status: "conflict" },
      { ...base, id: "failed", status: "failed" },
    ]);

    const result = await flushQueuedMutations();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ replayed: 1, conflicts: 0, failed: 0 });
    expect(readOfflineQueue().map((item) => item.id)).toEqual([
      "conflict",
      "failed",
    ]);
  });

  it("formats request ids for user-facing support messages", () => {
    const err = new ApiError("Nope", 500, undefined, {
      requestId: "req_123",
    });
    expect(apiErrorMessage(err)).toBe("Nope (request req_123)");
  });
});
