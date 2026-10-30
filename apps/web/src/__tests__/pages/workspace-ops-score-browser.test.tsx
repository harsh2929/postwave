// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity row audience-41 — "Browse by score" is live on /app/workspace-ops,
// under the engagement distribution it browses: mounts the real page over the
// real transport (global fetch stubbed) and follows a bucket to the scored
// subscribers in it.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/workspace-ops",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(WHOAMI),
  };
});

import { renderPage, unmount } from "./_harness";

const requests: URL[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      requests.push(url);
      if (url.pathname === "/api/v1/engagement-scores/distribution")
        return json({ buckets: [{ range: "61..88", min: 61, max: 88, count: 12 }] });
      if (url.pathname === "/api/v1/engagement-scores/subscribers")
        return json({
          items: [{ id: "sub-77", email: "top@example.com", score: 88 }],
          page: 1,
          per_page: 25,
          total: 1,
        });
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace-ops browse by score", () => {
  it("lists the subscribers in a clicked bucket and links each to its profile", async () => {
    const Page = (await import("@/app/(dashboard)/app/workspace-ops/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      // The score browser is a next/dynamic chunk; give it a bounded moment
      // to mount before looking for its buckets.
      const findBucket = () =>
        [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "61..88",
        );
      const deadline = Date.now() + 10_000;
      while (!findBucket() && Date.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      const bucket = findBucket();
      if (!bucket) throw new Error("Browse-by-score bucket not rendered");
      await act(async () => {
        bucket.click();
      });
      for (let i = 0; i < 8; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const browse = requests.find(
        (url) => url.pathname === "/api/v1/engagement-scores/subscribers",
      );
      expect(browse?.searchParams.get("min")).toBe("61");
      expect(browse?.searchParams.get("max")).toBe("88");
      expect(browse?.searchParams.get("per_page")).toBe("25");
      const link = [...container.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "top@example.com",
      );
      expect(link?.getAttribute("href")).toBe("/app/subscribers/sub-77");
    } finally {
      unmount(root);
    }
  }, 30_000);
});
