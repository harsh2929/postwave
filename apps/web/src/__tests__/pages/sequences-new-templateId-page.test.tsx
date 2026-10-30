// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /sequences/new/[templateId]. Completes the mount suite to every dashboard page.
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
  usePathname: () => "/app/sequences/new/[templateId]",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ templateId: "welcome-warm" }),
  redirect: vi.fn(),
}));

const { templateFixture } = vi.hoisted(() => ({
  templateFixture: {
    id: "welcome-warm",
    slug: "welcome-warm",
    name: "Warm welcome",
    description: "A grounded welcome sequence.",
    category: "Welcome",
    length: 3,
    variables: [
      {
        key: "audience",
        label: "Audience",
        description: "Who is this for?",
        type: "text",
        example: "Independent teams",
        required: true,
      },
      {
        key: "promise",
        label: "Promise",
        description: "What will they get?",
        type: "longtext",
        example: "A useful onboarding sequence",
        required: true,
      },
    ],
    emails: [],
  },
}));

vi.mock("@/lib/voice-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-api")>()),
  getTemplate: vi.fn().mockResolvedValue(templateFixture),
  getProfile: vi.fn().mockResolvedValue(null),
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

describe("sequences/new/[templateId] page", () => {
  it("mounts without crashing", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/sequences/new/[templateId]/page")
    ).default;
    const { text, container, root } = await renderPage(Page, {
      params: Promise.resolve({
        templateId: "welcome-warm",
      }),
    });
    try {
      expectMounted(text);
      const continueButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Continue"),
      );
      expect(continueButton).toBeDefined();
      // The validation action must remain operable: it reports the missing
      // fields and focuses the first one, so exposing it as aria-disabled
      // would make that recovery path unavailable to assistive technology.
      expect(continueButton?.getAttribute("aria-disabled")).toBeNull();
      await act(async () => {
        continueButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const firstInvalid = container.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      expect(firstInvalid).not.toBeNull();
      expect(document.activeElement).toBe(firstInvalid);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Still needed:",
      );
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
