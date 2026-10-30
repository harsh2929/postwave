// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The Overview page's performance tiles crash when the stats payload is
// missing a metric.
//
// Found by driving the real app against a backend that answered
// /api/v1/dashboard/stats without the 30-day counters. The page threw
//
//   TypeError: Cannot read properties of undefined (reading 'toLocaleString')
//     at PerformanceSnapshot (app/(dashboard)/app/page.tsx)
//
// and took the whole route down — on the app's home page.
//
// `DashboardStats` declares `opens_total_30d: number` as required, but a
// TypeScript type is a compile-time claim about a wire payload it does not
// control. The revenue tile on the same screen already guards with
// `typeof stats.revenue_attributed_30d === "number"`, so the pattern was known;
// the three always-present tiles just never applied it.
//
// A missing counter must render as "—" (the idiom this page already uses for
// `totalCamps == null`), not crash and not print "NaN".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

/**
 * A stats payload shaped like a real one but missing the three 30-day
 * counters — the shape an older API build, a partial projection, or a
 * degraded read replica can legitimately return.
 */
const PARTIAL_STATS = {
  subscribers_total: 1200,
  subscribers_unsubbed_30d: 4,
  campaigns_sent_30d: 7,
  bounces_total_30d: 2,
  // opens_total_30d, clicks_total_30d, subscribers_added_30d deliberately absent
};

function stubStats(stats: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/api/v1/dashboard/stats")) return json(stats);
      if (url.includes("/api/v1/auth/me")) return json(WHOAMI);
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers?.();
  vi.useRealTimers?.();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Overview performance tiles tolerate a partial stats payload", () => {
  it("renders instead of throwing when the 30-day counters are absent", async () => {
    stubStats(PARTIAL_STATS);
    const Page = (await import("@/app/(dashboard)/app/page")).default;
    const { text, root } = await renderPage(Page);
    try {
      // The assertion that matters is that renderPage returned at all: the bug
      // threw during render. Guard it explicitly so a future refactor that
      // swallows the throw into an error boundary still fails here.
      expect(text).not.toMatch(/something went wrong|unexpected error/i);
      // A missing number must never surface as NaN or the word "undefined".
      expect(text).not.toMatch(/\bNaN\b/);
      expect(text).not.toMatch(/\bundefined\b/);
    } finally {
      unmount(root);
    }
  });

  it("still renders when stats is an empty object", async () => {
    // The degenerate case: a 200 with nothing in it. Every tile is unknown.
    stubStats({});
    const Page = (await import("@/app/(dashboard)/app/page")).default;
    const { text, root } = await renderPage(Page);
    try {
      expect(text).not.toMatch(/\bNaN\b/);
      expect(text).not.toMatch(/\bundefined\b/);
    } finally {
      unmount(root);
    }
  });
});
