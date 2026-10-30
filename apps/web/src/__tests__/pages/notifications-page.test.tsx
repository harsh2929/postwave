// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /notifications. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

vi.mock("next/navigation", () => ({
  // Pages that call useRouter/usePathname throw "invariant expected app router
  // to be mounted" outside a Next app shell. The smoke test asks whether the
  // page renders, not whether navigation works, so the router is stubbed to
  // the same shape the repo's other render tests use.
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

async function pressTab(target: HTMLButtonElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("notifications page", () => {
  it("uses a named roving tablist for notification filters", async () => {
    const Page = (await import("@/app/(dashboard)/app/notifications/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const list = container.querySelector('[role="tablist"]');
      const tabs = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      );

      expect(list?.getAttribute("aria-label")).toBe("Filter notifications");
      expect(tabs).toHaveLength(2);
      expect((list as HTMLElement | null)?.tabIndex).toBe(0);
      expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1]);
      await act(async () => {
        tabs[0].focus();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);

      await pressTab(tabs[0], "ArrowRight");
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");
      expect(
        container
          .querySelector('[role="tabpanel"]')
          ?.getAttribute("aria-labelledby"),
      ).toBe(tabs[1].id);

      await pressTab(tabs[1], "Home");
      expect(document.activeElement).toBe(tabs[0]);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");

      await pressTab(tabs[0], "End");
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/notifications/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Notifications");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
