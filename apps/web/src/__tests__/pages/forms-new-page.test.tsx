// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /forms/new. Completes the mount suite to every dashboard page.
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
  usePathname: () => "/app/forms/new",
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
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The success-message box and the two opt-in radios, as the operator sees them. */
function draft(container: HTMLElement) {
  const message = container.querySelector<HTMLTextAreaElement>("#form-success");
  const modes = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[name="optin"]'),
  );
  if (!message || modes.length !== 2) {
    throw new Error(
      "the new-form draft is missing its success message or modes",
    );
  }
  return { message, double: modes[0]!, single: modes[1]! };
}

async function choose(radio: HTMLInputElement): Promise<void> {
  await act(async () => {
    radio.click();
  });
}

async function type(box: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// A new form promised "Check your inbox to confirm your subscription." whatever
// the opt-in mode was. On a single opt-in nothing is ever sent, so it left the
// visitor waiting for an email that does not exist.
describe("forms/new — the default success message follows the opt-in mode", () => {
  it("promises a confirmation email only while double opt-in is chosen", async () => {
    const Page = (await import("@/app/(dashboard)/app/forms/new/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const { message, double, single } = draft(container);
      expect(double.checked).toBe(true);
      expect(message.value).toBe(
        "Thanks! Check your inbox to confirm your subscription.",
      );

      await choose(single);
      expect(message.value).toBe("Thanks for subscribing. You're on the list.");
      expect(message.value).not.toContain("Check your inbox");

      // And back, so the default is not a one-way door.
      await choose(double);
      expect(message.value).toBe(
        "Thanks! Check your inbox to confirm your subscription.",
      );
    } finally {
      unmount(root);
    }
  });

  it("never overwrites a message the operator wrote", async () => {
    const Page = (await import("@/app/(dashboard)/app/forms/new/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const { message, single, double } = draft(container);
      await type(message, "You're in — the next issue lands on Friday.");
      await choose(single);
      expect(message.value).toBe("You're in — the next issue lands on Friday.");
      await choose(double);
      expect(message.value).toBe("You're in — the next issue lands on Friday.");
    } finally {
      unmount(root);
    }
  });
});

describe("forms/new page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/forms/new/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "New form");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
