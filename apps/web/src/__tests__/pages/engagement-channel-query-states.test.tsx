// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubTransport, unmount, WHOAMI } from "./_harness";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

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
  whoami: mocks.whoami,
}));

type PageModule = { default: ComponentType };

const routes: Array<[string, string, () => Promise<PageModule>]> = [
  ["cohorts", "Cohorts", () => import("@/app/(dashboard)/app/cohorts/page")],
  [
    "lifecycle",
    "Lifecycle",
    () => import("@/app/(dashboard)/app/lifecycle/page"),
  ],
  [
    "predictive",
    "Predictive",
    () => import("@/app/(dashboard)/app/predictive/page"),
  ],
  [
    "scoring",
    "Scoring and tags",
    () => import("@/app/(dashboard)/app/scoring/page"),
  ],
  [
    "retention",
    "Win-back",
    () => import("@/app/(dashboard)/app/retention/page"),
  ],
  ["replies", "Replies", () => import("@/app/(dashboard)/app/replies/page")],
  ["routing", "Routing", () => import("@/app/(dashboard)/app/routing/page")],
  [
    "signup protection",
    "Signup protection",
    () => import("@/app/(dashboard)/app/signup-protection/page"),
  ],
  ["reviews", "Reviews", () => import("@/app/(dashboard)/app/reviews/page")],
  [
    "archive settings",
    "Archive settings",
    () => import("@/app/(dashboard)/app/archive-settings/page"),
  ],
];

beforeEach(() => {
  mocks.whoami.mockReset();
  mocks.whoami.mockResolvedValue(WHOAMI);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engagement and channel route query failures", () => {
  it.each(routes)(
    "%s distinguishes failed reads from empty data and offers recovery",
    async (_route, heading, loadPage) => {
      stubTransport("error");
      const Page = (await loadPage()).default;
      const { container, root, text } = await renderPage(Page);
      try {
        expect(text).toContain(heading);
        expect(
          container.querySelectorAll('[role="alert"]').length,
        ).toBeGreaterThan(0);
        expect(
          [...container.querySelectorAll("button")].some((button) =>
            /retry/i.test(button.textContent ?? ""),
          ),
        ).toBe(true);
      } finally {
        unmount(root);
      }
    },
  );

  it("does not request tenant data when workspace identity fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("session unavailable"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const Page = (await import("@/app/(dashboard)/app/scoring/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "Workspace access could not be verified",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
