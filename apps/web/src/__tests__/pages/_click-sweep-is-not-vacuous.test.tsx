// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The per-page click sweep asserts `failures` is empty. A page that renders NO
// buttons satisfies that trivially, and so would a broken sweep that clicked
// nothing anywhere — 123 green tests proving nothing.
//
// This is the floor: a representative set of pages must actually expose and
// click a substantial number of controls. If the sweep silently stops working,
// this fails even though every per-page test still passes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
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
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
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

describe("the click sweep exercises real controls", () => {
  it("clicks a substantial number across representative pages", async () => {
    const pages: [string, () => Promise<{ default: unknown }>][] = [
      ["maintenance", () => import("@/app/(dashboard)/app/maintenance/page")],
      ["preflight", () => import("@/app/(dashboard)/app/preflight/page")],
      ["subscribers", () => import("@/app/(dashboard)/app/subscribers/page")],
      ["campaigns", () => import("@/app/(dashboard)/app/campaigns/page")],
      ["suppressions", () => import("@/app/(dashboard)/app/suppressions/page")],
    ];

    let total = 0;
    for (const [, load] of pages) {
      const Page = (await load()).default;
      const { container, root } = await renderPage(Page as never);
      const { clicked } = await clickEveryControl(container);
      total += clicked;
      unmount(root);
    }

    // Measured at ~50 across these five when written. The floor is set well
    // below that so ordinary UI churn does not trip it, while a sweep that
    // degrades to nothing does.
    expect(total).toBeGreaterThan(20);
  }, 30_000);
});
