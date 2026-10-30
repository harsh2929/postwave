// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// The client component, not the `next/dynamic` wrapper in page.tsx: under this
// file's mock graph the lazy chunk never resolved inside the act loop, so every
// assertion here only ever saw the Suspense fallback. The wrapper itself is
// covered by src/__tests__/pages/suppressions-page.test.tsx.
import SuppressionsPage from "@/app/(dashboard)/app/suppressions/page-client";
import { ApiError } from "@/lib/api";
import type * as SuppressionsAdminApiModule from "@/lib/suppressions-admin-api";
import type { SuppressionEntry } from "@/lib/suppressions-admin-api";
import type * as AdminGateModule from "@/lib/use-admin-gate";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listSuppressions: vi.fn(),
  addSuppression: vi.fn(),
  bulkImportSuppressions: vi.fn(),
  removeSuppression: vi.fn(),
  getSuppressionTrend: vi.fn(),
  useAdminGate: vi.fn(),
  routerReplace: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoami,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.routerReplace,
    push: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/app/suppressions",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/suppressions-admin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof SuppressionsAdminApiModule>();
  return {
    ...actual,
    listSuppressions: mocks.listSuppressions,
    addSuppression: mocks.addSuppression,
    bulkImportSuppressions: mocks.bulkImportSuppressions,
    removeSuppression: mocks.removeSuppression,
    getSuppressionTrend: mocks.getSuppressionTrend,
  };
});

vi.mock("@/lib/use-admin-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof AdminGateModule>();
  return {
    ...actual,
    useAdminGate: mocks.useAdminGate,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

const suppressed: SuppressionEntry = {
  id: "sup_1",
  email: "blocked@example.com",
  reason: "manual hold",
  created_at: "2026-06-27T12:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root };
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

function primeAuth(canWrite = true): void {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: canWrite ? "admin" : "viewer",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
  mocks.useAdminGate.mockReturnValue({
    role: canWrite ? "admin" : "viewer",
    canWrite,
    loading: false,
  });
  mocks.getSuppressionTrend.mockResolvedValue([]);
}

function findButton(name: string, occurrence = 0): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === name,
  );
  const button = buttons[occurrence];
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function changeInput(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SuppressionsPage query freshness", () => {
  it("keeps rapid local filter changes in the URL without asynchronous route replacements", async () => {
    primeAuth();
    mocks.listSuppressions.mockResolvedValue({
      items: [suppressed],
      total: 1,
      page: 1,
      size: 100,
    });
    const { root } = render(createElement(SuppressionsPage));
    try {
      await waitFor(() =>
        expect(
          document.querySelector('select[aria-label="Filter by reason"]'),
        ).not.toBeNull(),
      );
      const filter = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Filter by reason"]',
      )!;
      for (const reason of ["hard_bounce", "complaint", "dns_failure", ""]) {
        await act(async () => {
          changeInput(filter, reason);
          await flush();
        });
        expect(filter.value).toBe(reason);
        expect(
          new URLSearchParams(window.location.search).get("reason") ?? "",
        ).toBe(reason);
      }
      expect(mocks.routerReplace).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads suppressions and fetches a new query when the debounced search settles", async () => {
    primeAuth();
    mocks.listSuppressions
      .mockResolvedValueOnce({
        items: [suppressed],
        total: 1,
        page: 0,
        size: 100,
      })
      .mockResolvedValueOnce({
        items: [{ ...suppressed, id: "sup_2", email: "bounce@example.com" }],
        total: 1,
        page: 0,
        size: 100,
      });

    const { root } = render(createElement(SuppressionsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("blocked@example.com");
      });
      // An empty search sends no search parameter at all; a >=3-character
      // fragment becomes `q=`, and a full address becomes `email=`.
      expect(mocks.listSuppressions).toHaveBeenNthCalledWith(1, {
        page: 1,
        size: 100,
      });

      const search = document.querySelector(
        'input[placeholder="Search by email…"]',
      ) as HTMLInputElement;
      await act(async () => {
        changeInput(search, "bounce");
        // Wait past the 350ms search debounce so the applied query updates.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        await flush();
      });

      await waitFor(() => {
        expect(mocks.listSuppressions).toHaveBeenNthCalledWith(2, {
          q: "bounce",
          page: 1,
          size: 100,
        });
        expect(document.body.textContent).toContain("bounce@example.com");
      });
      expect(window.location.search).toBe("?q=bounce");
      expect(mocks.routerReplace).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows the admin-access message for 403 list failures", async () => {
    primeAuth(false);
    mocks.listSuppressions.mockRejectedValueOnce(
      new ApiError("forbidden", 403, { error: "forbidden" }),
    );

    const { root } = render(createElement(SuppressionsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "You need admin access to manage suppressions.",
        );
      });
      expect(document.body.textContent).toContain(
        "The suppression list is unavailable",
      );
      expect(document.body.textContent).not.toContain(
        "No suppressed addresses",
      );
      expect(document.body.textContent).not.toContain("Add address");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("restores query-backed filters from same-document browser history", async () => {
    primeAuth();
    mocks.listSuppressions.mockResolvedValue({
      items: [suppressed],
      total: 1,
      page: 0,
      size: 100,
    });
    window.history.replaceState(null, "", "/app/suppressions");

    const { root } = render(createElement(SuppressionsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("blocked@example.com");
      });

      await act(async () => {
        window.history.pushState(
          null,
          "",
          "/app/suppressions?reason=spam_complaint",
        );
        window.dispatchEvent(new Event("popstate"));
        await flush();
      });

      expect(
        (
          document.querySelector(
            'select[aria-label="Filter by reason"]',
          ) as HTMLSelectElement
        ).value,
      ).toBe("spam_complaint");
    } finally {
      act(() => {
        root.unmount();
      });
      window.history.replaceState(null, "", "/");
    }
  });

  it("invalidates and refetches the list after adding an address", async () => {
    primeAuth();
    mocks.listSuppressions
      .mockResolvedValueOnce({ items: [], total: 0, page: 0, size: 100 })
      .mockResolvedValueOnce({
        items: [suppressed],
        total: 1,
        page: 0,
        size: 100,
      });
    mocks.addSuppression.mockResolvedValueOnce(suppressed);

    const { root } = render(createElement(SuppressionsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("No suppressed addresses");
      });

      await act(async () => {
        findButton("Add address").click();
        await flush();
      });

      const email = document.querySelector("#s-email") as HTMLInputElement;
      const reason = document.querySelector("#s-reason") as HTMLSelectElement;
      await act(async () => {
        changeInput(email, "blocked@example.com");
        changeInput(reason, "list_manual");
        await flush();
      });

      await act(async () => {
        findButton("Add").click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.addSuppression).toHaveBeenCalledWith({
          email: "blocked@example.com",
          reason: "list_manual",
          // GOV-031: dialog defaults channel/scope; normalizeAddInput drops
          // these defaults before the API call.
          channel: "email",
          scope: "marketing",
        });
        expect(mocks.listSuppressions).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain("blocked@example.com");
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Address suppressed.");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
