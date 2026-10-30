// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /settings/developer.
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
  usePathname: () => "/app/settings/developer",
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

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings/developer page", () => {
  it("loads real key-management mutation events without inventing an API-key actor type", async () => {
    const audit = await import("@/lib/audit-api");
    const list = vi.spyOn(audit, "listAuditLog").mockResolvedValue({
      rows: [
        {
          id: 1,
          action: "http.post.api.v1.api-keys",
          actorType: "human",
          at: "2026-10-25T01:00:00Z",
          metadata: {},
        },
      ],
    });
    const Page = (await import("@/app/(dashboard)/app/settings/developer/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(list).toHaveBeenCalledWith({
        action: ".api.v1.api-keys",
        limit: 8,
      });
      expect(container.textContent).toContain("Recent API-key changes");
      expect(container.textContent).toContain("http.post.api.v1.api-keys");
      expect(
        container.querySelector('a[href="/app/api-usage"]'),
      ).not.toBeNull();
    } finally {
      unmount(root);
      list.mockRestore();
    }
  });

  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/developer/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
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
