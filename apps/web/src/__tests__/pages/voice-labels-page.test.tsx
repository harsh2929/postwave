// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /voice-labels. Completes the mount suite to every dashboard page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import {
  clickEveryControl,
  expectRendered,
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
  usePathname: () => "/app/voice-labels",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

const { whoamiMock } = vi.hoisted(() => ({ whoamiMock: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: whoamiMock,
}));

beforeEach(() => {
  whoamiMock.mockReset().mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice-labels page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/voice-labels/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Voice labels");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not misreport a failed access check as an admin-role denial", async () => {
    whoamiMock.mockRejectedValueOnce(new Error("identity service offline"));
    const Page = (await import("@/app/(dashboard)/app/voice-labels/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain("Access check failed");
      expect(container.textContent).not.toContain(
        "Voice labeling is admin-only",
      );
      expect(container.querySelector('[role="alert"]')).not.toBeNull();

      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => {
        retry?.click();
        for (let turn = 0; turn < 6; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      expect(container.textContent).toContain("Submit a label");
    } finally {
      unmount(root);
    }
  });
});
