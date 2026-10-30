// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AccountDeletionApi from "@/lib/account-deletion-api";
import type * as ApiModule from "@/lib/api";
import type * as AuthApi from "@/lib/auth-api";
import type * as PrivacyApi from "@/lib/privacy-api";
import type * as RetentionApi from "@/lib/retention-policy-api";
import type * as WorkspaceExportsApi from "@/lib/workspace-exports-api";
import type * as WorkspaceSettingsApi from "@/lib/workspace-settings-controls-api";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  deleteOwnAccount: vi.fn(),
  listPrivacyRequests: vi.fn(),
  logout: vi.fn(),
  retentionGet: vi.fn(),
  retentionPatch: vi.fn(),
  getExportRetentionPolicy: vi.fn(),
  listWorkspaceExports: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  whoami: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("@/lib/workspace-settings-controls-api", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceSettingsApi>();
  return {
    ...actual,
    getExportRetentionPolicy: mocks.getExportRetentionPolicy,
  };
});

vi.mock("@/lib/workspace-exports-api", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceExportsApi>();
  return {
    ...actual,
    listWorkspaceExports: mocks.listWorkspaceExports,
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, post: mocks.apiPost } };
});

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthApi>();
  return {
    ...actual,
    logout: mocks.logout,
    whoami: mocks.whoami,
  };
});

vi.mock("@/lib/account-deletion-api", async (importOriginal) => {
  const actual = await importOriginal<typeof AccountDeletionApi>();
  return { ...actual, deleteOwnAccount: mocks.deleteOwnAccount };
});

vi.mock("@/lib/privacy-api", async (importOriginal) => {
  const actual = await importOriginal<typeof PrivacyApi>();
  return { ...actual, listPrivacyRequests: mocks.listPrivacyRequests };
});

vi.mock("@/lib/retention-policy-api", async (importOriginal) => {
  const actual = await importOriginal<typeof RetentionApi>();
  return {
    ...actual,
    retentionPolicyApi: {
      ...actual.retentionPolicyApi,
      get: mocks.retentionGet,
      patch: mocks.retentionPatch,
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "user_owner",
  tenant_id: "tenant_privacy",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Privacy workspace",
  workspace_slug: "privacy-workspace",
  totp_enabled: true,
};

const RETENTION_POLICY = {
  audit_log_retention_days: 90,
  email_event_retention_days: 365,
  unsubscribed_subscriber_retention_days: 730,
  updated_at: "2026-08-20T10:00:00.000Z",
  updated_by_user_id: "user_owner",
};

const ACK = {
  request_id: "prv_request_1",
  status: "queued",
  requested_at: "2026-08-26T10:00:00.000Z",
  estimated_ready_at: "2026-09-25T10:00:00.000Z",
};

let client: QueryClient | null = null;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(me: Record<string, unknown> = OWNER): Promise<void> {
  mocks.whoami.mockResolvedValue(me);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  client = queryClient;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const Page = (await import("@/app/(dashboard)/app/settings/privacy/page"))
    .default;
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Page),
      ),
    );
  });
  await waitFor(() => expect(button("Delete my account").disabled).toBe(false));
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

function control<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
>(label: string): T {
  const labelNode = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const match = labelNode?.htmlFor
    ? document.getElementById(labelNode.htmlFor)
    : null;
  if (
    !(match instanceof HTMLInputElement) &&
    !(match instanceof HTMLTextAreaElement) &&
    !(match instanceof HTMLSelectElement)
  ) {
    throw new Error(`Control not found: ${label}`);
  }
  return match as T;
}

