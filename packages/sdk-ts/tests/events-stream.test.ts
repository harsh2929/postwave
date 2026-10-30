import { describe, expect, it, vi } from "vitest";
import { NotFoundError, PostwaveClient, PostwaveError } from "../src/index.js";

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(enc.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("EventsResource.stream", () => {
  it("uses the configured fetch implementation and SDK auth headers", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'event: opened\n',
        'data: {"ts":"2026-05-19T00:00:00Z","event_type":"opened"}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      defaultHeaders: { "X-Postwave-Client": "mobile" },
      fetch,
      retries: 0,
    });

    await expect(
      collect(pw.events.stream({ event_type: "opened", campaign: "cmp_1" })),
    ).resolves.toEqual([
      { ts: "2026-05-19T00:00:00Z", event_type: "opened" },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/events/stream?event_type=opened&campaign=cmp_1",
      expect.objectContaining({
        method: "GET",
        credentials: undefined,
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer pw_key",
          "X-Tenant-Slug": "tenant-one",
          "X-Postwave-Client": "mobile",
        }),
      }),
    );
  });

  it("delivers the final SSE frame even when the stream closes without a blank separator", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'data: {"ts":"2026-05-19T01:00:00Z","event_type":"clicked"}\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T01:00:00Z", event_type: "clicked" },
    ]);
  });

  it("parses CRLF-delimited SSE frames", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'event: clicked\r\ndata: {"ts":"2026-05-19T01:00:00Z","event_type":"clicked"}\r\n\r\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T01:00:00Z", event_type: "clicked" },
    ]);
  });

  it("skips malformed and shape-invalid SSE frames", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        "data: not-json\n\n",
        'data: {"ts":"2026-05-19T01:00:00Z"}\n\n',
        'data: {"ts":"2026-05-19T02:00:00Z","event_type":"opened","metadata":[]}\n\n',
        'data: {"ts":"2026-05-19T03:00:00Z","event_type":"opened","metadata":{"ok":true}}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      {
        ts: "2026-05-19T03:00:00Z",
        event_type: "opened",
        metadata: { ok: true },
      },
    ]);
  });

  it("drops oversized stream frames and continues with later valid events", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        `data: {"ts":"2026-05-19T00:00:00Z","event_type":"opened","metadata":{"blob":"${"x".repeat(300_000)}"}}\n\n`,
        'data: {"ts":"2026-05-19T04:00:00Z","event_type":"clicked"}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T04:00:00Z", event_type: "clicked" },
    ]);
  });

  it("maps stream HTTP errors through the SDK error hierarchy", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: "missing_stream", message: "stream not found" },
        }),
        {
          status: 404,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_stream",
          },
        },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    try {
      await collect(pw.events.stream());
      expect.fail("expected stream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as PostwaveError).code).toBe("missing_stream");
      expect((err as PostwaveError).requestId).toBe("req_stream");
    }
  });
});
