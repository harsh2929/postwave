// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /discounts/coupon-pools/[id].
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
  usePathname: () => "/app/discounts/coupon-pools/[id]",
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

describe("discounts/coupon-pools/[id] page", () => {
  it("shows the held boundary and only truthful archive capabilities", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/discounts/coupon-pools/[id]/page")
    ).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectMounted(text);
      expect(text).toContain("Coupon pools are release-held");
      expect(text).toContain("Available historical archive");
      expect(text).toContain("PII-free event timing");
      expect(text).toContain("Back to discount history");
      for (const staleClaim of [
        "Existing-code inspection",
        "live checks",
        "CSV export",
        "cap/expiry edits",
        "deletion for admins",
        "mounted discount tools",
      ]) {
        expect(text).not.toContain(staleClaim);
      }
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
