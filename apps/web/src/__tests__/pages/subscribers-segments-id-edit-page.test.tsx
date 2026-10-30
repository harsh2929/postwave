// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /subscribers/segments/[id]/edit. Completes the mount suite to every dashboard page.
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
  usePathname: () => "/app/subscribers/segments/[id]/edit",
  useSearchParams: () => new URLSearchParams(),
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

describe("subscribers/segments/[id]/edit page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/subscribers/segments/[id]/edit/page")).default;
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
