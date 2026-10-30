// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoleScopeMatrix } from "@/app/(dashboard)/app/settings/team/role-scope-matrix";

const mocks = vi.hoisted(() => ({
  listRoles: vi.fn(),
  updateRoleScopes: vi.fn(),
}));

vi.mock("@/lib/team-roles-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/team-roles-api")>(
    "@/lib/team-roles-api",
  );
  return {
    ...actual,
    listRoles: mocks.listRoles,
    updateRoleScopes: mocks.updateRoleScopes,
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: vi.fn().mockResolvedValue({}),
}));

const IDENTITY = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test workspace",
  workspace_slug: "test-workspace",
};

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function render(): { client: QueryClient; root: Root } {
  const client = new QueryClient({
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
      createElement(
        QueryClientProvider,
        { client },
        createElement(RoleScopeMatrix, {
          canWrite: true,
          identityLoading: false,
          identityReady: true,
          role: "owner",
          tenantId: "tenant-1",
          userId: "user-1",
          viewerMode: false,
          identity: IDENTITY,
        }),
      ),
    );
  });
  return { client, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

function button(text: string, scope: ParentNode = document) {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function dialog() {
  const match = document.querySelector('[role="dialog"]');
  if (!(match instanceof HTMLElement)) throw new Error("Dialog not found");
  return match;
}

beforeEach(() => {
  mocks.listRoles.mockResolvedValue({
    roles: [
      {
        id: "role-editor",
        name: "editor",
        description: "Content authors",
        assignedScopes: [],
        createdAt: "2026-08-20T09:00:00Z",
        updatedAt: "2026-08-20T09:00:00Z",
      },
    ],
    availableScopes: ["audit:read", "audit:execute_actions"],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("team high-privilege scope grant", () => {
  it("dedupes same-tick low-risk toggles by stable role identity", async () => {
    const pending = deferred<unknown>();
    mocks.updateRoleScopes.mockReturnValueOnce(pending.promise);
    const { root } = render();
    try {
      await waitFor(() =>
        expect(
          document.querySelector('input[aria-label="editor: audit:read"]'),
        ).toBeTruthy(),
      );
      const checkbox = document.querySelector(
        'input[aria-label="editor: audit:read"]',
      ) as HTMLInputElement;
      const target = checkbox.closest("label");
      expect(target?.className).toContain("size-11");

      act(() => {
        checkbox.click();
        checkbox.click();
      });
      await waitFor(() =>
        expect(mocks.updateRoleScopes).toHaveBeenCalledTimes(1),
      );
      expect(mocks.updateRoleScopes).toHaveBeenCalledWith(
        "role-editor",
        ["audit:read"],
        expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
      );
      await act(async () => pending.resolve({ ok: true }));
    } finally {
      act(() => root.unmount());
    }
  });

  it("awaits the exact grant, dedupes, rolls back failure, and retries in the dialog", async () => {
    const pending = deferred<unknown>();
    mocks.updateRoleScopes
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true });
    const { client, root } = render();
    try {
      await waitFor(() =>
        expect(
          document.querySelector(
            'input[aria-label="editor: audit:execute_actions"]',
          ),
        ).toBeTruthy(),
      );
      const checkbox = document.querySelector(
        'input[aria-label="editor: audit:execute_actions"]',
      ) as HTMLInputElement;
      act(() => checkbox.click());
      expect(dialog().textContent).toContain("broad audit/admin capability");
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(checkbox);
      });
      act(() => checkbox.click());
      expect(dialog().textContent).toContain("broad audit/admin capability");
      act(() => {
        client.setQueryData(["settings", "tenant-1", "owner", "team-roles"], {
          roles: [
            {
              id: "role-editor",
              name: "editor",
              description: "Content authors",
              assignedScopes: ["audit:read"],
              createdAt: "2026-08-20T09:00:00Z",
              updatedAt: "2026-08-27T09:00:00Z",
            },
          ],
          availableScopes: ["audit:read", "audit:execute_actions"],
        });
      });
      act(() => {
        const grant = button("Grant scope", dialog());
        grant.click();
        grant.click();
      });
      await waitFor(() =>
        expect(mocks.updateRoleScopes).toHaveBeenCalledTimes(1),
      );
      expect(mocks.updateRoleScopes).toHaveBeenCalledWith(
        "role-editor",
        ["audit:execute_actions"],
        expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(dialog()).toBeTruthy();

      await act(async () => pending.reject(new Error("Scope grant failed.")));
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Scope grant failed.");
      expect(document.activeElement).toBe(alert);
      await waitFor(() => expect(checkbox.checked).toBe(false));

      await act(async () => button("Grant scope", dialog()).click());
      expect(mocks.updateRoleScopes).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
