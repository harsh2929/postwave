// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /sequence-templates/new. Completes the mount suite to every dashboard page.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceTemplate } from "@/lib/voice-types";

import {
  clickEveryControl,
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const mocks = vi.hoisted(() => ({
  getTemplate: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/sequence-templates/new",
  useSearchParams: () => new URLSearchParams(mocks.search),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/voice-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-api")>()),
  getTemplate: mocks.getTemplate,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => {
  mocks.search = "";
  mocks.getTemplate.mockReset();
  stubFixtureTransport();
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sequence-templates/new page", () => {
  it("mounts without crashing", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/sequence-templates/new/page")
    ).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectMounted(text);
      const create = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Create template",
      );
      expect(container.querySelector("form")).not.toBeNull();
      expect(create?.type).toBe("submit");
      expect(create?.disabled).toBe(true);
      expect(create?.getAttribute("aria-describedby")).toBe(
        "sequence-template-save-requirements",
      );
      expect(
        container.querySelector("#sequence-template-save-requirements")
          ?.textContent,
      ).toContain("Still needed:");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("blocks a failed duplicate load, retries, and preserves the source slug", async () => {
    const source: SequenceTemplate = {
      id: "source_1",
      slug: "carefully-chosen-slug",
      name: "Lifecycle onboarding",
      description: "A grounded welcome sequence.",
      category: "Onboarding",
      length: 1,
      variables: [],
      emails: [
        {
          position: 1,
          subjectHint: "Welcome aboard",
          bodyHint: "Say hello.",
          delayHours: 0,
        },
      ],
    };
    mocks.search = "from=source_1";
    mocks.getTemplate
      .mockRejectedValueOnce(new Error("source unavailable"))
      .mockResolvedValueOnce(source);

    const Page = (
      await import("@/app/(dashboard)/app/sequence-templates/new/page")
    ).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not load the template to duplicate",
      );
      const fieldset = container.querySelector("fieldset");
      expect(fieldset?.hasAttribute("disabled")).toBe(true);
      expect(
        container.querySelector<HTMLInputElement>("#tpl-name")?.value,
      ).toBe("");

      const retry = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      await act(async () => {
        retry?.click();
      });
      await waitFor(() => {
        expect(
          container.querySelector<HTMLInputElement>("#tpl-name")?.value,
        ).toBe("Lifecycle onboarding (copy)");
      });
      expect(
        container.querySelector<HTMLInputElement>("#tpl-slug")?.value,
      ).toBe("carefully-chosen-slug-copy");
      expect(fieldset?.hasAttribute("disabled")).toBe(false);
      expect(
        Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Create template",
        )?.disabled,
      ).toBe(false);
      expect(mocks.getTemplate).toHaveBeenCalledTimes(2);
    } finally {
      unmount(root);
    }
  });
});
