// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /settings/security.
//
// This page had zero coverage: nothing imported its module, so a crash on
// mount was invisible. Responses come from recorded fixtures; unrecorded
// endpoints answer 404, which every page has a branch for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

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
  usePathname: () => "/app/settings/security",
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

describe("settings/security page", () => {
  it("returns to pristine when a policy draft is restored to its saved value", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/security/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const checkbox = container.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save security settings",
      );
      expect(checkbox).not.toBeNull();
      expect(save?.disabled).toBe(true);
      await act(async () => checkbox!.click());
      expect(save?.disabled).toBe(false);
      await act(async () => checkbox!.click());
      expect(save?.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/security/page"))
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
