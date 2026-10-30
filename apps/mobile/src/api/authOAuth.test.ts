import { describe, expect, it } from "vitest";

import { classifyOAuthStartResponse, probeOAuthStart } from "./authOAuth";

const START = "https://api.moosewave.com/api/v1/auth/oauth/google/start";

describe("classifyOAuthStartResponse", () => {
  it("reports provider_disabled only for a 404 that stayed on our origin", () => {
    expect(classifyOAuthStartResponse(START, 404, START)).toEqual({
      ok: false,
      reason: "provider_disabled",
    });
    expect(classifyOAuthStartResponse(START, 404, "")).toEqual({
      ok: false,
      reason: "provider_disabled",
    });
  });

  it("treats a redirect to the identity provider as configured, even on a 404", () => {
    // React Native follows redirects, so a configured provider resolves at
    // Google. A 404 from THEIR host says nothing about our deployment.
    expect(
      classifyOAuthStartResponse(
        START,
        404,
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      ),
    ).toEqual({ ok: true });
    expect(
      classifyOAuthStartResponse(
        START,
        200,
        "https://accounts.google.com/v3/signin/identifier",
      ),
    ).toEqual({ ok: true });
  });

  it("separates a server fault from a disabled provider", () => {
    expect(classifyOAuthStartResponse(START, 502, START)).toEqual({
      ok: false,
      reason: "server",
    });
    expect(classifyOAuthStartResponse(START, 200, START)).toEqual({ ok: true });
  });
});

describe("probeOAuthStart", () => {
  it("classifies a same-origin 404 as a disabled provider", async () => {
    const result = await probeOAuthStart(START, {
      fetchImpl: (async () =>
        ({ status: 404, url: START }) as unknown as Response) as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "provider_disabled" });
  });

  it("returns a network reason when the transport throws", async () => {
    const result = await probeOAuthStart(START, {
      fetchImpl: (async () => {
        throw new TypeError("Network request failed");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it("returns a timeout reason when the probe outlives its budget", async () => {
    const result = await probeOAuthStart(START, {
      timeoutMs: 1,
      fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("fails closed to a network reason when the runtime has no fetch", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error — deliberately simulating a runtime without fetch.
    delete globalThis.fetch;
    try {
      expect(await probeOAuthStart(START)).toEqual({
        ok: false,
        reason: "network",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
