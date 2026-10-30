// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /retention. Generated against the page's own <h1>.
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

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

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
  whoami: mocks.whoami,
}));

beforeEach(() => {
  mocks.whoami.mockReset().mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retention page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/retention/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Win-back");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it.each([
    {
      name: "editor",
      identity: {
        ...WHOAMI,
        role: "editor" as const,
        effective_role: "editor" as const,
      },
    },
    {
      name: "owner in viewer mode",
      identity: {
        ...WHOAMI,
        role: "owner" as const,
        effective_role: "viewer" as const,
        viewer_mode: true,
      },
    },
  ])(
    "shows a scope notice and makes zero retention requests for $name",
    async ({ identity }) => {
      mocks.whoami.mockResolvedValue(identity);
      const Page = (await import("@/app/(dashboard)/app/retention/page"))
        .default;
      const { text, root } = await renderPage(Page);
      try {
        expect(text).toContain("Owner or admin access required");
        expect(text).toContain("were not requested");
        const requested = vi
          .mocked(globalThis.fetch)
          .mock.calls.map(([input]) => String(input));
        expect(
          requested.filter((url) => url.includes("/api/v1/retention-offers")),
        ).toEqual([]);
      } finally {
        unmount(root);
      }
    },
  );

  it("issues all three protected reads for an owner outside viewer mode", async () => {
    const Page = (await import("@/app/(dashboard)/app/retention/page")).default;
    const { root } = await renderPage(Page);
    try {
      const requested = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([input]) => String(input));
      expect(
        requested.filter((url) => url.includes("/api/v1/retention-offers")),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("/api/v1/retention-offers/winback-settings"),
          expect.stringMatching(/\/api\/v1\/retention-offers$/u),
          expect.stringContaining("/api/v1/retention-offers/funnel"),
        ]),
      );
    } finally {
      unmount(root);
    }
  });
});
