// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /reporting-catalogue. Generated against the page's own <h1>.
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

const identityControl = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn(async () => {
    if (identityControl.fail) throw new Error("Identity unavailable");
    return WHOAMI;
  }),
}));

beforeEach(() => {
  identityControl.fail = false;
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reporting-catalogue page", () => {
  it("does not request reporting data after identity fails", async () => {
    identityControl.fail = true;
    const Page = (
      await import("@/app/(dashboard)/app/reporting-catalogue/page")
    ).default;
    const { text, root } = await renderPage(Page);
    try {
      expect(text).toContain("Workspace identity could not be verified");
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes("/reporting/")),
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("includes unrecognized metric states in its coverage counts", async () => {
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/reporting/metric-registry"))
          return new Response(
            JSON.stringify({
              items: [
                {
                  key: "future.metric",
                  label: "Future metric",
                  runtime_status: "future",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return original(input, init);
      }),
    );
    const Page = (
      await import("@/app/(dashboard)/app/reporting-catalogue/page")
    ).default;
    const { text, root } = await renderPage(Page);
    try {
      expect(text).toContain("1 with status not reported");
      expect(text).toContain("Status not reported");
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/reporting-catalogue/page")
    ).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Reporting catalogue");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
