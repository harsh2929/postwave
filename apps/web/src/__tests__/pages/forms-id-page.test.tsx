// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /forms/[id].
//
// This page had zero coverage: nothing imported its module, so a crash on
// mount was invisible. Responses come from recorded fixtures; unrecorded
// endpoints answer 404, which every page has a branch for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/forms/[id]",
  useSearchParams: () => new URLSearchParams(),
  // Dynamic routes read their id from here; a plausible uuid keeps downstream
  // validation happy without pretending the record exists.
  useParams: () => ({ id: "11111111-2222-3333-4444-555555555555" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forms/[id] page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/forms/[id]/page")).default;
    // Next 15 hands a dynamic route its params as a PROMISE, which the
      // page unwraps with use(). Rendering with no props throws inside
      // use() rather than in the page.
      const { text, container, root } = await renderPage(Page, {
        params: Promise.resolve({ id: "11111111-2222-3333-4444-555555555555" }),
      });
    try {
      expectMounted(text);
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
