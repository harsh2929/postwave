// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /campaigns/[id]/ab.
//
// This page had zero coverage: nothing imported its module, so a crash on
// mount was invisible. Responses come from recorded fixtures; unrecorded
// endpoints answer 404, which every page has a branch for.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./_wait";

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
  usePathname: () => "/app/campaigns/[id]/ab",
  useSearchParams: () => new URLSearchParams(),
  // Dynamic routes read their id from here; a plausible uuid keeps downstream
  // validation happy without pretending the record exists.
  useParams: () => ({ id: "11111111-2222-3333-4444-555555555555" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaigns/[id]/ab page", () => {
  it("keeps a saved edit on screen when clearing its dirty flag", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    let variants = [
      { id: "arm-a", variant_label: "A", subject: "Before", weight: 50 },
      { id: "arm-b", variant_label: "B", subject: "Second", weight: 50 },
    ];
    let saves = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://localhost",
        ).pathname;
        if (path.endsWith("/variants") && init?.method === "POST") {
          variants = JSON.parse(String(init.body));
          saves += 1;
          return Response.json(variants);
        }
        if (path.endsWith("/ab"))
          return Response.json({
            settings: {
              winner_metric: "open_rate",
              evaluation_window_hours: 24,
            },
            variants,
            results: [
              {
                variant_id: "arm-a",
                recipients_count: 0,
                delivered: 0,
                opens: 0,
                clicks: 0,
                unsubscribes: 0,
                complaints: 0,
              },
            ],
          });
        if (path.endsWith("/ab-weight-history"))
          return Response.json({ series: [] });
        if (path.endsWith(`/campaigns/${id}`))
          return Response.json({ id, name: "QA", status: "draft" });
        return Response.json(WHOAMI);
      }),
    );
    const { CampaignABClient: Page } =
      await import("@/app/(dashboard)/app/campaigns/[id]/ab/campaign-ab-client");
    const { root } = await renderPage(Page);
    try {
      await waitFor(() =>
        expect(
          document.querySelector<HTMLInputElement>("#subject-0")?.value,
        ).toBe("Before"),
      );
      await act(async () => {
        const field = document.querySelector<HTMLInputElement>("#subject-0")!;
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, "After");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Save variants")!
          .click();
      });
      await waitFor(() => expect(saves).toBe(1));
      await waitFor(() =>
        expect(
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Save variants",
          )?.disabled,
        ).toBe(false),
      );
      expect(
        document.querySelector<HTMLInputElement>("#subject-0")?.value,
      ).toBe("After");
      await act(async () => {
        Array.from(document.querySelectorAll('[role="tab"]'))
          .find((tab) => tab.textContent?.trim() === "Results")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(document.body.textContent).toContain(
        "Not enough recipients to estimate an open rate or confidence interval.",
      );
      expect(document.body.textContent).not.toContain("Open rate 95% CI:");
    } finally {
      unmount(root);
    }
  });

  it("mounts without crashing", async () => {
    const { CampaignABClient: Page } =
      await import("@/app/(dashboard)/app/campaigns/[id]/ab/campaign-ab-client");
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