function change(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLInputElement
      ? window.HTMLInputElement.prototype
      : target instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function requestOptions(call: number): Record<string, unknown> {
  return mocks.apiPost.mock.calls[call]?.[2] as Record<string, unknown>;
}

function idempotencyKey(call: number): string {
  const options = requestOptions(call);
  return (options.headers as Record<string, string>)["Idempotency-Key"];
}

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(() => import("@/app/(dashboard)/app/settings/privacy/page"));

beforeEach(() => {
  mocks.getExportRetentionPolicy.mockResolvedValue({
    retentionDays: 30,
    maxPerTenant: 25,
    currentStorageBytes: 0,
    updatedAt: "2026-08-20T10:00:00.000Z",
  });
  mocks.listWorkspaceExports.mockResolvedValue([]);
  mocks.listPrivacyRequests.mockResolvedValue({ requests: [] });
  mocks.logout.mockResolvedValue(undefined);
  mocks.retentionGet.mockResolvedValue(RETENTION_POLICY);
  mocks.retentionPatch.mockResolvedValue(RETENTION_POLICY);
});

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  host?.remove();
  document.body.innerHTML = "";
  client = null;
  host = null;
  root = null;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("settings privacy dialogs", () => {
  it.each([undefined, "0001-01-01T00:00:00Z", "invalid-date"])(
    "does not invent a retention-change age for an unrecorded timestamp: %s",
    async (updated_at) => {
      mocks.retentionGet.mockResolvedValue({ ...RETENTION_POLICY, updated_at });
      await mount();
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "No retention policy change has been recorded.",
        ),
      );
      expect(document.body.textContent).not.toContain("Last changed ");
    },
  );

  it("queues an export once, locks pending dismissal, retries inline with one identity, and renders the real download", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.apiPost
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({ ...ACK, request_id: "prv_data-export_a/b" });
    await mount();

    const trigger = button("Export all data");
    await act(async () => trigger.click());
    await act(async () => change(control("Legal region"), "CCPA"));
    const submit = button("Start export");
    await act(async () => {
      submit.click();
      submit.click();
    });

    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/api/v1/privacy/export-requests",
      { region: "CCPA" },
      expect.objectContaining({ requireOnline: true }),
    );
    expect(idempotencyKey(0)).toBeTruthy();
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(button("Cancel").disabled).toBe(true);
    expect(control("Legal region").disabled).toBe(true);
    await pressEscape();
    await act(async () => button("Close").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () =>
      rejectFirst?.(new Error("Export service unavailable")),
    );
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Export service unavailable",
      ),
    );
    await act(async () => button("Try again").click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );

    expect(mocks.apiPost).toHaveBeenCalledTimes(2);
    expect(idempotencyKey(1)).toBe(idempotencyKey(0));
    expect(document.body.textContent).toContain(
      "Latest export request recorded",
    );
    expect(document.body.textContent).toContain("prv_data-export_a/b");
    expect(
      document
        .querySelector<HTMLAnchorElement>('a[href*="download"]')
        ?.getAttribute("href"),
    ).toBe("/api/v1/privacy/export-requests/prv_data-export_a%2Fb/download");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("files only mounted subscriber request types with validation, immutable pending fields, and same-key retry", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.apiPost
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        ...ACK,
        request_id: "prv_correction_1",
        request_type: "correction",
      });
    await mount();

    const trigger = button("New subscriber request");
    await act(async () => trigger.click());
    const type = control<HTMLSelectElement>("Request type");
    const optionText = Array.from(type.options).map(
      (option) => option.textContent,
    );
    expect(optionText.join(" ")).not.toContain("Erasure");
    expect(optionText.join(" ")).not.toContain("Appeal");

    await act(async () => button("File request").click());
    const email = control<HTMLInputElement>("Subject email");
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(email);

    await act(async () => {
      change(email, "  subscriber@example.test  ");
      change(control("Notes (optional)"), "  Correct the surname  ");
    });
    const submit = button("File request");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/api/v1/privacy/requests",
      {
        request_type: "correction",
        subject_email: "subscriber@example.test",
        region: "GDPR",
        notes: "Correct the surname",
      },
      expect.objectContaining({ requireOnline: true }),
    );
    expect(email.disabled).toBe(true);
    expect(type.disabled).toBe(true);
    await pressEscape();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () =>
      rejectFirst?.(new Error("Reviewer queue unavailable")),
    );
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Reviewer queue unavailable",
      ),
    );
    await act(async () => button("Try filing again").click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(idempotencyKey(1)).toBe(idempotencyKey(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("sends the exact personal deletion token and reauthentication once, then safely retries", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.deleteOwnAccount
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        request: { request_id: "acct_delete_1", status: "queued" },
      });
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    await mount();

    const trigger = button("Delete my account");
    await act(async () => trigger.click());
    const confirmation = control<HTMLInputElement>("Confirmation phrase");
    const password = control<HTMLInputElement>("Current password");
    const mfa = control<HTMLInputElement>("Authenticator code");
    await act(async () => change(confirmation, "delete my account"));
    expect(confirmation.getAttribute("aria-invalid")).toBe("true");
    expect(button("Permanently delete my account").disabled).toBe(true);

    await act(async () => {
      change(confirmation, "DELETE MY ACCOUNT");
      change(password, "correct horse battery staple");
      change(mfa, "12a34");
    });
    expect(mfa.value).toBe("1234");
    expect(mfa.getAttribute("aria-invalid")).toBe("true");
    await act(async () => change(mfa, "123456"));

    const submit = button("Permanently delete my account");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(mocks.deleteOwnAccount).toHaveBeenCalledTimes(1);
    const [input, firstKey] = mocks.deleteOwnAccount.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(input).toEqual({
      confirmation: "DELETE MY ACCOUNT",
      password: "correct horse battery staple",
      mfa_code: "123456",
      region: "OTHER",
    });
    expect(firstKey).toBeTruthy();
    expect(confirmation.disabled).toBe(true);
    expect(password.disabled).toBe(true);
    expect(mfa.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await pressEscape();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () =>
      rejectFirst?.(new Error("Deletion service temporarily unavailable")),
    );
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Deletion service temporarily unavailable",
      ),
    );
    await act(async () => button("Try deletion again").click());
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    expect(mocks.deleteOwnAccount).toHaveBeenCalledTimes(2);
    expect(mocks.deleteOwnAccount.mock.calls[1]?.[1]).toBe(firstKey);
    expect(assign).toHaveBeenCalledWith("/login?account-deletion=requested");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Personal account deletion request accepted (acct_delete_1). Current status: queued.",
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("gates the workspace review with truthful client confirmation and retries the mounted route inline", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.apiPost
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({ ...ACK, request_id: "prv_workspace_delete_1" });
    await mount();

    const trigger = button("Request workspace deletion");
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "browser-side confirmation is not a second authentication factor",
    );
    const confirmation = control<HTMLInputElement>("Confirmation phrase");
    await act(async () => change(confirmation, "DELETE workspace"));
    expect(confirmation.getAttribute("aria-invalid")).toBe("true");
    expect(button("Queue deletion review").disabled).toBe(true);
    expect(mocks.apiPost).not.toHaveBeenCalled();

    await act(async () => change(confirmation, "DELETE WORKSPACE"));
    const submit = button("Queue deletion review");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(confirmation.disabled).toBe(true);
    expect(control("Legal region").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await pressEscape();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      rejectFirst?.(new Error("Deletion review unavailable")),
    );
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Deletion review unavailable",
      ),
    );
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/api/v1/privacy/deletion-requests",
      { region: "OTHER" },
      expect.objectContaining({ requireOnline: true }),
    );
    const firstKey = idempotencyKey(0);
    await act(async () => button("Try queueing again").click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(idempotencyKey(1)).toBe(firstKey);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("never presents a malformed 2xx acknowledgement as an export success", async () => {
    mocks.apiPost.mockResolvedValue({ status: "queued" });
    await mount();
    await act(async () => button("Export all data").click());
    await act(async () => button("Start export").click());
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "invalid acknowledgement",
      ),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      "Latest export request recorded",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("does not expose admin-only workspace writes to a viewer", async () => {
    await mount({ ...OWNER, role: "viewer", totp_enabled: false });
    expect(document.body.textContent).toContain(
      "only workspace admins can request a workspace export",
    );
    expect(document.body.textContent).not.toContain("New subscriber request");
    expect(document.body.textContent).not.toContain(
      "Request workspace deletion",
    );
    expect(button("Delete my account")).not.toBeNull();
  });
});
