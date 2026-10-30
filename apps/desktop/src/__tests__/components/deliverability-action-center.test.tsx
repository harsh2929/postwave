// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { ActionCenter } from "../../components/deliverability/ActionCenter";
import type { DeliverabilityHubBreach } from "../../lib/api-client";
import { tauriApi } from "../../lib/tauri";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  mocks.toastError.mockReset();
});

function renderAction(href: string): HTMLAnchorElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const breach: DeliverabilityHubBreach = {
    code: "remote-remediation",
    severity: "critical",
    title: "Provider remediation required",
    fix_cta: { label: "Open remediation", href },
  };
  act(() => root?.render(<ActionCenter breaches={[breach]} />));
  const link = container.querySelector("a");
  if (!link) throw new Error("Expected the external remediation control");
  return link;
}

describe("ActionCenter remote remediation boundary", () => {
  it("canonicalizes a permitted HTTPS target through the shared opener", () => {
    const open = vi.spyOn(tauriApi, "openUrl").mockResolvedValue(undefined);
    const link = renderAction(
      "https://support.example.test/remediation#private-fragment",
    );

    expect(link.getAttribute("href")).toBe(
      "https://support.example.test/remediation",
    );
    expect(link.rel).toBe("noopener noreferrer");
    act(() => link.click());

    expect(open).toHaveBeenCalledWith(
      "https://support.example.test/remediation",
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["script URL", "javascript:alert(document.domain)"],
    ["local file URL", "file:///private/customer-data.csv"],
    ["embedded credentials", "https://user:pass@example.test/remediation"],
    ["NUL control character", "https://example.test/re\u0000mediation"],
    ["newline control character", "https://example.test/re\nmediation"],
  ])("fails closed for a %s", (_case, href) => {
    const open = vi.spyOn(tauriApi, "openUrl").mockResolvedValue(undefined);
    const link = renderAction(href);

    expect(link.hasAttribute("href")).toBe(false);
    expect(link.getAttribute("aria-disabled")).toBe("true");
    act(() => link.click());

    expect(open).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The external remediation link could not be opened.",
    );
  });
});
