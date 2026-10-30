// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /flows. Generated against the page's own <h1>.
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
  stubFixtureTransport();
  authMocks.whoami.mockResolvedValue(WHOAMI);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("flows page", () => {
  it("keeps viewer sessions read-only without hiding Flow reads", async () => {
    authMocks.whoami.mockResolvedValueOnce({
      ...WHOAMI,
      role: "viewer",
      effective_role: "viewer",
      viewer_mode: false,
    });
    const Page = (await import("@/app/(dashboard)/app/flows/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Flows");
      expect(text).toContain("Flows are read-only for this session");
      const create = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("New flow"),
      );
      expect(create?.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/flows/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Flows");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
