// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScimAdminSection } from "@/app/(dashboard)/app/settings/security/scim-admin-section";
import { ApiError } from "@/lib/api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listScimTokens: vi.fn(),
  mintScimToken: vi.fn(),
  revokeScimToken: vi.fn(),
  listRoleMappings: vi.fn(),
  upsertRoleMapping: vi.fn(),
  deleteRoleMapping: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("@/lib/scim-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scim-api")>();
  return {
    ...actual,
    listScimTokens: mocks.listScimTokens,
    mintScimToken: mocks.mintScimToken,
    revokeScimToken: mocks.revokeScimToken,
    listRoleMappings: mocks.listRoleMappings,
    upsertRoleMapping: mocks.upsertRoleMapping,
    deleteRoleMapping: mocks.deleteRoleMapping,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
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
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
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

function primeAuth(): void {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    mfa_satisfied: true,
  });
}

function setValue(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as typeof HTMLInputElement.prototype,
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

function dialog(): HTMLElement {
  const match = document.querySelector('[role="dialog"]');
  if (!(match instanceof HTMLElement)) throw new Error("Dialog not found");
  return match;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("ScimAdminSection", () => {
  it("keeps token minting inside the SCIM provisioning section", async () => {
    primeAuth();
    mocks.listScimTokens.mockResolvedValue([]);
    mocks.listRoleMappings.mockResolvedValue([]);
    mocks.mintScimToken.mockResolvedValue({
      token: "pst_secret_full_token",
      prefix: "pst_live",
      warning: "Shown once",
    });
    mocks.upsertRoleMapping.mockResolvedValue({
      id: "map_1",
      group_name: "Marketing",
      role: "admin",
      precedence: 7,
      created_at: "2026-06-28T00:00:00.000Z",
    });

    const root = render(createElement(ScimAdminSection));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("No SCIM tokens yet");
        // SETC-011: active SCIM mapping is surfaced without claiming that the
        // unavailable SAML/JIT sign-in path consumes it.
        expect(document.body.textContent).toContain("SCIM group");
        expect(document.body.textContent).toContain(
          "apply when SCIM provisions or activates a user",
        );
        expect(document.body.textContent).toContain(
          "SAML/JIT sign-in remains unavailable",
        );
      });

      act(() => {
        setValue(
          document.querySelector("#scim-desc") as HTMLInputElement,
          "Okta production",
        );
      });
      await act(async () => {
        buttonByText("Mint token").click();
        await flush();
      });
      await waitFor(() => {
        expect(mocks.mintScimToken).toHaveBeenCalledWith(
          "Okta production",
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            idempotencyKey: expect.any(String),
          }),
        );
        expect(document.body.textContent).toContain("pst_secret_full_token");
        expect(
          document.querySelector<HTMLInputElement>("#scim-desc")?.value,
        ).toBe("");
      });

      expect(mocks.listRoleMappings).toHaveBeenCalled();
      // No mapping was submitted in this test.
      expect(mocks.upsertRoleMapping).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("renders an explicit authority error on admin-scope 403s", async () => {
    primeAuth();
    const forbidden = new ApiError("Forbidden", 403);
    mocks.listScimTokens.mockRejectedValue(forbidden);
    mocks.listRoleMappings.mockRejectedValue(forbidden);

    const root = render(createElement(ScimAdminSection));

    try {
      await waitFor(() => {
        expect(mocks.listScimTokens).toHaveBeenCalledTimes(1);
        // Both admin cards query independently and retain a truthful error
        // instead of turning a refused security read into an empty section.
        expect(mocks.listRoleMappings).toHaveBeenCalled();
        expect(document.body.textContent).toContain("SCIM provisioning tokens");
        expect(document.body.textContent).toContain(
          "SCIM group → role mappings",
        );
        expect(document.body.textContent).toContain(
          "SCIM token access was refused",
        );
        expect(document.body.textContent).toContain(
          "SCIM mapping access was refused",
        );
      });
      expect(mocks.toastError).toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("awaits mapping deletion, dedupes, and retries a focused inline failure", async () => {
    primeAuth();
    const pending = deferred<void>();
    mocks.listScimTokens.mockResolvedValue([]);
    mocks.listRoleMappings.mockResolvedValue([
      {
        id: "mapping-1",
        group_name: "okta-admins",
        role: "admin",
        precedence: 10,
        created_at: "2026-08-20T09:00:00Z",
      },
    ]);
    mocks.deleteRoleMapping
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined);
    const root = render(createElement(ScimAdminSection));
    try {
      await waitFor(() => expect(buttonByText("Delete")).toBeTruthy());
      act(() => buttonByText("Delete").click());
      expect(dialog().textContent).toContain("okta-admins");
      act(() => {
        const confirm = Array.from(dialog().querySelectorAll("button")).find(
          (candidate) => candidate.textContent?.trim() === "Delete",
        ) as HTMLButtonElement;
        confirm.click();
        confirm.click();
      });
      await waitFor(() =>
        expect(mocks.deleteRoleMapping).toHaveBeenCalledTimes(1),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");

      await act(async () =>
        pending.reject(new Error("Mapping delete failed.")),
      );
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Mapping delete failed.");
      expect(document.activeElement).toBe(alert);
      await act(async () => {
        const retry = Array.from(dialog().querySelectorAll("button")).find(
          (candidate) => candidate.textContent?.trim() === "Delete",
        ) as HTMLButtonElement;
        retry.click();
        await flush();
      });
      expect(mocks.deleteRoleMapping).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
