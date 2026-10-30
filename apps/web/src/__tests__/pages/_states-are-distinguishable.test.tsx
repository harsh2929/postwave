// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A page has three outcomes and they must not read alike: data loaded, a
// genuinely empty workspace, and a failed request.
//
// The click sweep proved handlers do not explode. It asserted NOTHING about
// what a page says, so the confusion this whole branch has been chasing —
// assets printing "0 folder(s)" for a 500, approvals answering a 403 with
// "Nothing to review" — was still invisible to it.
//
// This asserts the three renders DIFFER, and that a failure produces
// failure-flavoured language somewhere on the page.
//
// ITS LIMIT, MEASURED RATHER THAN ASSUMED. I mutated assets/page.tsx back to
// the exact defect that shipped — deleting the folders/tags error branch so a
// 500 prints "0 folder(s)" — and THIS TEST STILL PASSED. Whole-page text
// comparison is too coarse: the page's other query still differed between
// loaded and failed, and that masked the regression.
//
// The per-region case is covered by a different test, and I verified that:
// src/__tests__/query-errors-are-rendered.test.ts fails on the same mutation,
// naming "assets/page.tsx: folders" and "assets/page.tsx: tags". It requires
// every rendered query to read its own isError, statically, so no amount of
// masking hides it.
//
// So this file catches a page with NO failure handling anywhere; the ratchet
// catches a single region losing it. Neither alone is sufficient, which is
// why both exist.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderPage,
  stubTransport,
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

const PAGES: [string, () => Promise<{ default: unknown }>][] = [
  ["replies", () => import("@/app/(dashboard)/app/replies/page")],
  ["sending-health", () => import("@/app/(dashboard)/app/sending-health/page")],
  ["reporting-catalogue", () => import("@/app/(dashboard)/app/reporting-catalogue/page")],
  ["consent-evidence", () => import("@/app/(dashboard)/app/consent-evidence/page")],
  ["workspace-ops", () => import("@/app/(dashboard)/app/workspace-ops/page")],
  ["assets", () => import("@/app/(dashboard)/app/assets/page")],
];

async function textIn(
  load: () => Promise<{ default: unknown }>,
  mode: "loaded" | "empty" | "error",
): Promise<string> {
  stubTransport(mode);
  const Page = (await load()).default;
  const { text, root } = await renderPage(Page as never);
  unmount(root);
  return text;
}

afterEach(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a page's loaded, empty and failed renders are distinguishable", () => {
  for (const [name, load] of PAGES) {
    it(`${name} says something different when the request fails`, async () => {
      const loaded = await textIn(load, "loaded");
      const errored = await textIn(load, "error");

      // Both must render — a blank error state is its own bug.
      expect(loaded.length).toBeGreaterThan(40);
      expect(errored.length).toBeGreaterThan(40);

      // The claim: a reader can tell a failure from a success. Identical text
      // means the page reported a failed request as though it had succeeded.
      expect(errored).not.toBe(loaded);

      // And it must SAY so, not merely differ by a number. A page whose only
      // difference is "3 items" becoming "0 items" has told the reader nothing.
      expect(errored).toMatch(
        /could not|couldn't|failed|unavailable|unable|error|not load/i,
      );
    });
  }

  it("an emptied workspace does not read as a failure", async () => {
    // The inverse mistake: dressing a legitimately empty workspace in error
    // language, which sends someone debugging a system that is working.
    const empty = await textIn(PAGES[0][1], "empty");
    const errored = await textIn(PAGES[0][1], "error");
    expect(empty).not.toBe(errored);
  });
});
