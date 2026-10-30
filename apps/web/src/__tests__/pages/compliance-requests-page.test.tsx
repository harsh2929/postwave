// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /compliance-requests. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const mocks = vi.hoisted(() => ({
  listSarRequests: vi.fn(),
  whoami: vi.fn(),
}));

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

vi.mock("@/lib/compliance-requests-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/compliance-requests-api")
  >()),
  listSarRequests: mocks.listSarRequests,
}));

beforeEach(() => {
  mocks.whoami.mockReset().mockResolvedValue(WHOAMI);
  mocks.listSarRequests.mockReset().mockResolvedValue([]);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compliance-requests page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/compliance-requests/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Requests and reports");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not fetch personal SAR inventory in viewer mode", async () => {
    mocks.whoami.mockResolvedValue({
      ...WHOAMI,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const Page = (await import("@/app/(dashboard)/app/compliance-requests/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain("inventory was not fetched");
      expect(container.textContent).not.toContain("New access request");
      const refresh = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Refresh workspace"),
      );
      await act(async () => {
        refresh?.click();
        await Promise.resolve();
      });
      expect(mocks.listSarRequests).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
