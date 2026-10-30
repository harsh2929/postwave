// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETC-021: the IdentityProviderCard reflects the real linked state and offers
// a lockout-SAFE disconnect — when Google is the account's only sign-in method
// (no password) the disconnect is not offered.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listOAuthIdentities: vi.fn(),
  unlinkOAuthIdentity: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  listOAuthIdentities: mocks.listOAuthIdentities,
  unlinkOAuthIdentity: mocks.unlinkOAuthIdentity,
  oauthLinkStartUrl: (p: string) => `/api/v1/auth/oauth/${p}/start`,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { IdentityProviderCard } from "@/app/(dashboard)/app/settings/security/identity-provider-card";

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const WHOAMI = {
  user_id: "usr_1",
  tenant_id: "tnt_1",
  email: "me@x.com",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

beforeEach(() => {
  mocks.whoami.mockResolvedValue(WHOAMI);
  mocks.whoamiFresh.mockResolvedValue(WHOAMI);
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
  const root = trackRoot(container);
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    ),
  );
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}
async function waitFor(a: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 25; i += 1) {
    try {
      a();
      return;
    } catch (e) {
      last = e;
      await flush();
    }
  }
  throw last;
}
function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button,a")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

function exactButton(label: string, scope: ParentNode = document) {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function dialog() {
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

describe("SETC-021 IdentityProviderCard", () => {
  it("not linked → Connect Google", async () => {
    mocks.listOAuthIdentities.mockResolvedValue({
      identities: [],
      has_password: true,
      has_passkey: false,
    });
    render(createElement(IdentityProviderCard));
    await waitFor(() => {
      if (!button("Connect Google")) throw new Error("no connect");
    });
    expect(document.body.textContent).toContain("Not connected");
  });

  it("linked with a password → Connected + a Disconnect action", async () => {
    mocks.listOAuthIdentities.mockResolvedValue({
      identities: [
        {
          provider: "google",
          email: "me@x.com",
          linked_at: "2026-08-01T00:00:00Z",
        },
      ],
      has_password: true,
      has_passkey: false,
    });
    render(createElement(IdentityProviderCard));
    await waitFor(() => {
      if (!button("Disconnect")) throw new Error("no disconnect");
    });
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("me@x.com");
  });

  it("linked as the ONLY sign-in method (no password) → disconnect is NOT offered", async () => {
    mocks.listOAuthIdentities.mockResolvedValue({
      identities: [
        {
          provider: "google",
          email: "me@x.com",
          linked_at: "2026-08-01T00:00:00Z",
        },
      ],
      has_password: false,
      has_passkey: false,
    });
    render(createElement(IdentityProviderCard));
    await waitFor(() => {
      if (!document.body.textContent?.includes("Set a password to disconnect"))
        throw new Error("no lockout hint");
    });
    // No Disconnect button — the lockout is prevented in the UI, not just on the server.
    expect(button("Disconnect")).toBeFalsy();
    expect(mocks.unlinkOAuthIdentity).not.toHaveBeenCalled();
  });

  it("passkey-only user (no password) CAN disconnect — a passkey is a standing method", async () => {
    mocks.listOAuthIdentities.mockResolvedValue({
      identities: [
        {
          provider: "google",
          email: "me@x.com",
          linked_at: "2026-08-01T00:00:00Z",
        },
      ],
      has_password: false,
      has_passkey: true,
    });
    render(createElement(IdentityProviderCard));
    await waitFor(() => {
      if (!button("Disconnect")) throw new Error("no disconnect");
    });
    // A passkey user is NOT told to set a password.
    expect(document.body.textContent).not.toContain(
      "Set a password to disconnect",
    );
  });

  it("awaits disconnect, dedupes, retains failure, and retries in place", async () => {
    const pending = deferred<void>();
    mocks.listOAuthIdentities.mockResolvedValue({
      identities: [
        {
          provider: "google",
          email: "me@x.com",
          linked_at: "2026-08-01T00:00:00Z",
        },
      ],
      has_password: true,
      has_passkey: false,
    });
    mocks.unlinkOAuthIdentity
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined);
    const root = render(createElement(IdentityProviderCard));
    try {
      await waitFor(() => expect(button("Disconnect")).toBeTruthy());
      act(() => exactButton("Disconnect").click());
      act(() => {
        const submit = exactButton("Disconnect", dialog());
        submit.click();
        submit.click();
      });
      await waitFor(() =>
        expect(mocks.unlinkOAuthIdentity).toHaveBeenCalledTimes(1),
      );
      expect(mocks.unlinkOAuthIdentity).toHaveBeenCalledWith(
        "google",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          idempotencyKey: expect.any(String),
        }),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");

      await act(async () => pending.reject(new Error("Google unlink failed.")));
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Google unlink failed.");
      expect(document.activeElement).toBe(alert);
      await act(async () => {
        exactButton("Disconnect", dialog()).click();
        await flush();
      });
      expect(mocks.unlinkOAuthIdentity).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
