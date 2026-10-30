// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /subscribers/segments/new. Completes the mount suite to every dashboard page.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const mocks = vi.hoisted(() => ({
  createSegment: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    message: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/segments-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/segments-api")>()),
  createSegment: mocks.createSegment,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/segments/new",
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
  mocks.createSegment.mockRejectedValue(
    new Error("Segment transport unavailable."),
  );
  window.history.replaceState({}, "", "/app/subscribers/segments/new");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("subscribers/segments/new page", () => {
  it("keeps client validation inline without raising a duplicate toast", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/segments/new/page")
    ).default;
    const { container, root } = await renderPage(Page);
    try {
      const create = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Create segment",
      );
      await act(async () => create?.click());

      expect(
        Array.from(container.querySelectorAll('[role="alert"]')).some((alert) =>
          alert.textContent?.includes("Name is required"),
        ),
      ).toBe(true);
      expect(mocks.createSegment).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("retains the inline alert and toast for an asynchronous save failure", async () => {
    window.history.replaceState(
      {},
      "",
      "/app/subscribers/segments/new?seedName=Ready%20segment&seedField=email&seedComparator=contains&seedValue=%40",
    );
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/segments/new/page")
    ).default;
    const { container, root } = await renderPage(Page);
    try {
      const create = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Create segment",
      );
      await act(async () => {
        create?.click();
        await Promise.resolve();
      });

      expect(mocks.createSegment).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Segment transport unavailable.",
      );
      expect(container.textContent).toContain("Segment transport unavailable.");
    } finally {
      unmount(root);
    }
  });

  it("mounts without crashing", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/segments/new/page")
    ).default;
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
