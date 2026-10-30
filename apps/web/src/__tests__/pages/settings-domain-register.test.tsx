// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Settings → Domain — register hostname (desktop parity deliverability-2).
//
// Desktop renders "Register hostname" disabled with the hold title
// (apps/desktop/src/pages/CustomDomains.tsx). Web already carried the
// release-hold card but no register control. What must be true: the form
// renders with a disabled submit carrying desktop's title, the reason is
// attached through aria-describedby, nothing is sent while held — and with
// the availability flag simulated as lifted, the submit POSTs
// /api/v1/custom-domains with {domain, purpose} and re-reads the registry.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

const state = vi.hoisted(() => ({ available: false }));
const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings/domain",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost } };
});
vi.mock("@/lib/custom-domain-operational-availability", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/custom-domain-operational-availability")
  >();
  return {
    ...actual,
    get CUSTOM_DOMAIN_REGISTRATION_AVAILABLE() {
      return state.available;
    },
    requireCustomDomainOperation: (operation: "registration" | "verification" | "removal") => {
      if (operation === "registration" && state.available) return;
      throw new actual.CustomDomainOperationUnavailableError(operation);
    },
  };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { createCustomDomain } from "@/lib/custom-domains-api";

const DESKTOP_TITLE =
  "Registration is held until automated TLS issuance, dependency inventory, and a production traffic-routing path are qualified.";

async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
function submitButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === "Register hostname",
  );
  if (!found) throw new Error("Register hostname button not found");
  return found;
}
async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.available = false;
  mocks.whoami.mockResolvedValue(WHOAMI);
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path === "/api/v1/custom-domains") return { tenant_id: WHOAMI.tenant_id, domains: [] };
    throw new Error("unexpected GET " + path);
  });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("settings/domain — register hostname (deliverability-2)", () => {
  it("renders the form with the submit disabled under desktop's title and sends nothing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/domain/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const form = container.querySelector<HTMLFormElement>('form[aria-label="Register hostname"]');
      expect(form).toBeTruthy();
      const hostname = form!.querySelector<HTMLInputElement>('input[type="text"]');
      const purpose = form!.querySelector<HTMLSelectElement>("select");
      expect(hostname?.disabled).toBe(true);
      expect(purpose?.disabled).toBe(true);
      expect([...purpose!.options].map((o) => o.value)).toEqual(["forms", "links", "web", "tracking"]);

      const submit = submitButton();
      expect(submit.disabled).toBe(true);
      expect(submit.getAttribute("title")).toBe(DESKTOP_TITLE);
      const reasonId = submit.getAttribute("aria-describedby");
      expect(reasonId).toBeTruthy();
      const reason = document.getElementById(reasonId!);
      expect(reason?.getAttribute("role")).toBe("status");
      expect(reason?.textContent).toBe(DESKTOP_TITLE);

      // A forced submit never reaches the transport.
      await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("refuses the transport before fetch while registration is held", async () => {
    await expect(
      createCustomDomain({ domain: "mail.example.com", purpose: "forms" }),
    ).rejects.toMatchObject({
      code: "custom_domain_registration_unavailable",
      status: 503,
    });
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("with the flag simulated as lifted, POSTs {domain, purpose} and re-reads the registry", async () => {
    state.available = true;
    mocks.apiPost.mockResolvedValueOnce({
      id: "dom_1",
      tenant_id: WHOAMI.tenant_id,
      domain: "mail.example.com",
      purpose: "links",
      verified: false,
      dns_records: [],
      created_at: "2026-09-12T00:00:00Z",
    });
    const Page = (await import("@/app/(dashboard)/app/settings/domain/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const form = container.querySelector<HTMLFormElement>('form[aria-label="Register hostname"]')!;
      const hostname = form.querySelector<HTMLInputElement>('input[type="text"]')!;
      const purpose = form.querySelector<HTMLSelectElement>("select")!;
      expect(submitButton().disabled).toBe(true); // empty hostname
      expect(submitButton().getAttribute("aria-describedby")).toBeNull();
      await setValue(hostname, " Mail.Example.com ");
      await setValue(purpose, "links");
      expect(submitButton().disabled).toBe(false);
      const registryReadsBefore = mocks.apiGet.mock.calls.filter((c) => c[0] === "/api/v1/custom-domains").length;

      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush(8);

      expect(mocks.apiPost).toHaveBeenCalledTimes(1);
      expect(mocks.apiPost.mock.calls[0]?.[0]).toBe("/api/v1/custom-domains");
      expect(mocks.apiPost.mock.calls[0]?.[1]).toEqual({ domain: "mail.example.com", purpose: "links" });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Registered mail.example.com");
      expect(hostname.value).toBe("");
      const registryReadsAfter = mocks.apiGet.mock.calls.filter((c) => c[0] === "/api/v1/custom-domains").length;
      expect(registryReadsAfter).toBeGreaterThan(registryReadsBefore);
    } finally {
      unmount(root);
    }
  });

  it("rejects a hostname that is not fully qualified without sending", async () => {
    state.available = true;
    const Page = (await import("@/app/(dashboard)/app/settings/domain/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const form = container.querySelector<HTMLFormElement>('form[aria-label="Register hostname"]')!;
      await setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, "not a host");
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(mocks.apiPost).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Enter a fully qualified hostname such as mail.example.com.",
      );
    } finally {
      unmount(root);
    }
  });
});
