// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /discounts. Generated against the page's own <h1>.
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

describe("discounts page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/discounts/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Discount history");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("restores focus after closing the PII-free recent-events dialog", async () => {
    vi.stubGlobal("fetch", discountArchiveTransport());
    const Page = (await import("@/app/(dashboard)/app/discounts/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const trigger = await waitForButton(
        container,
        "View recent events for Discount record 11111111",
      );
      act(() => trigger.click());
      const close = await waitForButton(document.body, "Close");
      act(() => close.click());
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(document.activeElement).toBe(trigger);
      expect(document.body.textContent).not.toMatch(
        /subscriber_email|private@example|CSV export/u,
      );
    } finally {
      unmount(root);
    }
  });

  it("hides the last snapshot immediately when refresh returns 403", async () => {
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v1/discounts") {
          listCalls += 1;
          if (listCalls === 1) {
            return Response.json({ items: [archiveRecord()], has_more: false });
          }
          return Response.json(
            { error: { code: "forbidden", message: "forbidden" } },
            { status: 403 },
          );
        }
        return Response.json({ items: [], has_more: false });
      }),
    );
    const Page = (await import("@/app/(dashboard)/app/discounts/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitForButton(
        container,
        "View recent events for Discount record 11111111",
      );
      const refresh = await waitForButton(container, "Refresh snapshot");
      act(() => refresh.click());
      await waitForText("Discount history access is unavailable");
      expect(document.body.textContent).not.toContain(
        "Discount record 11111111",
      );
      expect(
        container.querySelector('button[aria-label^="View recent"]'),
      ).toBeNull();
    } finally {
      unmount(root);
    }
  });
});

function archiveRecord() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    label: "Discount record 11111111",
    percent_off: 20,
    currency: "usd",
    times_redeemed: 3,
    applies_to: "both",
    created_at: "2026-07-10T00:00:00Z",
  };
}

function discountArchiveTransport() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/discounts") {
      return Response.json({ items: [archiveRecord()], has_more: false });
    }
    if (url.pathname.endsWith("/redemptions")) {
      return Response.json({
        items: [
          {
            redeemed_at: "2026-07-12T00:00:00Z",
            subscriber_linked: true,
          },
        ],
        has_more: false,
      });
    }
    return Response.json(
      { error: { code: "not_found", message: "not found" } },
      { status: 404 },
    );
  });
}

async function waitForButton(
  root: ParentNode,
  name: string,
): Promise<HTMLButtonElement> {
  let found: HTMLButtonElement | undefined;
  await waitFor(() => {
    found = Array.from(root.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === name ||
        button.getAttribute("aria-label") === name,
    );
    expect(found).toBeDefined();
  });
  return found!;
}

async function waitForText(text: string): Promise<void> {
  await waitFor(() => expect(document.body.textContent).toContain(text));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
