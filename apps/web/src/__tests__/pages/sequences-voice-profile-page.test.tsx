// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /sequences/voice-profile. Completes the mount suite to every dashboard page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/sequences/voice-profile",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

// The page imports @/lib/voice-api on first use (page.tsx keeps it out of the
// route's eager chunk) and shows only skeletons while it loads, which
// renderPage cannot tell from a settled page. Pay that import in a hook, and
// wait for the load to finish before pressing anything. Otherwise the load
// finished after the test, and its two requests reached the real network
// once afterEach had removed the stubbed transport.
importBeforeTests(
  () => import("@/lib/voice-api"),
  () => import("@/app/(dashboard)/app/sequences/voice-profile/page"),
);

/** The page's build action, which stays disabled until the first load ends. */
function buildButton(container: HTMLElement): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (button) => /^(Build|Rebuild) profile$/.test(button.textContent?.trim() ?? ""),
  );
  if (!found) throw new Error("No Build profile / Rebuild profile button");
  return found;
}

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sequences/voice-profile page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/sequences/voice-profile/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Voice profile");
      await waitFor(() => expect(buildButton(container).disabled).toBe(false));
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
