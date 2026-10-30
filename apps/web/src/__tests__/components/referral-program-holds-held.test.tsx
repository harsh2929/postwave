// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-51 / commerce-53 — the milestone reward-image picker and the
// "Install on website" verb on /app/referrals under the REAL (unmocked)
// referral release policy, rendered through the real page so the asserted
// requests are the page's own. Each held control stays visible, aria-disabled,
// described by the policy's own sentence, and reaches nothing: no asset
// listing, no install dialog, no write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
  REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE,
  REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON,
  REFERRAL_SUBSCRIBER_LINKS_AVAILABLE,
} from "@/lib/referral-operational-availability";
import { renderPage, unmount, WHOAMI } from "../pages/_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "../pages/_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/referrals",
  useSearchParams: () => new URLSearchParams("tab=program"),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const PROGRAM = {
  id: "prog-1",
  active: true,
  milestones: [{ count: 3, reward_label: "Free month", reward_kind: "free" }],
};

let calls: ReturnType<typeof recordingTransport>["calls"];

beforeEach(() => {
  calls = recordingTransport((req) => {
    if (req.method === "GET" && req.path === "/api/v1/referral-programs/current") {
      return { body: PROGRAM };
    }
    return undefined;
  }).calls;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("referrals program tab under the shipped release policy", () => {
  it("is the policy this file pins", () => {
    expect(REFERRAL_PROGRAM_MUTATIONS_AVAILABLE).toBe(false);
    expect(REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE).toBe(false);
    expect(REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE).toBe(false);
    expect(REFERRAL_SUBSCRIBER_LINKS_AVAILABLE).toBe(false);
  });

  it("holds the reward-image picker and the website install, sending nothing", async () => {
    const Page = (await import("@/app/(dashboard)/app/referrals/page-client"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      // The loaded program is in the form (input values are not textContent).
      expect(
        [...container.querySelectorAll<HTMLInputElement>("input")].some(
          (input) => input.value === "Free month",
        ),
      ).toBe(true);

      // commerce-51 — reward image picker.
      const choose = buttonByText(container, /^Choose image$/);
      expect(choose).toBeDefined();
      expect(choose!.getAttribute("aria-disabled")).toBe("true");
      const pickerNote = document.getElementById(
        choose!.getAttribute("aria-describedby") ?? "",
      );
      expect(pickerNote).not.toBeNull();
      expect(pickerNote!.getAttribute("role")).toBe("note");
      expect(pickerNote!.textContent).toContain(
        "Program changes are review-gated.",
      );
      expect(pickerNote!.textContent).toContain(
        REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
      );
      expect(container.textContent).toContain("No image");
      await clickEl(choose);
      await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(calls.some((c) => c.path === "/api/v1/assets")).toBe(false);

      // commerce-53 — install on website.
      const install = buttonByText(container, /Install on website/);
      expect(install).toBeDefined();
      expect(install!.getAttribute("aria-disabled")).toBe("true");
      const installNote = document.getElementById(
        install!.getAttribute("aria-describedby") ?? "",
      );
      expect(installNote).not.toBeNull();
      expect(installNote!.textContent).toContain(
        "Website installation is review-gated.",
      );
      expect(installNote!.textContent).toContain(
        REFERRAL_PUBLIC_WIDGET_INSTALL_UNAVAILABLE_REASON,
      );
      await clickEl(install);
      await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      // The save button is disabled under the hold as before; nothing wrote.
      expect(buttonByText(container, /^Save program$/)?.disabled).toBe(true);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
