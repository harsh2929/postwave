// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Next API proxy workspace-export stream lane", () => {
  it("does not apply the JSON or five-minute event-stream timeout to a private ZIP", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_target: URL, init: RequestInit) => {
        upstreamSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          upstreamSignal?.addEventListener(
            "abort",
            () => reject(upstreamSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const { GET } = await import("@/app/api/[...path]/route");
    const pending = GET(
      new Request(
        "https://app.postwave.test/api/v1/exports/22222222-2222-4222-8222-222222222222/download",
      ),
      {
        params: Promise.resolve({
          path: [
            "v1",
            "exports",
            "22222222-2222-4222-8222-222222222222",
            "download",
          ],
        }),
      },
    );
    await vi.advanceTimersByTimeAsync(311_000);
    expect(upstreamSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 311_000);
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_timeout" },
    });
  });

  it("forwards HEAD preflight without a request body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "content-length": "1024",
          "content-type": "application/zip",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { HEAD } = await import("@/app/api/[...path]/route");
    const response = await HEAD(
      new Request(
        "https://app.postwave.test/api/v1/exports/22222222-2222-4222-8222-222222222222/download",
        { method: "HEAD" },
      ),
      {
        params: Promise.resolve({
          path: [
            "v1",
            "exports",
            "22222222-2222-4222-8222-222222222222",
            "download",
          ],
        }),
      },
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("HEAD");
    expect(init.body).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe("application/zip");
  });
});

