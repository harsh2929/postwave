// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The browser half of the stale-after-write fix (CACHE-02). The query client
// refetches after every write to get the server's current answer; when the
// transport let the browser's HTTP cache answer that refetch, a page showed
// its pre-write data, and the form editor took the stale ETag out of that
// answer and earned its next If-Match save a 412 ("Form changed elsewhere").
//
// `modelBrowserFetch` stands in for the browser: it stores GET responses and
// reuses them according to the request's fetch cache mode, as the Fetch
// standard defines it for the modes the app uses — "default" reuses a stored
// response while its max-age lasts, "no-cache" always asks the server
// (conditionally, with the stored ETag), "no-store" neither reads nor writes
// the store. Writes invalidate their own URL unless they carry If-Match, as
// Chromium was observed to do. The origin sends the pre-fix API header
// (`private, max-age=10, stale-while-revalidate=60`): the client must be
// correct even when a response carries freshness it should not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { api } from "@/lib/api";
import { getForm, updateForm } from "@/lib/forms-api";
import { httpFetch } from "@/lib/http-fetch";

const STALE_PRONE_POLICY = "private, max-age=10, stale-while-revalidate=60";

interface Stored {
  status: number;
  headers: Headers;
  body: string;
}

interface ModelledFetch {
  fetch: ReturnType<typeof vi.fn>;
  /** "METHOD url" for every request that reached the origin. */
  originRequests: string[];
  /** The init of every fetch the app made, in order. */
  inits: RequestInit[];
}

function maxAgeOf(headers: Headers): number {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/(^|,)\s*(no-cache|no-store)/.test(cc)) return 0;
  const match = /max-age=(\d+)/.exec(cc);
  return match ? Number(match[1]) : 0;
}

function modelBrowserFetch(
  origin: (url: string, init: RequestInit) => Response,
): ModelledFetch {
  const store = new Map<string, Stored>();
  const originRequests: string[] = [];
  const inits: RequestInit[] = [];
  const toResponse = (stored: Stored) =>
    new Response(stored.status === 204 ? null : stored.body, {
      status: stored.status,
      headers: stored.headers,
    });
  const forward = async (url: string, init: RequestInit) => {
    originRequests.push(`${(init.method ?? "GET").toUpperCase()} ${url}`);
    const res = origin(url, init);
    return {
      status: res.status,
      headers: new Headers(res.headers),
      body: await res.text(),
    };
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      inits.push(init);
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      const mode = init.cache ?? "default";
      if (method !== "GET" && method !== "HEAD") {
        const res = await forward(url, init);
        if (res.status < 400 && !new Headers(init.headers).has("If-Match")) {
          store.delete(url);
        }
        return toResponse(res);
      }
      const stored = store.get(url);
      if (
        stored &&
        (mode === "default" || mode === "force-cache") &&
        maxAgeOf(stored.headers) > 0
      ) {
        // Fresh by max-age (the model's clock does not move): reused
        // without contacting the server.
        return toResponse(stored);
      }
      let res: Stored;
      if (stored && mode !== "no-store" && mode !== "reload") {
        const conditional = new Headers(init.headers);
        const etag = stored.headers.get("etag");
        if (etag) conditional.set("If-None-Match", etag);
        res = await forward(url, { ...init, headers: conditional });
        if (res.status === 304) {
          res.headers.forEach((value, name) => stored.headers.set(name, value));
          return toResponse(stored);
        }
      } else {
        res = await forward(url, init);
      }
      // Stored like a browser stores: a 200, or any status that carries
      // explicit freshness — which is how a 503 stamped with the read
      // policy came to be replayed.
      const cc = res.headers.get("cache-control") ?? "";
      if (
        mode !== "no-store" &&
        !/no-store/i.test(cc) &&
        (res.status === 200 || maxAgeOf(res.headers) > 0)
      ) {
        store.set(url, res);
      }
      return toResponse(res);
    },
  );
  return { fetch: fetchMock, originRequests, inits };
}

