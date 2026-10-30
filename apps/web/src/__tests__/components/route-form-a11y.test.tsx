// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import LandingPagesPage from "@/app/(dashboard)/app/landing-pages/page";
import PaidMembersPage from "@/app/(dashboard)/app/subscribers/paid-members/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listPaidMembers: vi.fn(),
  grantPaidMember: vi.fn(),
  revokePaidMember: vi.fn(),
  landingList: vi.fn(),
  landingCreate: vi.fn(),
  landingArchive: vi.fn(),
  whoami: vi.fn(),
  slugify: vi.fn((value: string) => value),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// The landing list is now react-query + URL-state driven; mock the router and
// auth so the page can render standalone (its interactive a11y is still real).
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/landing-pages",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/paywall-api", () => ({
  listPaidMembers: mocks.listPaidMembers,
  grantPaidMember: mocks.grantPaidMember,
  revokePaidMember: mocks.revokePaidMember,
}));

vi.mock("@/lib/landing-pages-api", () => ({
  landingPagesApi: {
    list: mocks.landingList,
    get: vi.fn(),
    create: mocks.landingCreate,
    update: vi.fn(),
    archive: mocks.landingArchive,
  },
}));

vi.mock("@/lib/slugify", () => ({
  slugify: mocks.slugify,
}));

vi.mock("@/components/mailchimp-parity/multi-channel-ops-panel", () => ({
  MultiChannelOpsPanel: () =>
    createElement("section", { "data-testid": "multi-channel-ops-panel" }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("route form accessibility", () => {
  it("announces paid-member email validation errors and clears them on edit", async () => {
    mocks.listPaidMembers.mockResolvedValue({ members: [] });
    const root = render(createElement(PaidMembersPage));

    try {
      await waitFor(() => {
        expect(mocks.listPaidMembers).toHaveBeenCalled();
      });

      const email = document.querySelector("#grant-email") as HTMLInputElement;

      await act(async () => {
        changeInput(email, "not-an-email");
        buttonByText("Grant paid access").click();
        await flush();
      });

      const alert = document.querySelector("#grant-email-error");
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toBe("Enter a valid email address.");
      expect(email.getAttribute("aria-invalid")).toBe("true");
      expect(email.getAttribute("aria-describedby")).toBe("grant-email-error");
      expect(mocks.grantPaidMember).not.toHaveBeenCalled();

      await act(async () => {
        changeInput(email, "reader@example.com");
        await flush();
      });

      expect(document.querySelector("#grant-email-error")).toBeNull();
      expect(email.hasAttribute("aria-invalid")).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("marks the paid-member grant surface busy in the request-starting task", async () => {
    mocks.listPaidMembers.mockResolvedValue({
      members: [],
      total: 0,
      page: 1,
      per_page: 50,
    });
    let resolveGrant: (() => void) | undefined;
    mocks.grantPaidMember.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveGrant = resolve;
        }),
    );
    const root = render(createElement(PaidMembersPage));

    try {
      await waitFor(() => {
        expect(mocks.listPaidMembers).toHaveBeenCalled();
      });

      const email = document.querySelector("#grant-email") as HTMLInputElement;
      await act(async () => {
        changeInput(email, "reader@example.com");
        await flush();
      });

      const grant = buttonByText("Grant paid access");
      act(() => {
        grant.click();
        expect(grant.closest("[aria-busy='true']")).not.toBeNull();
        // A second event in the same task cannot start another request before
        // React commits the disabled state.
        grant.click();
      });

      expect(mocks.grantPaidMember).toHaveBeenCalledTimes(1);
      expect(email.disabled).toBe(true);

      await act(async () => {
        resolveGrant?.();
        await flush();
      });
      expect(grant.closest("[aria-busy]")).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("announces landing-page slug validation errors with the help text preserved", async () => {
    mocks.whoami.mockResolvedValue({ tenant_id: "t1", role: "owner" });
    mocks.landingList.mockResolvedValue([]);
    mocks.slugify.mockImplementation((value: string) => value);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(LandingPagesPage),
      ),
    );

    try {
      await waitFor(() => {
        expect(mocks.landingList).toHaveBeenCalled();
      });

      await act(async () => {
        buttonByText("New page").click();
        await flush();
      });

      const slug = document.querySelector("#lp-slug") as HTMLInputElement;
      const name = document.querySelector("#lp-name") as HTMLInputElement;

      await act(async () => {
        changeInput(slug, "2024-sale");
        changeInput(name, "Welcome page");
        document
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await flush();
      });

      const alert = document.querySelector("#lp-slug-error");
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toContain("Start with a lowercase letter");
      expect(slug.getAttribute("aria-invalid")).toBe("true");
      expect(slug.getAttribute("aria-describedby")).toBe(
        "lp-slug-help lp-slug-error",
      );
      expect(mocks.landingCreate).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
