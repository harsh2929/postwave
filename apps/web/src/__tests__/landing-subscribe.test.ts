import { afterEach, describe, expect, it, vi } from "vitest";

import { submitLandingConversion } from "@/lib/landing-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitLandingConversion", () => {
  it("posts conversion metadata to the public landing endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitLandingConversion("welcome/list", "reader@example.com"),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/public/landing-pages/welcome%2Flist/convert");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "reader@example.com",
      metadata: { source: "hosted_landing_page" },
    });
  });

  it("returns false instead of throwing on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      submitLandingConversion("launch", "reader@example.com"),
    ).resolves.toBe(false);
  });
});
