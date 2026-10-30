// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApiKeysPage from "@/app/(dashboard)/app/settings/api/page";
import type {
  ApiKey,
  ApiKeyCall,
  CreateApiKeyResponse,
  RotateApiKeyResponse,
} from "@/lib/api-keys-api";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  listApiKeyUsage: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  whoami: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/api-keys-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-keys-api")>();
  return {
    ...actual,
    createApiKey: mocks.createApiKey,
    listApiKeys: mocks.listApiKeys,
    listApiKeyUsage: mocks.listApiKeyUsage,
    revokeApiKey: mocks.revokeApiKey,
    rotateApiKey: mocks.rotateApiKey,
    updateApiKey: mocks.updateApiKey,
  };
});

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami };
});

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/components/copy-text-button", () => ({
  CopyTextButton: ({
    label = "Copy",
    copiedLabel: _copiedLabel,
    value,
  }: {
    label?: string;
    copiedLabel?: string;
    value: string;
  }) => (
    <button type="button" disabled={!value}>
      {label}
    </button>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY: ApiKey = {
  id: "key-1",
  tenantId: "tenant-1",
  label: "Production",
  prefix: "pw_live_1234",
  scopes: ["read:subscribers"],
  createdAt: "2026-08-01T00:00:00.000Z",
  lastUsedAt: null,
  sandboxOnly: false,
};

const CREATED_KEY: ApiKey = {
  ...API_KEY,
  id: "key-2",
  label: "Automation",
  prefix: "pw_live_5678",
};

function createResponse(): CreateApiKeyResponse {
  return { key: CREATED_KEY, plaintext: "pw_live_secret-once" };
}

function rotateResponse(): RotateApiKeyResponse {
  return {
    key: { ...API_KEY, id: "key-rotated", prefix: "pw_live_rotated" },
    plaintext: "pw_live_rotated-secret",
    revoked_id: API_KEY.id,
  };
}

function render(ui: ReactNode): { client: QueryClient; root: Root } {
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
  return { client, root };
}

function button(
  text: string,
  scope: ParentNode = document,
  occurrence = 0,
): HTMLButtonElement {
  const matches = Array.from(scope.querySelectorAll("button")).filter(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  const target = matches[occurrence];
  if (!target) throw new Error(`Button not found: ${text} (${occurrence})`);
  return target;
}

function dialog(): HTMLElement {
  const target = document.querySelector('[role="dialog"]');
  if (!(target instanceof HTMLElement)) throw new Error("Dialog not found");
  return target;
}

function inputByLabel(
  text: string,
  scope: ParentNode = dialog(),
): HTMLInputElement {
  const label = Array.from(scope.querySelectorAll("label")).find((candidate) =>
    candidate.textContent?.trim().startsWith(text),
  );
  const id = label instanceof HTMLLabelElement ? label.htmlFor : "";
  const target = id
    ? document.getElementById(id)
    : label?.querySelector("input");
  if (!(target instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label: ${text}`);
  }
  return target;
}

function checkboxByLabel(
  text: string,
  scope: ParentNode = dialog(),
): HTMLInputElement {
  const label = Array.from(scope.querySelectorAll("label")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const target = label?.querySelector('input[type="checkbox"]');
  if (!(target instanceof HTMLInputElement)) {
    throw new Error(`Checkbox not found: ${text}`);
  }
  return target;
}

function change(target: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickCheckbox(target: HTMLInputElement): void {
  target.click();
}

function submitCurrentDialog(): void {
  const form = dialog().querySelector("form");
  if (!(form instanceof HTMLFormElement))
    throw new Error("Dialog form missing");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue({
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "owner@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  });
  mocks.listApiKeys.mockResolvedValue([API_KEY]);
  mocks.listApiKeyUsage.mockResolvedValue([]);
  mocks.createApiKey.mockResolvedValue(createResponse());
  mocks.updateApiKey.mockResolvedValue(API_KEY);
  mocks.revokeApiKey.mockResolvedValue({ ok: true });
  mocks.rotateApiKey.mockResolvedValue(rotateResponse());
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("settings API key dialogs", () => {
  it.each([
    ["viewer mode", { role: "owner", effective_role: "owner", viewer_mode: true }],
    ["a non-admin role", { role: "editor", effective_role: "editor", viewer_mode: false }],
  ])("does not request admin data in %s", async (_label, authority) => {
    mocks.whoami.mockResolvedValue({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "member@postwave.test",
      ...authority,
    });
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("require an owner or administrator"),
      );
      expect(mocks.listApiKeys).not.toHaveBeenCalled();
      expect(mocks.listApiKeyUsage).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(API_KEY.prefix);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("does not request admin data when identity verification fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("Session verification failed."));
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("access could not be verified"),
      );
      expect(mocks.listApiKeys).not.toHaveBeenCalled();
      expect(mocks.listApiKeyUsage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("validates, deduplicates, retries, and protects the one-time create secret", async () => {
    let resolveRetry: ((value: CreateApiKeyResponse) => void) | undefined;
    mocks.createApiKey
      .mockResolvedValueOnce({ ...createResponse(), plaintext: "" })
      .mockImplementationOnce(
        () =>
          new Promise<CreateApiKeyResponse>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() => expect(button("Create new key")).toBeDefined());
      const trigger = button("Create new key");
      await act(async () => trigger.click());
      await act(async () => submitCurrentDialog());
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
        "Enter a label",
      );
      expect(mocks.createApiKey).not.toHaveBeenCalled();

      await act(async () => {
        change(inputByLabel("Label"), "Automation");
        clickCheckbox(checkboxByLabel("Read subscribers"));
        submitCurrentDialog();
      });
      await waitFor(() =>
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
          "invalid key acknowledgement",
        ),
      );

      await act(async () => {
        submitCurrentDialog();
        submitCurrentDialog();
      });
      expect(mocks.createApiKey).toHaveBeenCalledTimes(2);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(button("Cancel", dialog()).disabled).toBe(true);
      await act(async () => pressEscape());
      expect(dialog().textContent).toContain("Create an API key");

      await act(async () => resolveRetry?.(createResponse()));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Save this key now"),
      );
      expect(dialog().textContent).toContain("pw_live_secret-once");

      await act(async () => button("Close", dialog()).click());
      expect(dialog().textContent).toContain("Save this key now");
      expect(mocks.toastWarning).toHaveBeenCalled();

      await act(async () =>
        clickCheckbox(checkboxByLabel("I've stored it safely")),
      );
      await act(async () => button("Done", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("detects an edit no-op and keeps a failed update retryable", async () => {
    mocks.updateApiKey
      .mockRejectedValueOnce(new Error("Key changed in another session."))
      .mockResolvedValueOnce({ ...API_KEY, label: "Primary production" });
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() => expect(button("Edit")).toBeDefined());
      const trigger = button("Edit");
      await act(async () => trigger.click());
      expect(dialog().textContent).toContain("No changes to save.");
      expect(button("Save changes", dialog()).disabled).toBe(true);
      expect(mocks.updateApiKey).not.toHaveBeenCalled();

      await act(async () =>
        change(inputByLabel("Label"), "Primary production"),
      );
      await act(async () => {
        button("Save changes", dialog()).click();
        button("Save changes", dialog()).click();
      });
      expect(mocks.updateApiKey).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
          "Key changed in another session.",
        ),
      );

      await act(async () => button("Save changes", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(mocks.updateApiKey).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("distinguishes recent-request loading, error, retry data, and close focus", async () => {
    let rejectUsage: ((reason: Error) => void) | undefined;
    mocks.listApiKeyUsage.mockImplementationOnce(
      () =>
        new Promise<ApiKeyCall[]>((_, reject) => {
          rejectUsage = reject;
        }),
    );
    const usage: ApiKeyCall = {
      id: 42,
      method: "POST",
      path: "/api/v1/subscribers",
      toolName: "subscribers.create",
      statusCode: 202,
      latencyMs: 31,
      calledAt: "2026-08-25T12:00:00.000Z",
    };
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() => expect(button("Usage")).toBeDefined());
      const trigger = button("Usage");
      await act(async () => trigger.click());
      expect(
        dialog().querySelector(
          '[role="status"][aria-label="Loading recent API key requests"]',
        ),
      ).not.toBeNull();

      await act(async () =>
        rejectUsage?.(new Error("Usage feed unavailable.")),
      );
      await waitFor(() =>
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
          "Usage feed unavailable.",
        ),
      );
      mocks.listApiKeyUsage.mockResolvedValueOnce([usage]);
      await act(async () => button("Retry recent requests", dialog()).click());
      await waitFor(() =>
        expect(dialog().textContent).toContain("subscribers.create"),
      );
      expect(dialog().textContent).toContain("202");

      await act(async () => button("Close", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("requires the exact revoke token, locks pending dismissal, and retries inline", async () => {
    let rejectRevoke: ((reason: Error) => void) | undefined;
    mocks.revokeApiKey
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true }>((_, reject) => {
            rejectRevoke = reject;
          }),
      )
      .mockResolvedValueOnce({ ok: true });
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() => expect(button("Revoke")).toBeDefined());
      await act(async () => button("Revoke").click());
      const token = inputByLabel("Type");
      expect(button("Revoke key", dialog()).disabled).toBe(true);
      await act(async () => change(token, "production"));
      expect(token.getAttribute("aria-invalid")).toBe("true");
      expect(button("Revoke key", dialog()).disabled).toBe(true);

      await act(async () => change(token, "Production"));
      await act(async () => {
        button("Revoke key", dialog()).click();
        button("Revoke key", dialog()).click();
      });
      expect(mocks.revokeApiKey).toHaveBeenCalledTimes(1);
      expect(token.disabled).toBe(true);
      await act(async () => pressEscape());
      expect(dialog().textContent).toContain("Revoke this key?");

      await act(async () =>
        rejectRevoke?.(new Error("Key changed in another session.")),
      );
      await waitFor(() =>
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
          "Key changed in another session.",
        ),
      );
      await act(async () => button("Revoke key", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(button("Create new key")),
      );
      expect(mocks.revokeApiKey).toHaveBeenCalledTimes(2);
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Key revoked.");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("deduplicates rotation, keeps its failure inline, and gates the replacement secret", async () => {
    let rejectRotate: ((reason: Error) => void) | undefined;
    mocks.rotateApiKey
      .mockImplementationOnce(
        () =>
          new Promise<RotateApiKeyResponse>((_, reject) => {
            rejectRotate = reject;
          }),
      )
      .mockResolvedValueOnce(rotateResponse());
    const { client, root } = render(<ApiKeysPage />);
    try {
      await waitFor(() => expect(button("Rotate")).toBeDefined());
      await act(async () => button("Rotate").click());
      await act(async () => {
        button("Rotate and revoke old key", dialog()).click();
        button("Rotate and revoke old key", dialog()).click();
      });
      expect(mocks.rotateApiKey).toHaveBeenCalledTimes(1);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      await act(async () => pressEscape());
      expect(dialog().textContent).toContain("Rotate this key?");

      await act(async () =>
        rejectRotate?.(new Error("Step-up verification expired.")),
      );
      await waitFor(() =>
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
          "Step-up verification expired.",
        ),
      );
      await act(async () =>
        button("Rotate and revoke old key", dialog()).click(),
      );
      await waitFor(() =>
        expect(dialog().textContent).toContain("Save this key now"),
      );
      expect(dialog().textContent).toContain("pw_live_rotated-secret");
      await act(async () =>
        clickCheckbox(checkboxByLabel("I've stored it safely")),
      );
      await act(async () => button("Done", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(button("Create new key")),
      );
      expect(mocks.rotateApiKey).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});
