// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /subscribers/paid-members. Completes the mount suite to every dashboard page.
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
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/paid-members",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const paywallMocks = vi.hoisted(() => ({
  grantPaidMember: vi.fn(),
  listPaidMembers: vi.fn(),
  revokePaidMember: vi.fn(),
}));

vi.mock("@/lib/paywall-api", () => ({
  grantPaidMember: paywallMocks.grantPaidMember,
  listPaidMembers: paywallMocks.listPaidMembers,
  revokePaidMember: paywallMocks.revokePaidMember,
}));

const member = {
  subscriber_email: "paid.reader@example.test",
  status: "active",
  tier: "Pro",
  stripe_subscription_id: null,
  started_at: "2026-08-20T09:00:00Z",
  cancelled_at: null,
  metadata: {},
};

beforeEach(() => {
  stubFixtureTransport();
  paywallMocks.listPaidMembers.mockResolvedValue({
    members: [member],
    total: 1,
    page: 1,
    per_page: 50,
  });
  paywallMocks.grantPaidMember.mockResolvedValue({ ok: true });
  paywallMocks.revokePaidMember.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function settleUntil(
  predicate: () => boolean,
  turns = 20,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
  }
  expect(predicate()).toBe(true);
}

describe("subscribers/paid-members page", () => {
  it("mounts without crashing", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/paid-members/page")
    ).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Paid members");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("distinguishes a filtered zero from an empty paid-member registry", async () => {
    paywallMocks.listPaidMembers.mockImplementation(
      async (_status, _page, _perPage, email) => ({
        members: email ? [] : [member],
        total: email ? 0 : 1,
        page: 1,
        per_page: 50,
      }),
    );
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/paid-members/page")
    ).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(member.subscriber_email);
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Filter members by email"]',
      );
      expect(input).not.toBeNull();

      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "missing@example.test");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 325));
      });
      await settleUntil(() =>
        Boolean(
          container.textContent?.includes(
            "No paid members match these filters",
          ),
        ),
      );
      expect(container.textContent).not.toContain("No paid members yet");

      const clear = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Clear filters",
      );
      expect(clear).toBeInstanceOf(HTMLButtonElement);
      await act(async () => clear?.click());
      await settleUntil(() =>
        Boolean(container.textContent?.includes(member.subscriber_email)),
      );
      expect(paywallMocks.listPaidMembers).toHaveBeenLastCalledWith(
        undefined,
        1,
        50,
        undefined,
      );
    } finally {
      unmount(root);
    }
  });
});
