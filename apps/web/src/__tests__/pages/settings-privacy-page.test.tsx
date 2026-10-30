// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /settings/privacy.
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
  usePathname: () => "/app/settings/privacy",
  useSearchParams: () => new URLSearchParams(),
  // Dynamic routes read their id from here; a plausible uuid keeps downstream
  // validation happy without pretending the record exists.
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

// happy-dom does not hydrate Next's `{ ssr: false }` loader. Mount the real
// deferred cards so this smoke/click test continues to cover their controls.
vi.mock("next/dynamic", async () => {
  const [{ ExportRetentionPolicyCard }, { WorkspaceExportsCard }] =
    await Promise.all([
      import("@/components/settings/export-retention-policy-card"),
      import("@/components/settings/workspace-exports-card"),
    ]);
  const deferredCards = [ExportRetentionPolicyCard, WorkspaceExportsCard];
  let nextBoundary = 0;

  return {
    default: () => {
      const DeferredCard = deferredCards[nextBoundary];
      nextBoundary += 1;
      return DeferredCard ?? (() => null);
    },
  };
});

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings/privacy page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/privacy/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectMounted(text);
      expect(container.textContent).toContain("Export retention & capacity");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
