// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETC-010: the roster renders workspace members and gates every mutating
// control on the write role — an owner sees role Selects, Remove, and Invite;
// a viewer sees the roster read-only. Own-row controls are always disabled.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamRoster } from "@/app/(dashboard)/app/settings/team/team-roster";

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  listMembers: vi.fn(),
  listInvites: vi.fn(),
}));

vi.mock("@/lib/team-members-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/team-members-api")>();
  return {
    ...actual, // keep the pure helpers (labels, assignableRoleOptions, url)
    createInvite: mocks.createInvite,
    listMembers: mocks.listMembers,
    listInvites: mocks.listInvites,
  };
});
vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: vi.fn().mockResolvedValue({}),
}));

const IDENTITY = {
  user_id: "user-1",
  tenant_id: "tnt_1",
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
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function primeData(callerIsOwner = true) {
  mocks.listMembers.mockResolvedValue({
    members: [
      {
        id: "u_self",
        email: "me@acme.com",
        role: "owner",
        status: "active",
        authProvider: "password",
        emailVerified: true,
        effectiveScopes: [],
        isSelf: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "u_ed",
        email: "ed@acme.com",
        role: "editor",
        status: "active",
        authProvider: "password",
        emailVerified: false,
        effectiveScopes: [],
        isSelf: false,
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ],
    total: 2,
    limit: 100,
    offset: 0,
    assignableRoles: ["owner", "admin", "editor", "viewer"],
    assignableStatus: ["active", "suspended"],
    callerIsOwner,
  });
  mocks.listInvites.mockResolvedValue({
    invites: [
      {
        id: "inv_1",
        email: "pending@acme.com",
        role: "admin",
        createdAt: "2026-01-03T00:00:00Z",
        expiresAt: "2026-02-03T00:00:00Z",
      },
    ],
  });
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
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
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.includes(text) === true,
  );
}

function change(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitInviteForm(): void {
  const form = document.querySelector('[role="dialog"] form');
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Invite form not found");
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("TeamRoster (SETC-010)", () => {
  it("shows the roster + write controls for an owner", async () => {
    primeData();
    const root = render(
      createElement(TeamRoster, {
        canWrite: true,
        callerCanOwner: true,
        tenantId: "tnt_1",
        role: "owner",
        identityReady: true,
        identity: IDENTITY,
      }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("me@acme.com");
        expect(document.body.textContent).toContain("ed@acme.com");
        // Pending invite is listed.
        expect(document.body.textContent).toContain("pending@acme.com");
      });
      // Owner sees Invite + a Remove for the non-self editor.
      expect(button("Invite")).toBeDefined();
      expect(button("Remove")).toBeDefined();
      // A role Select renders for the editor row (not the self row).
      const selects = document.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(1);
      // Own row is marked and has no Select/Remove.
      expect(document.body.textContent).toContain("(you)");
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows a read-only notice for a viewer and never fetches the admin-scoped roster", async () => {
    primeData();
    const root = render(
      createElement(TeamRoster, {
        canWrite: false,
        callerCanOwner: false,
        tenantId: "tnt_1",
        role: "viewer",
        identityReady: true,
        identity: IDENTITY,
      }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Only an owner or admin can view and manage",
        );
      });
      // No write controls, and the admin-only roster + invites are never
      // fetched (the GET would 403 for a viewer).
      expect(button("Invite")).toBeUndefined();
      expect(button("Remove")).toBeUndefined();
      expect(document.querySelectorAll("select").length).toBe(0);
      expect(document.body.textContent).not.toContain("ed@acme.com");
      expect(mocks.listMembers).not.toHaveBeenCalled();
      expect(mocks.listInvites).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("creates one normalized invite, locks dismissal while pending, and resets after completion", async () => {
    primeData();
    let resolveInvite:
      | ((value: {
          invite: {
            id: string;
            email: string;
            role: "editor";
            createdAt: string;
            expiresAt: string;
          };
          token: string;
        }) => void)
      | undefined;
    mocks.createInvite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvite = resolve;
        }),
    );
    const root = render(
      createElement(TeamRoster, {
        canWrite: true,
        callerCanOwner: true,
        tenantId: "tnt_1",
        role: "owner",
        identityReady: true,
        identity: IDENTITY,
      }),
    );
    try {
      await waitFor(() => expect(button("Invite")).toBeDefined());
      const inviteTrigger = button("Invite");
      await act(async () => inviteTrigger?.click());
      expect(document.body.textContent).toContain("Invite a teammate");

      const email = document.getElementById("invite-email");
      if (!(email instanceof HTMLInputElement)) {
        throw new Error("Invite email field not found");
      }
      await act(async () => change(email, "  Person@Example.TEST  "));
      const close = button("Close");
      await act(async () => {
        submitInviteForm();
        close?.click();
        submitInviteForm();
      });

      expect(mocks.createInvite).toHaveBeenCalledTimes(1);
      expect(mocks.createInvite).toHaveBeenCalledWith(
        "person@example.test",
        "editor",
        expect.objectContaining({
          idempotencyKey: null,
          maxAttempts: 1,
          requireOnline: true,
        }),
      );
      const dialog = document.querySelector('[role="dialog"]');
      await waitFor(() => {
        expect(dialog?.getAttribute("aria-busy")).toBe("true");
        expect(email.disabled).toBe(true);
        expect(close?.disabled).toBe(true);
        expect(close?.getAttribute("aria-disabled")).toBe("true");
      });

      await act(async () => close?.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        resolveInvite?.({
          invite: {
            id: "inv_new",
            email: "person@example.test",
            role: "editor",
            createdAt: "2026-08-26T00:00:00Z",
            expiresAt: "2026-09-02T00:00:00Z",
          },
          token: "token with reserved/value",
        });
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "/accept-invite?token=token%20with%20reserved%2Fvalue",
        );
      });

      await act(async () => button("Done")?.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(inviteTrigger));
      await act(async () => inviteTrigger?.click());
      await waitFor(() => {
        const resetEmail = document.getElementById("invite-email");
        expect(resetEmail).toBeInstanceOf(HTMLInputElement);
        expect((resetEmail as HTMLInputElement).value).toBe("");
      });
      expect(document.body.textContent).not.toContain(
        "token%20with%20reserved%2Fvalue",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a failed invite retryable and never offers owner to an admin", async () => {
    primeData(false);
    mocks.createInvite
      .mockRejectedValueOnce(new Error("An active invite already exists."))
      .mockResolvedValueOnce({
        invite: {
          id: "inv_retry",
          email: "retry@example.test",
          role: "admin",
          createdAt: "2026-08-26T00:00:00Z",
          expiresAt: "2026-09-02T00:00:00Z",
        },
        token: "retry-token",
      });
    const root = render(
      createElement(TeamRoster, {
        canWrite: true,
        callerCanOwner: false,
        tenantId: "tnt_1",
        role: "admin",
        identityReady: true,
        identity: IDENTITY,
      }),
    );
    try {
      await waitFor(() => expect(button("Invite")).toBeDefined());
      await act(async () => button("Invite")?.click());
      const email = document.getElementById("invite-email");
      const role = document.getElementById("invite-role");
      if (
        !(email instanceof HTMLInputElement) ||
        !(role instanceof HTMLSelectElement)
      ) {
        throw new Error("Invite controls not found");
      }
      expect(
        Array.from(role.options).map((option) => option.value),
      ).not.toContain("owner");
      await act(async () => change(email, "retry@example.test"));
      await act(async () => change(role, "admin"));
      await act(async () => submitInviteForm());
      await waitFor(() => {
        const alert = document.querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain(
          "An active invite already exists.",
        );
        expect(document.activeElement).toBe(alert);
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => submitInviteForm());
      await waitFor(() =>
        expect(document.body.textContent).toContain("retry-token"),
      );
      expect(mocks.createInvite).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
