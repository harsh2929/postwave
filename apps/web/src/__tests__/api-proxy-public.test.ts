import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/[...path]/route";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Next API proxy public request boundary", () => {
  it("strips signed-in identity and retired attribution from public requests", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(
        "https://app.postwave.test/api/public/forms/waitlist/submit",
        {
          method: "POST",
          headers: {
            authorization: "Bearer browser-token",
            cookie:
              "pw_session=session; pw_ref=affiliate; NEXT_LOCALE=en; random_cookie=private",
            "content-type": "application/json",
            "x-postwave-token": "api-secret",
            "x-tenant-slug": "evil-tenant",
          },
          body: JSON.stringify({ email: "a@example.com" }),
        },
      ),
      {
        params: Promise.resolve({
          path: ["public", "forms", "waitlist", "submit"],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-postwave-token")).toBeNull();
    expect(headers.get("x-tenant-slug")).toBeNull();
    expect(headers.get("cookie")).toBe("NEXT_LOCALE=en");
    expect(headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("keeps dashboard proxy requests signed in", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("https://app.postwave.test/api/v1/campaigns", {
        method: "POST",
        headers: {
          authorization: "Bearer browser-token",
          cookie: "pw_session=session; pw_ref=affiliate",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Launch" }),
      }),
      { params: Promise.resolve({ path: ["v1", "campaigns"] }) },
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer browser-token");
    expect(headers.get("cookie")).toBe("pw_session=session; pw_ref=affiliate");
    await response.arrayBuffer();
  });

  it("re-encodes catch-all path segments before forwarding upstream", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(
        "https://app.postwave.test/api/v1/forms/form%2Fid/submissions?limit=10",
        {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        },
      ),
      {
        params: Promise.resolve({
          path: ["v1", "forms", "form/id", "submissions"],
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe(
      "http://localhost:8080/api/v1/forms/form%2Fid/submissions?limit=10",
    );
    await response.arrayBuffer();
  });

  it.each([
    [
      "root",
      "https://api.postwave.test",
      "https://api.postwave.test/api/public/forms/demo?limit=10",
    ],
    [
      "path-prefixed",
      "https://api.postwave.test/gateway/",
      "https://api.postwave.test/gateway/api/public/forms/demo?limit=10",
    ],
  ])(
    "preserves the %s API base while appending path and query once",
    async (_name, apiUrl, expected) => {
      vi.stubEnv("API_URL", apiUrl);
      const fetchMock = vi.fn(async () => Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(
        new Request(
          "https://app.postwave.test/api/public/forms/demo?limit=10",
          { headers: { authorization: "Bearer must-not-forward" } },
        ),
        { params: Promise.resolve({ path: ["public", "forms", "demo"] }) },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [target, init] = fetchMock.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(target.toString()).toBe(expected);
      expect((init.headers as Headers).get("authorization")).toBeNull();
      await response.arrayBuffer();
    },
  );

  it.each([
    [
      "root",
      "https://api.postwave.test",
      "https://api.postwave.test/api/v1/settings/sending?view=exact",
    ],
    [
      "path-prefixed",
      "https://api.postwave.test/gateway/",
      "https://api.postwave.test/gateway/api/v1/settings/sending?view=exact",
    ],
  ])(
    "forwards private credentials to the %s API namespace exactly once",
    async (_name, apiUrl, expected) => {
      vi.stubEnv("API_URL", apiUrl);
      const fetchMock = vi.fn(async () => Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(
        new Request(
          "https://app.postwave.test/api/v1/settings/sending?view=exact",
          {
            headers: {
              authorization: "Bearer browser-session",
              cookie: "pw_session=session-value",
            },
          },
        ),
        {
          params: Promise.resolve({
            path: ["v1", "settings", "sending"],
          }),
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [target, init] = fetchMock.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(target.toString()).toBe(expected);
      const headers = init.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer browser-session");
      expect(headers.get("cookie")).toBe("pw_session=session-value");
      await response.arrayBuffer();
    },
  );

  it("rejects dot-segment proxy params before forwarding upstream", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    for (const path of [
      ["..", "admin"],
      ["v1", ".", "me"],
      ["v1", "%2e%2e", "admin"],
      ["v1", "bad\\path"],
      ["v1", "bad\u0000path"],
    ]) {
      const res = await POST(
        new Request("https://app.postwave.test/api/v1/anything", {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        }),
        { params: Promise.resolve({ path }) },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "unsafe_proxy_path" },
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips sensitive upstream response headers from public API responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            server: "listmonk",
            "set-cookie": "pw_session=upstream; HttpOnly",
            "www-authenticate": "Basic realm=admin",
            "x-listmonk-version": "4.1.0",
            "x-powered-by": "go",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      new Request(
        "https://app.postwave.test/api/public/forms/waitlist/submit",
        {
          method: "POST",
          body: JSON.stringify({ email: "a@example.com" }),
        },
      ),
      {
        params: Promise.resolve({
          path: ["public", "forms", "waitlist", "submit"],
        }),
      },
    );

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("x-listmonk-version")).toBeNull();
    expect(res.headers.get("x-powered-by")).toBeNull();
    await res.arrayBuffer();
  });

  it("preserves upstream session cookies on signed-in API responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "pw_session=upstream; HttpOnly; SameSite=Lax",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      new Request("https://app.postwave.test/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      { params: Promise.resolve({ path: ["v1", "auth", "login"] }) },
    );

    expect(res.headers.get("set-cookie")).toContain("pw_session=upstream");
    await res.arrayBuffer();
  });

  it("rejects oversized proxy bodies before forwarding upstream", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      new Request("https://app.postwave.test/api/v1/imports/csv", {
        method: "POST",
        headers: {
          "content-length": String(26 * 1024 * 1024),
          "content-type": "text/csv",
        },
        body: "email\nperson@example.com\n",
      }),
      { params: Promise.resolve({ path: ["v1", "imports", "csv"] }) },
    );

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
  });

  it("redacts token-like values from dev upstream failure logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "failed https://api.example.com/api/v1/events?stream_token=pws_secret#frag access_token=tok_secret",
        );
      }),
    );

    const res = await POST(
      new Request(
        "https://app.postwave.test/api/v1/events?stream_token=pws_browser",
        {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        },
      ),
      { params: Promise.resolve({ path: ["v1", "events"] }) },
    );

    expect(res.status).toBe(502);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("pws_secret");
    expect(logged).not.toContain("tok_secret");
    expect(logged).not.toContain("#frag");
    expect(logged).toContain("redacted");
  });

  it("aborts and cancels the upstream body when the downstream response is cancelled", async () => {
    let fetchSignal: AbortSignal | undefined;
    let upstreamCancelReason: unknown;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first chunk"));
      },
      cancel(reason) {
        upstreamCancelReason = reason;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_target: URL, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Response(upstreamBody, {
          headers: { "content-type": "application/octet-stream" },
        });
      }),
    );

    const response = await GET(
      new Request("https://app.postwave.test/api/v1/campaigns"),
      { params: Promise.resolve({ path: ["v1", "campaigns"] }) },
    );
    const reader = response.body?.getReader();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });

    await reader?.cancel("downstream closed");

    expect(fetchSignal?.aborted).toBe(true);
    expect(fetchSignal?.reason).toBe("downstream closed");
    expect(upstreamCancelReason).toBe("downstream closed");
  });

  it("bridges a browser disconnect to the upstream fetch and response body", async () => {
    const downstream = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let upstreamCancelReason: unknown;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel(reason) {
        upstreamCancelReason = reason;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_target: URL, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Response(upstreamBody, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await GET(
      new Request("https://app.postwave.test/api/v1/events", {
        signal: downstream.signal,
      }),
      { params: Promise.resolve({ path: ["v1", "events"] }) },
    );
    downstream.abort("browser disconnected");

    await vi.waitFor(() => {
      expect(fetchSignal?.aborted).toBe(true);
      expect(upstreamCancelReason).toBe("browser disconnected");
    });
    await response.body?.cancel();
  });

  it("closes quietly when a pending upstream read rejects during request abort", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const downstream = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_target: URL, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        const upstreamBody = new ReadableStream<Uint8Array>({
          start(controller) {
            fetchSignal?.addEventListener(
              "abort",
              () => {
                const error = new Error("upstream response aborted");
                error.name = "ResponseAborted";
                controller.error(error);
              },
              { once: true },
            );
          },
        });
        return new Response(upstreamBody, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await GET(
      new Request("https://app.postwave.test/api/v1/events", {
        signal: downstream.signal,
      }),
      { params: Promise.resolve({ path: ["v1", "events"] }) },
    );
    const pendingRead = response.body?.getReader().read();
    downstream.abort("browser disconnected");

    await expect(pendingRead).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(fetchSignal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a quiet client-closed response when abort happens before headers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const downstream = new AbortController();
    const fetchMock = vi.fn(
      async (_target: URL, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("upstream response aborted");
              error.name = "ResponseAborted";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pendingResponse = GET(
      new Request("https://app.postwave.test/api/v1/events", {
        signal: downstream.signal,
      }),
      { params: Promise.resolve({ path: ["v1", "events"] }) },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    downstream.abort("browser disconnected");

    const response = await pendingResponse;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats CSV import progress as a stream, so its deadline outlives the JSON timeout", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_target: URL, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await GET(
      new Request(
        "https://app.postwave.test/api/v1/subscriber-imports/imp_1/progress",
      ),
      {
        params: Promise.resolve({
          path: ["v1", "subscriber-imports", "imp_1", "progress"],
        }),
      },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Past the 15 s JSON deadline: a stream is still open.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(fetchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(310_000 - 15_001);
    expect(fetchSignal?.aborted).toBe(true);
    await response.body?.cancel();
  });

  it("keeps the stream deadline active after headers and cancels at timeout", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    let upstreamCancelReason: unknown;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel(reason) {
        upstreamCancelReason = reason;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_target: URL, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Response(upstreamBody, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await GET(
      new Request("https://app.postwave.test/api/v1/events"),
      { params: Promise.resolve({ path: ["v1", "events"] }) },
    );
    const pendingRead = response.body?.getReader().read();

    await vi.advanceTimersByTimeAsync(309_999);
    expect(fetchSignal?.aborted).toBe(false);
    expect(upstreamCancelReason).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await expect(pendingRead).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(fetchSignal?.aborted).toBe(true);
    expect(fetchSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(upstreamCancelReason).toMatchObject({ name: "TimeoutError" });
  });
});
