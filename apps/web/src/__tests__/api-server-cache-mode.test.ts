// SPDX-License-Identifier: AGPL-3.0-only
//
// The server half of api.ts's cache-mode default (the browser half is
// api-fetch-cache-mode.test.ts). Server components call the API directly;
// their authenticated reads must stay out of Next's Data Cache, while a
// public read that asked for `next.revalidate` keeps that request intact.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function serverInitFor(
  options: Record<string, unknown>,
): Promise<RequestInit & { next?: unknown }> {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { api } = await import("@/lib/api");
  await api.get("/api/v1/lists", { maxAttempts: 1, ...options });
  return (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit & {
    next?: unknown;
  };
}

describe("server-side API reads", () => {
  it("default to no-store", async () => {
    expect(typeof window).toBe("undefined");
    expect((await serverInitFor({})).cache).toBe("no-store");
  });

  it("leave a caller's revalidate window unopposed", async () => {
    const init = await serverInitFor({ next: { revalidate: 60 } });
    expect(init.cache).toBeUndefined();
    expect(init.next).toEqual({ revalidate: 60 });
  });

  it("keep a caller's explicit mode", async () => {
    expect((await serverInitFor({ cache: "force-cache" })).cache).toBe(
      "force-cache",
    );
  });
});