/** A form behind a strong version ETag and If-Match, like the forms API. */
function formsOrigin() {
  let version = 1;
  let status = "draft";
  const etag = () => `"form:f1:v${version}"`;
  const json = (body: unknown, init: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ETag: etag(),
        "Cache-Control": STALE_PRONE_POLICY,
        Vary: "Authorization, Cookie, Accept-Encoding",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return (url: string, init: RequestInit): Response => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (!url.endsWith("/api/v1/forms/f1")) {
      return new Response("not found", { status: 404 });
    }
    if (method === "GET") {
      if (headers.get("If-None-Match") === etag()) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag(), "Cache-Control": STALE_PRONE_POLICY },
        });
      }
      return json({ id: "f1", status }, { status: 200 });
    }
    if (headers.get("If-Match") !== etag()) {
      return new Response(
        JSON.stringify({
          error: {
            code: "precondition_failed",
            message:
              "the resource was modified since you last loaded it; reload and retry",
          },
        }),
        { status: 412, headers: { "Content-Type": "application/json" } },
      );
    }
    status = (JSON.parse(String(init.body)) as { status: string }).status;
    version += 1;
    return json({ id: "f1", status }, { status: 200 });
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser reads revalidate with the server", () => {
  it("Publish then Save: the refetch carries the published form and its new ETag, so the save is accepted", async () => {
    const browser = modelBrowserFetch(formsOrigin());
    vi.stubGlobal("fetch", browser.fetch);

    expect((await getForm("f1")).status).toBe("draft");
    await updateForm("f1", { status: "published" }, { requireOnline: true });

    // The editor's invalidation refetch, then a Save straight after Publish,
    // which echoes the ETag that refetch captured.
    const refetched = await getForm("f1");
    const save = await updateForm(
      "f1",
      { status: "published" },
      { requireOnline: true },
    ).then(
      () => "accepted",
      (error: { status?: number; message?: string }) =>
        `refused ${error.status}: ${error.message}`,
    );
    expect({ refetched: refetched.status, save }).toEqual({
      refetched: "published",
      save: "accepted",
    });
    expect(
      browser.originRequests.filter((r) => r === "GET /api/v1/forms/f1"),
    ).toHaveLength(2);
  });

  it("an unchanged read revalidates to a 304 and keeps the stored body", async () => {
    const browser = modelBrowserFetch(formsOrigin());
    vi.stubGlobal("fetch", browser.fetch);

    await getForm("f1");
    await expect(getForm("f1")).resolves.toMatchObject({ status: "draft" });
    expect(browser.originRequests).toEqual([
      "GET /api/v1/forms/f1",
      "GET /api/v1/forms/f1",
    ]);
  });

  it("reads ask with no-cache; a caller's own mode and every write are left alone", async () => {
    const browser = modelBrowserFetch(() =>
      Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }),
    );
    vi.stubGlobal("fetch", browser.fetch);

    await api.get("/api/v1/lists", { maxAttempts: 1 });
    await api.head("/api/v1/lists", { maxAttempts: 1 });
    await api.get("/api/v1/auth/me", { cache: "no-store", maxAttempts: 1 });
    await api.post("/api/v1/lists", { name: "x" }, { maxAttempts: 1 });
    await api.patch("/api/v1/lists/1", { name: "y" }, { maxAttempts: 1 });
    await api.delete("/api/v1/lists/1", { maxAttempts: 1 });

    expect(browser.inits.map((init) => [init.method, init.cache])).toEqual([
      ["GET", "no-cache"],
      ["HEAD", "no-cache"],
      ["GET", "no-store"],
      ["POST", undefined],
      ["PATCH", undefined],
      ["DELETE", undefined],
    ]);
  });
});

describe("browser retries reach the network (SP-B4)", () => {
  it("a retried read is not answered with the stored failure it is retrying", async () => {
    // The outage response carries freshness, as the API's did before its
    // error responses became no-store; the upstream recovers before the retry.
    let upstreamUp = false;
    const browser = modelBrowserFetch(() => {
      const res = upstreamUp
        ? Response.json(
            { reputation: "good" },
            { headers: { "Cache-Control": STALE_PRONE_POLICY } },
          )
        : Response.json(
            { error: { code: "upstream_unavailable" } },
            { status: 503, headers: { "Cache-Control": STALE_PRONE_POLICY } },
          );
      upstreamUp = true;
      return res;
    });
    vi.stubGlobal("fetch", browser.fetch);
    vi.spyOn(Math, "random").mockReturnValue(0);

    // A caller that lets the HTTP cache participate on the first attempt.
    const result = await httpFetch(
      "/api/v1/reputation",
      { method: "GET", cache: "default" },
      { maxAttempts: 3 },
    );

    expect(result.res?.status).toBe(200);
    expect(browser.originRequests).toEqual([
      "GET /api/v1/reputation",
      "GET /api/v1/reputation",
    ]);
    expect(browser.inits.map((init) => init.cache)).toEqual([
      "default",
      "no-store",
    ]);
  });

  it("a replayed write keeps its init: the HTTP cache never answers one", async () => {
    let attempts = 0;
    const browser = modelBrowserFetch(() =>
      attempts++ === 0
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", browser.fetch);
    vi.spyOn(Math, "random").mockReturnValue(0);

    await httpFetch(
      "/api/v1/lists",
      { method: "POST", headers: { "Idempotency-Key": "k1" }, body: "{}" },
      { maxAttempts: 2 },
    );
    expect(browser.inits.map((init) => init.cache)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
