// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /developer-reference. Generated against the page's own <h1>.
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
  mocks.whoami.mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("developer-reference page", () => {
  it.each([
    { name: "owner", identity: WHOAMI },
    {
      name: "admin",
      identity: {
        ...WHOAMI,
        role: "admin" as const,
        effective_role: "admin" as const,
      },
    },
  ])("loads the protected catalog for $name", async ({ identity }) => {
    mocks.whoami.mockResolvedValue(identity);
    const Page = (
      await import("@/app/(dashboard)/app/developer-reference/page")
    ).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Developer reference");
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) =>
            requestedUrl(input).includes(
              "/api/v1/outbound-webhooks/playground/events",
            ),
          ),
      ).toBe(true);
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
      name: "viewer",
      identity: {
        ...WHOAMI,
        role: "viewer" as const,
        effective_role: "viewer" as const,
      },
    },
    {
      name: "editor",
      identity: {
        ...WHOAMI,
        role: "editor" as const,
        effective_role: "editor" as const,
      },
    },
    {
      name: "owner using View as viewer",
      identity: {
        ...WHOAMI,
        viewer_mode: true,
      },
    },
  ])("makes no protected catalog request for $name", async ({ identity }) => {
    mocks.whoami.mockResolvedValue(identity);
    const Page = (
      await import("@/app/(dashboard)/app/developer-reference/page")
    ).default;
    const { text, root } = await renderPage(Page);
    try {
      expectRendered(text, "admin-only live diagnostic");
      const requested = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => requestedUrl(input));
      expect(requested.length).toBeGreaterThan(0);
      expect(
        requested.some((url) =>
          url.includes("/api/v1/outbound-webhooks/playground/events"),
        ),
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
