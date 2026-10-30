// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /ai-assist. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import {
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

describe("ai-assist page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/ai-assist/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "AI assist");
      const brief =
        container.querySelector<HTMLTextAreaElement>("#ai-compose-brief");
      expect(brief).not.toBeNull();
      await act(async () => {
        if (!brief) return;
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(brief, "");
        brief.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const buttonNamed = (name: string) =>
        [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) =>
            button.getAttribute("role") !== "tab" &&
            button.textContent?.trim() === name,
        );
      const activateTab = async (name: string) => {
        const trigger = [
          ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        ].find((button) => button.textContent?.trim() === name);
        expect(trigger).not.toBeUndefined();
        await act(async () => {
          trigger?.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      expect(buttonNamed("Generate broadcast")?.disabled).toBe(true);
      // These endpoints do not consume the email brief, so an empty brief
      // must not strand their otherwise valid actions.
      await activateTab("Ask analytics");
      expect(buttonNamed("Ask analytics")?.disabled).toBe(false);
      await activateTab("Anomaly brief");
      expect(buttonNamed("Generate anomaly brief")?.disabled).toBe(false);
      await activateTab("Voice drift");
      expect(buttonNamed("Check voice drift")?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
