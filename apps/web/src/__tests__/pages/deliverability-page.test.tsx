// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /deliverability. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HUB_FIXTURE from "../fixtures/api/deliverability_hub.json";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  getDeliverabilityHub: vi.fn(),
  clearRepairOverride: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

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
  whoami: mocks.whoami,
}));

vi.mock("@/lib/deliverability-hub-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deliverability-hub-api")>()),
  getDeliverabilityHub: mocks.getDeliverabilityHub,
  clearRepairOverride: mocks.clearRepairOverride,
}));

vi.mock("@/lib/admin-mutation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-mutation-authority")>()),
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

beforeEach(() => {
  mocks.whoami.mockResolvedValue(WHOAMI);
  mocks.getDeliverabilityHub.mockReset();
  mocks.getDeliverabilityHub.mockResolvedValue(HUB_FIXTURE);
  mocks.clearRepairOverride.mockReset();
  mocks.clearRepairOverride.mockResolvedValue({
    kind: "committed",
    cleared: true,
    capCoordinationOutcome: "committed",
  });
  mocks.verifyFreshAdminAuthority.mockReset();
  mocks.verifyFreshAdminAuthority.mockResolvedValue(WHOAMI);
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function buttonWithText(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

async function pressAndSettle(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

describe("deliverability page", () => {
  it("keeps manual health refresh behind the unresolved identity gate", async () => {
    mocks.whoami.mockReturnValue(new Promise(() => undefined));
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const refresh = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Refresh evidence",
      );
      expect(refresh).toBeInstanceOf(HTMLButtonElement);
      expect((refresh as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        (refresh as HTMLButtonElement).click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Deliverability");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not expose PII lookup or cleanup writes in viewer mode", async () => {
    mocks.whoami.mockResolvedValue({
      ...WHOAMI,
      viewer_mode: true,
      effective_role: undefined,
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.querySelector("input[type='email']")).toBeNull();
      expect(container.textContent).toContain(
        "Admin access is required because this lookup handles subscriber PII.",
      );
      expect(container.textContent).not.toContain("Review cleanup");
    } finally {
      unmount(root);
    }
  });

  it("renders committed-with-fence as a held warning, never ordinary success", async () => {
    mocks.getDeliverabilityHub.mockResolvedValue({
      ...HUB_FIXTURE,
      auto_throttled: true,
    });
    mocks.clearRepairOverride.mockResolvedValue({
      kind: "committed-conservatively-fenced",
      cleared: true,
      capCoordinationOutcome: "committed-conservatively-fenced",
      message:
        "the override was cleared, but sending-cap convergence is still pending",
      requiresReconciliation: true,
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await pressAndSettle(buttonWithText(container, "Review throttle reset"));
      await pressAndSettle(
        buttonWithText(document.body, "Clear throttle override"),
      );

      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "The override was cleared, but sending remains conservatively fenced",
      );
      expect(container.textContent).not.toContain(
        "Throttle override cleared and confirmed",
      );
      const held = buttonWithText(
        container,
        "Refresh evidence before another review",
      );
      expect(held.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("holds an exact committed clear when its canonical health read fails", async () => {
    mocks.getDeliverabilityHub
      .mockResolvedValueOnce({
        ...HUB_FIXTURE,
        auto_throttled: true,
      })
      .mockRejectedValue(new Error("hub read unavailable"));
    mocks.clearRepairOverride.mockResolvedValue({
      kind: "committed",
      cleared: true,
      capCoordinationOutcome: "committed",
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await pressAndSettle(buttonWithText(container, "Review throttle reset"));
      await pressAndSettle(
        buttonWithText(document.body, "Clear throttle override"),
      );

      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "fresh health could not confirm the current repair state",
      );
      expect(
        buttonWithText(container, "Refresh evidence before another review")
          .disabled,
      ).toBe(true);
      expect(container.textContent).not.toContain(
        "Throttle override cleared and confirmed",
      );
    } finally {
      unmount(root);
    }
  });

  it("holds an unknown commit outcome until a separate health refresh", async () => {
    mocks.getDeliverabilityHub.mockResolvedValue({
      ...HUB_FIXTURE,
      auto_throttled: true,
    });
    mocks.clearRepairOverride.mockResolvedValue({
      kind: "commit-outcome-unknown",
      cleared: false,
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
      message:
        "the database commit outcome could not be proven; sends remain conservatively fenced",
      requiresReconciliation: true,
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await pressAndSettle(buttonWithText(container, "Review throttle reset"));
      await pressAndSettle(
        buttonWithText(document.body, "Clear throttle override"),
      );

      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "The database commit outcome could not be proven",
      );
      expect(container.textContent).toContain("No retry was sent");
      expect(container.textContent).not.toContain(
        "Throttle override cleared and confirmed",
      );
      expect(
        buttonWithText(container, "Refresh evidence before another review")
          .disabled,
      ).toBe(true);

      // Recovery is a read, not a second POST. A successful explicit refresh
      // may unlock a new review if the authoritative state still has an
      // override, but it never replays the prior request.
      await pressAndSettle(buttonWithText(container, "Refresh evidence"));
      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(buttonWithText(container, "Review throttle reset").disabled).toBe(
        false,
      );
      expect(container.textContent).toContain(
        "Fresh health still shows an active repair override",
      );
    } finally {
      unmount(root);
    }
  });

  it("holds an unproven transport/protocol outcome before another review", async () => {
    mocks.getDeliverabilityHub.mockResolvedValue({
      ...HUB_FIXTURE,
      auto_throttled: true,
    });
    mocks.clearRepairOverride.mockResolvedValue({
      kind: "outcome-unknown",
      cleared: false,
      message: "The repair request did not return a complete outcome receipt.",
      requiresReconciliation: true,
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await pressAndSettle(buttonWithText(container, "Review throttle reset"));
      await pressAndSettle(
        buttonWithText(document.body, "Clear throttle override"),
      );

      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "The database commit outcome could not be proven",
      );
      expect(
        buttonWithText(container, "Refresh evidence before another review")
          .disabled,
      ).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("does not release the unknown-outcome latch when reconciliation fails", async () => {
    mocks.getDeliverabilityHub
      .mockResolvedValueOnce({
        ...HUB_FIXTURE,
        auto_throttled: true,
      })
      .mockRejectedValue(new Error("hub read unavailable"));
    mocks.clearRepairOverride.mockResolvedValue({
      kind: "commit-outcome-unknown",
      cleared: false,
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
      message:
        "the database commit outcome could not be proven; sends remain conservatively fenced",
      requiresReconciliation: true,
    });
    const Page = (await import("@/app/(dashboard)/app/deliverability/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await pressAndSettle(buttonWithText(container, "Review throttle reset"));
      await pressAndSettle(
        buttonWithText(document.body, "Clear throttle override"),
      );
      expect(container.textContent).toContain(
        "the reconciliation read also failed",
      );
      expect(container.textContent).not.toContain("Review throttle reset");

      await pressAndSettle(buttonWithText(container, "Refresh evidence"));
      expect(mocks.clearRepairOverride).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "the reconciliation read also failed",
      );
      expect(container.textContent).not.toContain("Review throttle reset");
    } finally {
      unmount(root);
    }
  });
});
