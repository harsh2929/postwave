// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke render for the opaque `/discounts/[id]` archive route.
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
  usePathname: () => "/app/discounts/11111111-2222-4333-8444-555555555555",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "11111111-2222-4333-8444-555555555555" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => stubFixtureTransport());
afterEach(() => vi.unstubAllGlobals());

describe("discounts/[id] page", () => {
  it("mounts without reverting to a code lookup", async () => {
    const Page = (await import("@/app/(dashboard)/app/discounts/[id]/page"))
      .default;
    const { text, container, root } = await renderPage(Page, {
      params: Promise.resolve({
        id: "11111111-2222-4333-8444-555555555555",
      }),
    });
    try {
      expectMounted(text);
      expect(text).not.toContain("Live check");
      expect(text).not.toContain("CSV export");
      expect(text).not.toContain("Delete discount");
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
