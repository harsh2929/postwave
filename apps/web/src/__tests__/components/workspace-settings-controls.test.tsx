// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  getExport: vi.fn(),
  updateExport: vi.fn(),
  getWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  successToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, error: vi.fn() },
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

vi.mock("@/lib/workspace-settings-controls-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workspace-settings-controls-api")
  >()),
  getExportRetentionPolicy: mocks.getExport,
  updateExportRetentionPolicy: mocks.updateExport,
  getWebhookOwnerEmailPreference: mocks.getWebhook,
  updateWebhookOwnerEmailPreference: mocks.updateWebhook,
}));

import { ExportRetentionPolicyCard } from "@/components/settings/export-retention-policy-card";
import { UnsavedChangesProvider } from "@/components/settings/unsaved-changes";
import { WebhookOwnerEmailPreferenceCard } from "@/components/settings/webhook-owner-email-preference-card";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const OWNER = {
  user_id: USER_ID,
  tenant_id: TENANT_ID,
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

function exportPolicy(overrides = {}) {
  return {
    retentionDays: 30,
    maxPerTenant: 20,
    currentStorageBytes: 2_048,
    updatedAt: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

function webhookPreference(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    notifyAutoDisabled: true,
    notifyFailureRate: false,
    failureRatePct: 20,
    notifyLatency: false,
    latencyMs: 5_000,
    lastAlertedAt: null,
    updatedAt: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExportRetentionPolicyCard", () => {
  it("renders verified values, protects a dirty form, and saves after fresh checks", async () => {
    mocks.getExport
      .mockResolvedValueOnce(exportPolicy())
      .mockResolvedValueOnce(exportPolicy());
    mocks.updateExport.mockResolvedValue(
      exportPolicy({ retentionDays: 45, updatedAt: "2026-08-30T10:01:00Z" }),
    );
    const root = render(createElement(ExportRetentionPolicyCard));
    try {
      await flush();
      const days = input("export-policy-days");
      expect(days.value).toBe("30");
      change(days, "45");
      expect(button("Save export policy").disabled).toBe(false);

      act(() => button("Save export policy").click());
      await flush(8);

      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.updateExport).toHaveBeenCalledWith(
        { retentionDays: 45, maxPerTenant: 20 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(document.body.textContent).toContain(
        "Export retention policy updated and read back from the server.",
      );
      expect(button("Save export policy").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks a stale write and lets the operator adopt latest values", async () => {
    mocks.getExport
      .mockResolvedValueOnce(exportPolicy())
      .mockResolvedValueOnce(
        exportPolicy({ retentionDays: 60, updatedAt: "2026-08-30T11:00:00Z" }),
      );
    const root = render(createElement(ExportRetentionPolicyCard));
    try {
      await flush();
      change(input("export-policy-days"), "45");
      act(() => button("Save export policy").click());
      await flush(8);

      expect(mocks.updateExport).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "changed after you opened this form",
      );
      act(() => button("Load latest server values").click());
      expect(input("export-policy-days").value).toBe("60");
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes a failed load from empty state and retries", async () => {
    mocks.getExport
      .mockRejectedValueOnce(new Error("retention unavailable"))
      .mockResolvedValueOnce(exportPolicy());
    const root = render(createElement(ExportRetentionPolicyCard));
    try {
      await flush();
      expect(document.body.textContent).toContain("retention unavailable");
      act(() => button("Retry").click());
      await flush();
      expect(input("export-policy-days").value).toBe("30");
      expect(mocks.getExport).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("WebhookOwnerEmailPreferenceCard", () => {
  it("fails closed for admins because their user-scoped write is inert", async () => {
    mocks.whoami.mockResolvedValue({ ...OWNER, role: "admin" });
    const root = render(createElement(WebhookOwnerEmailPreferenceCard));
    try {
      await flush();
      expect(document.body.textContent).toContain(
        "Only the owner can change this recipient",
      );
      expect(mocks.getWebhook).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("saves the owner toggle, verifies read-back, and preserves dirty state until success", async () => {
    mocks.getWebhook
      .mockResolvedValueOnce(webhookPreference())
      .mockResolvedValueOnce(webhookPreference())
      .mockResolvedValueOnce(
        webhookPreference({
          notifyAutoDisabled: false,
          updatedAt: "2026-08-30T10:01:00Z",
        }),
      );
    mocks.updateWebhook.mockResolvedValue(undefined);
    const root = render(createElement(WebhookOwnerEmailPreferenceCard));
    try {
      await flush();
      const toggle = input("webhook-auto-pause-owner-email");
      expect(toggle.checked).toBe(true);
      act(() => toggle.click());
      expect(button("Save owner email preference").disabled).toBe(false);
      act(() => button("Save owner email preference").click());
      await flush(10);

      expect(mocks.updateWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          notifyFailureRate: false,
          failureRatePct: 20,
          notifyLatency: false,
          latencyMs: 5_000,
        }),
        false,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(document.body.textContent).toContain(
        "Owner email after webhook auto-pause is disabled.",
      );
      expect(button("Save owner email preference").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("reports a failed owner read without inventing a default and retries", async () => {
    mocks.getWebhook
      .mockRejectedValueOnce(new Error("preference unavailable"))
      .mockResolvedValueOnce(webhookPreference());
    const root = render(createElement(WebhookOwnerEmailPreferenceCard));
    try {
      await flush();
      expect(document.body.textContent).toContain("preference unavailable");
      expect(
        document.getElementById("webhook-auto-pause-owner-email"),
      ).toBeNull();

      act(() => button("Retry").click());
      await flush();

      expect(input("webhook-auto-pause-owner-email").checked).toBe(true);
      expect(mocks.getWebhook).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks replacement when any preserved server field changed", async () => {
    mocks.getWebhook
      .mockResolvedValueOnce(webhookPreference())
      .mockResolvedValueOnce(
        webhookPreference({ notifyLatency: true, latencyMs: 10_000 }),
      );
    const root = render(createElement(WebhookOwnerEmailPreferenceCard));
    try {
      await flush();
      act(() => input("webhook-auto-pause-owner-email").click());
      act(() => button("Save owner email preference").click());
      await flush(8);

      expect(mocks.updateWebhook).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "changed after you opened this form",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(UnsavedChangesProvider, null, ui),
      ),
    );
  });
  return root;
}

async function flush(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return element;
}

function change(element: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.includes(text) === true,
  );
  if (!element) throw new Error(`Button not found: ${text}`);
  return element;
}
