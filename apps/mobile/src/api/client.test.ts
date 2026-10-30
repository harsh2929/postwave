import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEventBusConnection,
  connectEventBus,
  listVoiceLabels,
  streamAIGenerate,
} from "./client";

type TestSession = {
  email: string;
  userId: string;
  tenantId: string;
  role: string;
  authProvider: string;
  emailVerified: boolean;
  hasTotp: boolean;
  workspaceSlug?: string;
};

type TestAuthState = {
  apiKey: string | null;
  baseUrl: string | null;
  tenantId: string | null;
  mode: "api_key" | "session" | null;
  session: TestSession | null;
};

const authState = vi.hoisted(() => ({
  current: {
    apiKey: "abc123",
    baseUrl: "https://api.example.com",
    tenantId: "tenant-one",
    mode: "api_key",
    session: null,
  } as TestAuthState,
}));

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => true,
}));

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(),
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => authState.current,
  },
}));

vi.mock("expo/fetch", () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) =>
    globalThis.fetch(...args),
}));

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }) as never,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("mobile event-bus auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    authState.current = {
      apiKey: "abc123",
      baseUrl: "https://api.example.com",
      tenantId: "tenant-one",
      mode: "api_key",
      session: null,
    };
  });

  it("mints stream tokens with tenant context in API-key mode", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ token: "pws_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const conn = await buildEventBusConnection(["campaign.*"]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/streams/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer pw_abc123",
          "X-Tenant-Slug": "tenant-one",
        }),
      }),
    );
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("credentials");
    expect(conn).toEqual({
      url: "https://api.example.com/api/v1/events?topics=campaign.*&stream_token=pws_token",
      bearer: "pw_abc123",
      tenantId: "tenant-one",
    });
  });

  it("normalizes trailing slashes in API bases for stream URLs", async () => {
    authState.current = {
      ...authState.current,
      baseUrl: "https://api.example.com/",
    };
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ token: "pws_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const conn = await buildEventBusConnection(["campaign.*"]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/streams/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(conn.url).toBe(
      "https://api.example.com/api/v1/events?topics=campaign.*&stream_token=pws_token",
    );
  });

  it("keeps tenant context without putting API keys in remote stream URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 501 })),
    );

    const conn = await buildEventBusConnection([]);

    expect(conn).toEqual({
      url: "https://api.example.com/api/v1/events?topics=*",
      bearer: "pw_abc123",
      tenantId: "tenant-one",
    });
  });

  it("drops oversized UTF-8 stream-token responses in text-only runtimes", async () => {
    const hugeTokenBody = JSON.stringify({ token: "😊".repeat(17_000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: null,
            text: async () => hugeTokenBody,
          }) as unknown as Response,
      ),
    );

    const conn = await buildEventBusConnection(["campaign.*"]);

    expect(conn).toEqual({
      url: "https://api.example.com/api/v1/events?topics=campaign.*",
      bearer: "pw_abc123",
      tenantId: "tenant-one",
    });
  });

  it("never copies API keys into local-development stream URLs", async () => {
    authState.current = {
      ...authState.current,
      baseUrl: "http://localhost:8080",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 501 })),
    );

    const conn = await buildEventBusConnection([]);

    expect(conn).toEqual({
      url: "http://localhost:8080/api/v1/events?topics=*",
      bearer: "pw_abc123",
      tenantId: "tenant-one",
    });
  });

  it("mints stream tokens with tenant context in session-cookie mode", async () => {
    authState.current = {
      apiKey: null,
      baseUrl: "https://api.example.com",
      tenantId: "tenant-session",
      mode: "session",
      session: {
        email: "owner@example.com",
        userId: "user-one",
        tenantId: "tenant-session",
        workspaceSlug: "workspace-session",
        role: "owner",
        authProvider: "password",
        emailVerified: true,
        hasTotp: false,
      },
    };
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ token: "pws_session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const conn = await buildEventBusConnection(["*"]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/streams/token",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          Accept: "application/json",
          "X-Tenant-Slug": "workspace-session",
        }),
      }),
    );
    expect(conn).toEqual({
      url: "https://api.example.com/api/v1/events?topics=*&stream_token=pws_session",
      bearer: null,
      tenantId: "workspace-session",
    });
  });

  it("uses the session workspace slug rather than its tenant UUID", async () => {
    authState.current = {
      apiKey: null,
      baseUrl: "https://api.example.com",
      tenantId: null,
      mode: "session",
      session: {
        email: "owner@example.com",
        userId: "user-one",
        tenantId: "tenant-from-session",
        workspaceSlug: "workspace-from-session",
        role: "owner",
        authProvider: "password",
        emailVerified: true,
        hasTotp: false,
      },
    };
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ token: "pws_session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const conn = await buildEventBusConnection(["campaign.*"]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/streams/token",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          "X-Tenant-Slug": "workspace-from-session",
        }),
      }),
    );
    expect(conn.tenantId).toBe("workspace-from-session");
  });

  it("serializes voice-label filters through URLSearchParams", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ items: [], total: 0, page: 2, size: 25 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const res = await listVoiceLabels({
      axis: "tone/style" as never,
      page: 2,
      size: 25,
    });

    expect(res.error).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/voice/labels?axis=tone%2Fstyle&page=2&size=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("delivers a final event-bus frame even when the stream closes without a blank line", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/streams/token")) {
        return Response.json({ token: "pws_token" });
      }
      return sseResponse([
        'event: message\ndata: {"topic":"campaign.created","tenant_id":"tenant-one","at":"2026-05-19T00:00:00Z"}',
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const events: { topic: string }[] = [];
    let disconnect = (): void => {};

    await new Promise<void>((resolve) => {
      disconnect = connectEventBus(["campaign.*"], (evt) => {
        events.push(evt);
        resolve();
      });
    });
    disconnect();

    expect(events.map((event) => event.topic)).toEqual(["campaign.created"]);
  });

  it("parses CRLF-delimited event-bus frames", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/streams/token")) {
        return Response.json({ token: "pws_token" });
      }
      return sseResponse([
        'event: message\r\ndata: {"topic":"campaign.updated","tenant_id":"tenant-one","at":"2026-05-19T00:00:00Z"}\r\n\r\n',
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const events: { topic: string }[] = [];
    let disconnect = (): void => {};

    await new Promise<void>((resolve) => {
      disconnect = connectEventBus(["campaign.*"], (evt) => {
        events.push(evt);
        resolve();
      });
    });
    disconnect();

    expect(events.map((event) => event.topic)).toEqual(["campaign.updated"]);
  });

  it("drops oversized event-bus frames without poisoning later frames", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oversized = JSON.stringify({ topic: "x".repeat(140_000) });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/streams/token")) {
        return Response.json({ token: "pws_token" });
      }
      return sseResponse([
        `event: message\ndata: ${oversized}\n\n`,
        'event: message\ndata: {"topic":"campaign.created","tenant_id":"tenant-one","at":"2026-05-19T00:00:00Z"}\n\n',
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const events: { topic: string }[] = [];
    let disconnect = (): void => {};

    await new Promise<void>((resolve) => {
      disconnect = connectEventBus(["campaign.*"], (evt) => {
        events.push(evt);
        resolve();
      });
    });
    disconnect();

    expect(events.map((event) => event.topic)).toEqual(["campaign.created"]);
  });

  it("counts UTF-8 bytes for event-bus frame limits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oversized = JSON.stringify({ topic: "😀".repeat(40_000) });
    expect(oversized.length).toBeLessThan(128 * 1024);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/streams/token")) {
        return Response.json({ token: "pws_token" });
      }
      return sseResponse([
        `event: message\ndata: ${oversized}\n\n`,
        'event: message\ndata: {"topic":"campaign.created","tenant_id":"tenant-one","at":"2026-05-19T00:00:00Z"}\n\n',
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const events: { topic: string }[] = [];
    let disconnect = (): void => {};

    await new Promise<void>((resolve) => {
      disconnect = connectEventBus(["campaign.*"], (evt) => {
        events.push(evt);
        resolve();
      });
    });
    disconnect();

    expect(events.map((event) => event.topic)).toEqual(["campaign.created"]);
  });

  it("surfaces an unsupported status instead of silently retrying without a stream body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/streams/token")) {
        return Response.json({ token: "pws_token" });
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: null,
        text: async () => "",
      } as Response;
    });
    vi.stubGlobal("fetch", fetch);
    const statuses: string[] = [];
    let disconnect = (): void => {};

    await new Promise<void>((resolve) => {
      disconnect = connectEventBus(
        ["campaign.*"],
        () => undefined,
        (status) => {
          statuses.push(status);
          if (status === "unsupported") resolve();
        },
      );
    });
    disconnect();

    expect(statuses).toContain("unsupported");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("mobile AI stream auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    authState.current = {
      apiKey: null,
      baseUrl: "https://api.example.com",
      tenantId: null,
      mode: "session",
      session: {
        email: "owner@example.com",
        userId: "user-one",
        tenantId: "tenant-from-session",
        workspaceSlug: "workspace-from-session",
        role: "owner",
        authProvider: "password",
        emailVerified: true,
        hasTotp: false,
      },
    };
  });

  it("uses the session workspace slug on raw AI streaming requests", async () => {
    authState.current = {
      ...authState.current,
      baseUrl: "https://api.example.com/",
    };
    const fetch = vi.fn(async () =>
      sseResponse([
        'event: delta\ndata: {"text":"Ready"}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const deltas: string[] = [];

    await new Promise<void>((resolve, reject) => {
      streamAIGenerate(
        { prompt: "Suggest a subject", kind: "subject_line" },
        {
          onDelta: (chunk) => deltas.push(chunk),
          onDone: resolve,
          onError: (message) => reject(new Error(message)),
        },
      );
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/voice/generate",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          "X-Tenant-Slug": "workspace-from-session",
        }),
      }),
    );
    expect(deltas).toEqual(["Ready"]);
  });

  it("reports oversized non-stream AI responses instead of completing empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ text: "too big" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(600 * 1024),
          },
        });
      }),
    );
    const deltas: string[] = [];

    const message = await new Promise<string>((resolve, reject) => {
      streamAIGenerate(
        { prompt: "Suggest a subject", kind: "subject_line" },
        {
          onDelta: (chunk) => deltas.push(chunk),
          onDone: () => reject(new Error("unexpected done")),
          onError: resolve,
        },
      );
    });

    expect(deltas).toEqual([]);
    expect(message).toMatch(/too large/i);
  });

  it("parses buffered SSE frames when a runtime cannot expose a stream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "text/event-stream" }),
            body: null,
            text: async () =>
              'event: delta\ndata: {"text":"First"}\n\n' +
              'event: delta\ndata: {"text":" second"}\n\n' +
              "event: done\ndata: {}\n\n",
          }) as Response,
      ),
    );
    const deltas: string[] = [];

    await new Promise<void>((resolve, reject) => {
      streamAIGenerate(
        { prompt: "Suggest a subject", kind: "subject_line" },
        {
          onDelta: (chunk) => deltas.push(chunk),
          onDone: resolve,
          onError: (message) => reject(new Error(message)),
        },
      );
    });

    expect(deltas).toEqual(["First", " second"]);
  });

  it("rejects an SSE EOF without a terminal done event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['event: delta\ndata: {"text":"partial"}\n\n']),
      ),
    );
    const deltas: string[] = [];

    const message = await new Promise<string>((resolve, reject) => {
      streamAIGenerate(
        { prompt: "Suggest a subject", kind: "subject_line" },
        {
          onDelta: (chunk) => deltas.push(chunk),
          onDone: () => reject(new Error("unexpected done")),
          onError: resolve,
        },
      );
    });

    expect(deltas).toEqual(["partial"]);
    expect(message).toMatch(/ended before completion/i);
  });

  it("rejects duplicate or out-of-order terminal frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          "event: done\ndata: {}\n\n",
          'event: delta\ndata: {"text":"late"}\n\n',
        ]),
      ),
    );

    const message = await new Promise<string>((resolve, reject) => {
      streamAIGenerate(
        { prompt: "Suggest a subject", kind: "subject_line" },
        {
          onDelta: () => reject(new Error("unexpected delta")),
          onDone: () => reject(new Error("unexpected done")),
          onError: resolve,
        },
      );
    });

    expect(message).toMatch(/data after completion/i);
  });
});
