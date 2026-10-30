// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Staging: /app/ai-quality opened with "Brief is required." and
// /app/verification with "Enter an opaque tenant-local credential reference…"
// before the reader had typed anything. Both forms computed their draft's
// validation on every render and printed it unconditionally, so an empty
// new form announced itself as a mistake (role="alert") and marked the
// field aria-invalid on arrival.
//
// The rule these tests hold: validation appears only once the reader has
// interacted — left a text field, changed a checkbox, or submitted — and
// then it is tied to its field (aria-invalid + aria-describedby).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "../pages/_harness";

vi.mock("next/navigation", () => ({
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

const verificationMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getPolicy: vi.fn(),
}));
vi.mock("@/lib/verification-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verification-api")>()),
  getVerificationProviders: verificationMocks.getProviders,
  getVerificationPolicy: verificationMocks.getPolicy,
}));

beforeEach(() => {
  stubFixtureTransport();
  // A workspace with no provider configured yet: the credential reference
  // starts empty, which is exactly the state that is invalid to save.
  verificationMocks.getProviders.mockReset().mockResolvedValue({
    available: ["zerobounce", "kickbox"],
    providers: [],
  });
  verificationMocks.getPolicy.mockReset().mockResolvedValue({
    modes: ["off", "local", "full"],
    rejectable_statuses: ["invalid", "spamtrap", "abuse", "do_not_mail"],
    policy: {
      forms_mode: "off",
      forms_reject_statuses: ["invalid"],
      forms_suggest_typos: true,
      import_mode: "off",
      updated_at: "2026-08-29T00:00:00Z",
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function blur(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The element this field's aria-describedby names, if any. */
function describedBy(el: HTMLElement): HTMLElement | null {
  const id = el.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

const CREDENTIAL_MESSAGE = "Enter an opaque tenant-local credential reference";

describe("/app/verification provider form", () => {
  async function mount() {
    const { VerificationAdminPanel } =
      await import("@/app/(dashboard)/app/verification/verification-admin-panel");
    const rendered = await renderPage(VerificationAdminPanel, {
      identity: WHOAMI,
      queryKeyBase: ["verification", WHOAMI.tenant_id, "owner"],
    });
    const input = rendered.container.querySelector<HTMLInputElement>(
      'input[placeholder="verification-prod"]',
    );
    if (!input) throw new Error("credential reference input not rendered");
    return { ...rendered, input };
  }

  it("says nothing is wrong with an untouched, empty form", async () => {
    const { container, root, input } = await mount();
    try {
      expect(container.textContent).toContain("Configure provider");
      expect(container.textContent).not.toContain(CREDENTIAL_MESSAGE);
      expect(input.getAttribute("aria-invalid")).toBeNull();
      expect(container.querySelector("[role='alert']")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("explains the credential reference once the reader leaves the field, tied to it", async () => {
    const { container, root, input } = await mount();
    try {
      await blur(input);
      const message = describedBy(input);
      expect(message?.textContent).toContain(CREDENTIAL_MESSAGE);
      expect(message?.getAttribute("role")).toBe("alert");
      expect(input.getAttribute("aria-invalid")).toBe("true");

      await type(input, "verification-prod");
      expect(container.textContent).not.toContain(CREDENTIAL_MESSAGE);
      expect(input.getAttribute("aria-invalid")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("explains why saving is off once the reader changes a checkbox", async () => {
    const { container, root } = await mount();
    try {
      const degrade = [
        ...container.querySelectorAll<HTMLInputElement>(
          "input[type='checkbox']",
        ),
      ].find((box) =>
        box.closest("label")?.textContent?.includes("Degrade bulk runs"),
      );
      expect(degrade).toBeDefined();
      await act(async () => {
        degrade?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).toContain(CREDENTIAL_MESSAGE);
    } finally {
      unmount(root);
    }
  });
});

describe("/app/ai-quality golden reference capture", () => {
  async function mount() {
    const Page = (await import("@/app/(dashboard)/app/ai-quality/page"))
      .default;
    const rendered = await renderPage(Page);
    const brief = rendered.container.querySelector<HTMLTextAreaElement>(
      "#golden-capture-brief",
    );
    const output = rendered.container.querySelector<HTMLTextAreaElement>(
      "#golden-capture-output",
    );
    if (!brief || !output) throw new Error("capture form not rendered");
    return { ...rendered, brief, output };
  }

  it("says nothing is wrong with an untouched capture form", async () => {
    const { container, root, brief } = await mount();
    try {
      expect(container.textContent).toContain("Capture a manual reference");
      expect(container.textContent).not.toContain("Brief is required.");
      expect(brief.getAttribute("aria-invalid")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("explains a missing brief once the reader leaves it, tied to the field", async () => {
    const { container, root, brief, output } = await mount();
    try {
      await blur(brief);
      const message = describedBy(brief);
      expect(message?.textContent).toBe("Brief is required.");
      expect(message?.getAttribute("role")).toBe("alert");
      expect(brief.getAttribute("aria-invalid")).toBe("true");

      // The message follows the draft: a brief moves it on to the output.
      await type(brief, "Announce the spring collection.");
      expect(container.textContent).not.toContain("Brief is required.");
      expect(describedBy(output)?.textContent).toBe(
        "Human-approved output is required.",
      );
    } finally {
      unmount(root);
    }
  });

  it("forgets the interaction when the draft is discarded", async () => {
    const { container, root, brief } = await mount();
    try {
      await type(brief, "x");
      await blur(brief);
      expect(container.textContent).toContain(
        "Human-approved output is required.",
      );
      const discard = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find(
        (button) => button.textContent?.trim() === "Discard capture draft",
      );
      await act(async () => {
        discard?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).not.toContain("is required.");
    } finally {
      unmount(root);
    }
  });
});
