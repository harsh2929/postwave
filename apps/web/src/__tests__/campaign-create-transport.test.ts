// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A campaign create is one request. It carries no server-side idempotency, so
// a retried POST can mint a second draft, and the retries are what left the
// New campaign dialog on "Creating…" for most of a minute whenever the API or
// its proxy stalled. Driven through the real transport against a stubbed
// fetch.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mock-mode", () => ({ isMockModeEnabled: () => false }));

import { createCampaign } from "@/lib/campaigns-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign create transport", () => {
  it("sends one POST and reports the failure, without retrying", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "POST") posts.push(url);
        return new Response(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "an internal error occurred",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(
      createCampaign({ name: "Launch", subject: "Hello" }),
    ).rejects.toThrow();
    expect(
      posts.filter((url) => url.endsWith("/api/v1/campaigns")),
    ).toHaveLength(1);
  });
});
