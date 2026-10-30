// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /maintenance. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { act, createElement } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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

const authMocks = vi.hoisted(() => ({
  whoamiFresh: vi.fn(),
  setViewerMode: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: authMocks.whoamiFresh,
  whoamiFresh: authMocks.whoamiFresh,
  setViewerMode: authMocks.setViewerMode,
}));

beforeEach(() => {
  stubFixtureTransport();
  authMocks.whoamiFresh.mockResolvedValue(WHOAMI);
  authMocks.setViewerMode.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maintenance page", () => {
  it("refreshes identity after viewer mode clears the query cache and preserves the session log", async () => {
    const Page = (await import("@/app/(dashboard)/app/maintenance/page"))
      .default;
    let client: QueryClient | null = null;
    function WrappedPage() {
      client = useQueryClient();
      return createElement(Page);
    }
    authMocks.setViewerMode.mockImplementation(async (enabled) => {
      client?.clear();
      const state = {
        viewer_mode: enabled,
        role: "owner",
        effective_role: enabled ? "viewer" : "owner",
      };
      authMocks.whoamiFresh.mockResolvedValue({
        ...WHOAMI,
        ...state,
      } as typeof WHOAMI);
      return state;
    });
    const { container, root } = await renderPage(WrappedPage);
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent === label,
      );
    try {
      await act(async () => {
        button("Enter viewer mode")?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(button("Recompute ratings")?.disabled).toBe(true);
      expect(button("Leave viewer mode")?.disabled).toBe(false);
      expect(container.textContent).toContain("Viewer mode on");
      await act(async () => {
        button("Leave viewer mode")?.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(button("Recompute ratings")?.disabled).toBe(false);
      expect(button("Enter viewer mode")?.disabled).toBe(false);
      expect(container.textContent).toContain("Viewer mode off");
      expect(container.textContent).toContain("Viewer mode on");
    } finally {
      unmount(root);
    }
  });

  it("does not dispatch warehouse work when opening or cancelling its confirmation", async () => {
    const Page = (await import("@/app/(dashboard)/app/maintenance/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      vi.mocked(fetch).mockClear();
      const trigger = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Run due warehouse syncs"),
      );
      expect(trigger).toBeDefined();
      await act(async () => {
        trigger?.click();
      });
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("export workspace data");
      expect(dialog?.textContent).toContain("not a preview");
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) =>
            String(input).includes("/warehouse/runs/due"),
          ),
      ).toBe(false);
      const cancel = Array.from(dialog?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Cancel",
      );
      await act(async () => {
        cancel?.click();
      });
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) =>
            String(input).includes("/warehouse/runs/due"),
          ),
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/maintenance/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Maintenance");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
