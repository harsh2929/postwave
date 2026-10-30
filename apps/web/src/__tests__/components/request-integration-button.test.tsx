// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  integrationRequestMailto,
  RequestIntegrationButton,
} from "@/components/integrations/request-integration-button";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function setClipboard(clipboard: unknown): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

async function mount(defaultProvider = ""): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <RequestIntegrationButton defaultProvider={defaultProvider} />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

function compose(): HTMLAnchorElement {
  const match = Array.from(document.querySelectorAll("a")).find(
    (candidate): candidate is HTMLAnchorElement =>
      candidate.textContent?.trim() === "Compose email",
  );
  if (!match) throw new Error("Compose email link not found");
  return match;
}

function providerInput(): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === "Provider name",
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : null;
  if (!(control instanceof HTMLInputElement)) {
    throw new Error("Provider input not found");
  }
  return control;
}

function change(control: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 0),
        );
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  setClipboard(undefined);
});

describe("integrationRequestMailto", () => {
  it("requires a bounded provider and encodes every operator value", () => {
    expect(integrationRequestMailto("   ")).toBeNull();
    expect(integrationRequestMailto("x".repeat(121))).toBeNull();
    expect(integrationRequestMailto("  Acme CRM & Sync/β  ")).toBe(
      "mailto:integrations@moosewave.com?subject=Integration%20request%3A%20Acme%20CRM%20%26%20Sync%2F%CE%B2&body=Provider%3A%20Acme%20CRM%20%26%20Sync%2F%CE%B2%0AUse%20case%3A%20%0AApproximate%20monthly%20volume%3A%20",
    );
  });
});

describe("RequestIntegrationButton", () => {
  it("keeps invalid compose local, associates its error, and closes with focus restored", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await mount("Salesforce");
    const trigger = button("Request an integration");
    await act(async () => trigger.click());
    const provider = providerInput();
    expect(document.activeElement).toBe(provider);

    await act(async () => change(provider, ""));
    await act(async () => compose().click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(provider);
    expect(provider.getAttribute("aria-invalid")).toBe("true");
    const errorId = provider.getAttribute("aria-describedby");
    expect(document.getElementById(errorId!)?.textContent).toContain(
      "Enter a provider name",
    );
    expect(compose().getAttribute("href")).not.toMatch(/^mailto:/u);

    await act(async () => change(provider, "Dirty draft"));
    await act(async () => button("Close").click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await act(async () => trigger.click());
    expect(providerInput().value).toBe("Salesforce");
  });

  it("copies the visible request address and only claims success after the write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await mount();
    await act(async () => button("Request an integration").click());
    expect(document.body.textContent).toContain("integrations@moosewave.com");

    await act(async () => button("Copy address").click());
    expect(writeText).toHaveBeenCalledWith("integrations@moosewave.com");
    expect(button("Address copied")).not.toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied to clipboard.");
  });

  it("keeps copy failure visible and still exposes the address for manual copy", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    await mount();
    await act(async () => button("Request an integration").click());
    await act(async () => button("Copy address").click());

    expect(button("Copy address")).not.toBeNull();
    expect(document.body.textContent).toContain("integrations@moosewave.com");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Could not copy to the clipboard.",
    );
  });

  it("builds a valid mailto and closes only after a valid compose activation", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await mount();
    const trigger = button("Request an integration");
    await act(async () => trigger.click());
    await act(async () => change(providerInput(), "  Acme CRM & Sync  "));
    const link = compose();
    expect(link.href).toContain(
      "subject=Integration%20request%3A%20Acme%20CRM%20%26%20Sync",
    );
    expect(link.href).toContain(
      "body=Provider%3A%20Acme%20CRM%20%26%20Sync%0AUse%20case%3A",
    );

    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    await act(async () => link.click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
