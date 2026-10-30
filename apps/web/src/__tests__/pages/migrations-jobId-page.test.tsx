// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /migrations/[jobId].
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

const authMocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/migrations/[jobId]",
  useSearchParams: () => new URLSearchParams(),
  // Dynamic routes read their id from here; a plausible uuid keeps downstream
  // validation happy without pretending the record exists.
  useParams: () => ({ jobId: "11111111-2222-3333-4444-555555555555" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: authMocks.whoami,
}));

beforeEach(() => {
  authMocks.whoami.mockReset();
  authMocks.whoami.mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migrations/[jobId] page", () => {
  it("does not request migration records for viewer mode", async () => {
    authMocks.whoami.mockResolvedValue({
      ...WHOAMI,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    const { text, root } = await renderPage(Page, {
      params: Promise.resolve({
        jobId: "11111111-2222-3333-4444-555555555555",
      }),
    });
    try {
      expect(text).toContain("Admin access required");
      expect(text).toContain("No migration data was requested");
      const requests = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input));
      expect(requests.some((url) => url.includes("/api/v1/migrations"))).toBe(
        false,
      );
    } finally {
      unmount(root);
    }
  });

  it("reports an identity failure without requesting migration records", async () => {
    authMocks.whoami.mockRejectedValue(new Error("identity unavailable"));
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    const { text, root } = await renderPage(Page, {
      params: Promise.resolve({
        jobId: "11111111-2222-3333-4444-555555555555",
      }),
    });
    try {
      expect(text).toContain("Could not verify migration access");
      expect(text).toContain("identity unavailable");
      expect(text).toContain("Retry access check");
      const requests = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input));
      expect(requests.some((url) => url.includes("/api/v1/migrations"))).toBe(
        false,
      );
    } finally {
      unmount(root);
    }
  });

  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    // Next 15 hands a dynamic route its params as a PROMISE, which the
    // page unwraps with use(). Rendering with no props throws inside
    // use() rather than in the page.
    const { text, container, root } = await renderPage(Page, {
      params: Promise.resolve({
        jobId: "11111111-2222-3333-4444-555555555555",
      }),
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
