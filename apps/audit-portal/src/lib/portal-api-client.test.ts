import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortalApiClient } from "./portal-api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portal API credential boundary", () => {
  it("exchanges only through a credentialed same-origin POST without Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPortalApiClient().exchangeBootstrap("one.time.jwt");
    expect(result).toEqual({ ok: true, data: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/audit/portal/exchange");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ bootstrap: "one.time.jwt" });
  });

  it("uses only the dedicated cookie-authenticated read routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPortalApiClient().listAudit({
      limit: 50,
      cursor: "123",
      action: "user.login",
    });
    expect(result.ok).toBe(true);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/v1/audit/portal/events?limit=50&cursor=123&action=user.login",
    );
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("does not reflect exchange response details to an embedded customer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "database token_hash=secret" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPortalApiClient().exchangeBootstrap("one.time.jwt");
    expect(result).toEqual({
      ok: false,
      error: "This portal link is invalid, expired, or has already been used.",
      status: 401,
    });
  });
});

describe("portal API responsiveness bound", () => {
  // A socket that connects and never answers. Only the request's own abort
  // signal can end it — nothing here resolves on its own.
  function hangingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    );
  }

  it("gives up on a hung API instead of parking the auditor on the loading state", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const api = createPortalApiClient({ requestTimeoutMs: 25, bundleTimeoutMs: 25 });

    for (const result of await Promise.all([
      api.getBranding(),
      api.listAudit({ limit: 50 }),
      api.exchangeBootstrap("one.time.jwt"),
      api.downloadAivsBundle("session-7"),
    ])) {
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("did not respond in time");
    }
  });
});
