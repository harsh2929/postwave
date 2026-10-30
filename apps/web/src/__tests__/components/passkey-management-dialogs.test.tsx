// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PasskeysCard } from "@/app/(dashboard)/app/settings/security/passkeys-card";

const mocks = vi.hoisted(() => ({
  deletePasskey: vi.fn(),
  listPasskeys: vi.fn(),
  renamePasskey: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-passkey", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-passkey")>(
      "@/lib/auth-passkey",
    );
  return {
    ...actual,
    deletePasskey: mocks.deletePasskey,
    listPasskeys: mocks.listPasskeys,
    passkeySupported: () => true,
    registerPasskey: vi.fn(),
    renamePasskey: mocks.renamePasskey,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const PASSKEY = {
  id: "passkey-1",
  name: "MacBook Touch ID",
  created_at: "2026-08-20T09:00:00Z",
  last_used_at: "2026-08-25T09:00:00Z",
  backed_up: true,
};

const WHOAMI = {
  user_id: "usr_1",
  tenant_id: "tnt_1",
  email: "ada@example.com",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function render(ui: ReactNode): Root {
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
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
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

function input() {
  const match = document.querySelector("#passkey-name");
  if (!(match instanceof HTMLInputElement)) throw new Error("Input not found");
  return match;
}

function changeInput(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(WHOAMI);
  mocks.whoamiFresh.mockResolvedValue(WHOAMI);
  mocks.listPasskeys.mockResolvedValue([PASSKEY]);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("passkey management dialogs", () => {
  it("returns focus to the external rename trigger after an Escape close", async () => {
    const root = render(createElement(PasskeysCard));
    try {
      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Rename MacBook Touch ID"]',
          ),
        ).toBeTruthy(),
      );
      const renameTrigger = document.querySelector(
        'button[aria-label="Rename MacBook Touch ID"]',
      ) as HTMLButtonElement;
      act(() => renameTrigger.click());
      await waitFor(() => expect(dialog()).toBeTruthy());

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await flush();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(document.activeElement).toBe(renameTrigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("dedupes rename, freezes the draft, blocks dismissal, and retries a focused inline failure", async () => {
    const pending = deferred<{ ok: boolean; name: string }>();
    mocks.renamePasskey
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, name: "Travel key" });
    const root = render(createElement(PasskeysCard));
    try {
      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Rename MacBook Touch ID"]',
          ),
        ).toBeTruthy(),
      );
      act(() => {
        (
          document.querySelector(
            'button[aria-label="Rename MacBook Touch ID"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(input().value).toBe("MacBook Touch ID");
      expect(button("Save", dialog()).disabled).toBe(true);
      act(() => changeInput(input(), "  Travel key  "));
      act(() => {
        const submit = button("Save", dialog());
        submit.click();
        submit.click();
      });
      await waitFor(() => expect(mocks.renamePasskey).toHaveBeenCalledTimes(1));
      expect(mocks.renamePasskey).toHaveBeenCalledWith(
        "passkey-1",
        "Travel key",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          idempotencyKey: expect.any(String),
        }),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(input().disabled).toBe(true);
      expect(button("Cancel", dialog()).disabled).toBe(true);
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(dialog()).toBeTruthy();

      await act(async () => pending.reject(new Error("Rename failed.")));
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Rename failed.");
      expect(document.activeElement).toBe(alert);
      expect(input().value).toBe("  Travel key  ");

      await act(async () => button("Save", dialog()).click());
      expect(mocks.renamePasskey).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("dedupes removal, keeps the named confirmation open, and retries its inline failure", async () => {
    const pending = deferred<{ ok: boolean }>();
    mocks.deletePasskey
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true });
    const root = render(createElement(PasskeysCard));
    try {
      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Delete MacBook Touch ID"]',
          ),
        ).toBeTruthy(),
      );
      act(() => {
        (
          document.querySelector(
            'button[aria-label="Delete MacBook Touch ID"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(dialog().textContent).toContain("MacBook Touch ID");
      act(() => {
        const submit = button("Remove passkey", dialog());
        submit.click();
        submit.click();
      });
      await waitFor(() => expect(mocks.deletePasskey).toHaveBeenCalledTimes(1));
      expect(mocks.deletePasskey).toHaveBeenCalledWith(
        "passkey-1",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          idempotencyKey: expect.any(String),
        }),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(button("Cancel", dialog()).disabled).toBe(true);
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(dialog()).toBeTruthy();

      await act(async () => pending.reject(new Error("Remove failed.")));
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Remove failed.");
      expect(document.activeElement).toBe(alert);
      await act(async () => button("Remove passkey", dialog()).click());
      expect(mocks.deletePasskey).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
