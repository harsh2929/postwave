// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /verification. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const authMocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("next/navigation", () => ({
  // Pages that call useRouter/usePathname throw "invariant expected app router
  // to be mounted" outside a Next app shell. The smoke test asks whether the
  // page renders, not whether navigation works, so the router is stubbed to
  // the same shape the repo's other render tests use.
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: authMocks.whoami,
}));

beforeEach(() => {
  authMocks.whoami.mockReset();
  authMocks.whoami.mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verification page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/verification/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Email verification");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not query admin configuration for a viewer", async () => {
    authMocks.whoami.mockResolvedValue({
      ...WHOAMI,
      role: "viewer",
      effective_role: "viewer",
    });
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const path = new URL(raw, "http://postwave.test").pathname;
        requested.push(path);
        const body =
          path === "/api/v1/verification/jobs"
            ? { jobs: [] }
            : path === "/api/v1/verification/cache"
              ? { total: 0, by_status: {}, expiring_within_7d: 0 }
              : {
                  usage: [],
                  totals: {
                    verified: 0,
                    credits_spent: 0,
                    local_filtered: 0,
                    cache_hits: 0,
                    credits_saved: 0,
                  },
                  provider: null,
                  balance: null,
                  note: "Local checks only.",
                };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/verification/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "Admin-only. Provider configuration is hidden",
      );
      expect(container.textContent).toContain(
        "Admin-only. Verification enforcement policy is hidden",
      );
      expect(requested).not.toContain("/api/v1/verification/providers");
      expect(requested).not.toContain("/api/v1/verification/policy");
    } finally {
      unmount(root);
    }
  });
});
