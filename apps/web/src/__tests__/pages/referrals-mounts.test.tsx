// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// commerce-48 — the window-chip leaderboard is the leaderboard on the
// /app/referrals overview: the page reads the default window, switching a chip
// issues that window's read, and the page-level Refresh re-reads the active
// window rather than a separate unscoped leaderboard.
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/referrals",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("referrals — leaderboard window chips (commerce-48)", () => {
  it("reads the leaderboard per window from the overview", async () => {
    const { calls } = recordingTransport((req) => {
      if (req.method !== "GET" || req.path !== "/api/v1/referrals/leaderboard") {
        return undefined;
      }
      const window = req.query.get("window");
      const days = window === "30d" ? 30 : window === "365d" ? 365 : 90;
      return {
        body: {
          window_days: days,
          items: [
            {
              rank: 1,
              referrer_email_masked: `top-${window}@*****.test`,
              conversions: 7,
              milestone: 5,
            },
          ],
        },
      };
    });
    const leaderboardReads = () =>
      calls
        .filter((c) => c.path === "/api/v1/referrals/leaderboard")
        .map((c) => c.query.get("window"));

    // /app/referrals is a next/dynamic wrapper around this module; the
    // wrapper's own mount is covered by referrals-page.test.tsx.
    const Page = (await import("@/app/(dashboard)/app/referrals/page-client"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(leaderboardReads()).toEqual(["90d"]);
      const group = container.querySelector(
        '[role="group"][aria-label="Leaderboard window"]',
      );
      expect(group).not.toBeNull();
      expect(container.textContent).toContain("top-90d@*****.test");

      await clickEl(buttonByText(group!, "Show conversions from the last 30 days"));
      await settle();
      expect(leaderboardReads()).toEqual(["90d", "30d"]);
      expect(container.textContent).toContain("top-30d@*****.test");

      const header = container.querySelector("header")!;
      const refresh = [...header.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Refresh",
      );
      expect(refresh).toBeDefined();
      await clickEl(refresh);
      await settle();
      expect(leaderboardReads()).toEqual(["90d", "30d", "30d"]);
    } finally {
      unmount(root);
    }
  });
});
