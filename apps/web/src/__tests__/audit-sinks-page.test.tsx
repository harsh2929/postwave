// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETA-056: the Audit streaming page renders the sinks + schedules tables with
// health badges, and gates every mutation control on the write role.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import AuditSinksPage from "@/app/(dashboard)/app/settings/audit-sinks/page";

// Under a full-suite load the edit dialog can take more than 40 frames to
// mount, and the assertion is about whether it mounts, not how many turns that
// takes, so waits are on wall-clock time.
import { waitFor } from "./pages/_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  authority: vi.fn(),
  listAuditSinks: vi.fn(),
  listExportSchedules: vi.fn(),
  patchAuditSink: vi.fn(),
  deleteAuditSink: vi.fn(),
  createExportSchedule: vi.fn(),
  deleteExportSchedule: vi.fn(),
  testAuditSinkPreflight: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});

vi.mock("@/lib/audit-operations-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/audit-operations-api")>();
  return { ...actual, getAuditAuthority: mocks.authority };
});

vi.mock("@/lib/audit-sinks-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-sinks-api")>();
  return {
    ...actual, // keep SINK_FIELD_SPECS + types for the form
    listAuditSinks: mocks.listAuditSinks,
    listExportSchedules: mocks.listExportSchedules,
    patchAuditSink: mocks.patchAuditSink,
    deleteAuditSink: mocks.deleteAuditSink,
    createExportSchedule: mocks.createExportSchedule,
    deleteExportSchedule: mocks.deleteExportSchedule,
    testAuditSinkPreflight: mocks.testAuditSinkPreflight,
  };
});

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function primeAuth(role: string) {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
  mocks.authority.mockResolvedValue({
    scopes:
      role === "viewer"
        ? ["audit:read", "audit:read_pii"]
        : [
            "audit:read",
            "audit:read_pii",
            "audit:configure_sinks",
            "audit:execute_actions",
          ],
    auditScopes:
      role === "viewer"
        ? ["audit:read", "audit:read_pii"]
        : [
            "audit:read",
            "audit:read_pii",
            "audit:configure_sinks",
            "audit:execute_actions",
          ],
    isAdmin: role !== "viewer",
  });
}

function primeData() {
  mocks.listAuditSinks.mockResolvedValue({
    sinks: [
      {
        id: "sk_healthy",
        kind: "s3",
        name: "Cold storage",
        enabled: true,
        config: { bucket: "b", region: "us-east-1" },
        output_format: "postwave_native",
        webhook_format: "postwave_v1",
        consecutive_failures: 0,
        auto_disable_after: 100,
        circuit_state: "closed",
      },
      {
        id: "sk_failing",
        kind: "datadog",
        name: "SIEM feed",
        enabled: true,
        config: {},
        output_format: "ocsf_1_8",
        webhook_format: "postwave_v1",
        consecutive_failures: 12,
        auto_disable_after: 100,
        circuit_state: "open",
      },
    ],
  });
  mocks.listExportSchedules.mockResolvedValue({
    schedules: [
      {
        id: "sc_1",
        cadence: "weekly",
        recipients: ["compliance@acme.com"],
        enabled: true,
        created_at: "2026-07-01T00:00:00.000Z",
        last_enqueued_at: null,
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
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.includes(text) === true,
  );
}

function exactButton(
  text: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function openDialog(): HTMLElement {
  const match = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!match) throw new Error("Dialog not found");
  return match;
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(control: HTMLElement): Promise<void> {
  await act(async () => {
    control.click();
    await flush();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("AuditSinksPage (SETA-056)", () => {
  it("renders both tables with health badges and write controls for an owner", async () => {
    primeAuth("owner");
    primeData();
    const root = render(createElement(AuditSinksPage));
    try {
      await waitFor(() => {
        // Sinks table rows
        expect(document.body.textContent).toContain("Cold storage");
        expect(document.body.textContent).toContain("SIEM feed");
        // Health badges: closed→Healthy, open→Failing
        expect(document.body.textContent).toContain("Healthy");
        expect(document.body.textContent).toContain("Failing");
        // Schedules table row
        expect(document.body.textContent).toContain("compliance@acme.com");
      });
      // Owner can mutate.
      expect(buttonByText("Add sink")).toBeDefined();
      expect(buttonByText("Add schedule")).toBeDefined();
      expect(buttonByText("Edit")).toBeDefined();
      expect(buttonByText("Delete")).toBeDefined();
    } finally {
      act(() => root.unmount());
    }
  });

  it("fails sink topology closed for a read-only viewer while showing authorized schedules", async () => {
    primeAuth("viewer");
    primeData();
    const root = render(createElement(AuditSinksPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Audit sink access required",
        );
        expect(document.body.textContent).toContain("compliance@acme.com");
      });
      expect(buttonByText("Add sink")).toBeUndefined();
      expect(buttonByText("Add schedule")).toBeUndefined();
      expect(buttonByText("Edit")).toBeUndefined();
      expect(buttonByText("Delete")).toBeUndefined();
    } finally {
      act(() => root.unmount());
    }
  });

  it("detects an edit no-op, freezes one save, and keeps a failed edit retryable", async () => {
    primeAuth("owner");
    primeData();
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.patchAuditSink
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const root = render(createElement(AuditSinksPage));
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Cold storage"),
      );
      await click(exactButton("Edit"));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      const name = openDialog().querySelector<HTMLInputElement>("#sink-name");
      if (!name) throw new Error("Sink name input missing");
      expect(exactButton("Save changes", openDialog()).disabled).toBe(true);
      expect(openDialog().textContent).toContain("Change a field");

      await change(name, "Cold storage primary");
      const save = exactButton("Save changes", openDialog());
      await act(async () => {
        save.click();
        save.click();
        await Promise.resolve();
      });
      expect(mocks.patchAuditSink).toHaveBeenCalledTimes(1);
      expect(openDialog().getAttribute("aria-busy")).toBe("true");
      expect(name.disabled).toBe(true);
      expect(exactButton("Close", openDialog()).disabled).toBe(true);
      act(() => exactButton("Close", openDialog()).click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        rejectFirst?.(new Error("Credential envelope changed remotely."));
        await flush();
      });
      const alert = openDialog().querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain("changed remotely");
      expect(alert?.className).toContain("text-destructive-emphasis");
      expect(document.activeElement).toBe(alert);
      expect(name.value).toBe("Cold storage primary");

      await act(async () => {
        exactButton("Save changes", openDialog()).click();
        await flush();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.patchAuditSink).toHaveBeenCalledTimes(2);
      expect(mocks.patchAuditSink).toHaveBeenLastCalledWith(
        "sk_healthy",
        expect.objectContaining({ name: "Cold storage primary" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("validates, dedupes, and retries schedule creation without losing recipients", async () => {
    primeAuth("owner");
    primeData();
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.createExportSchedule
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        id: "sc_2",
        cadence: "weekly",
        recipients: ["security@example.test"],
        enabled: true,
        created_at: "2026-08-26T00:00:00.000Z",
        last_enqueued_at: null,
      });
    const root = render(createElement(AuditSinksPage));
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Cold storage"),
      );
      await click(exactButton("Add schedule"));
      await click(exactButton("Create schedule", openDialog()));
      let alert = openDialog().querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain("at least one recipient");
      expect(document.activeElement).toBe(alert);

      const recipients =
        openDialog().querySelector<HTMLInputElement>("#sched-recipients");
      if (!recipients) throw new Error("Recipients input missing");
      await change(recipients, "Security@Example.test, security@example.test");
      const create = exactButton("Create schedule", openDialog());
      await act(async () => {
        create.click();
        create.click();
        await Promise.resolve();
      });
      expect(mocks.createExportSchedule).toHaveBeenCalledTimes(1);
      expect(mocks.createExportSchedule).toHaveBeenCalledWith(
        {
          cadence: "weekly",
          recipients: ["security@example.test"],
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(recipients.disabled).toBe(true);

      await act(async () => {
        rejectFirst?.(new Error("Mail policy rejected this recipient."));
        await flush();
      });
      alert = openDialog().querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain("Mail policy rejected");
      expect(document.activeElement).toBe(alert);
      expect(recipients.value).toContain("Security@Example.test");

      await act(async () => {
        exactButton("Create schedule", openDialog()).click();
        await flush();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.createExportSchedule).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("cancels destructive writes and recovers sink deletion before deleting a schedule", async () => {
    primeAuth("owner");
    primeData();
    mocks.deleteAuditSink
      .mockRejectedValueOnce(new Error("Sink cursor is currently locked."))
      .mockResolvedValueOnce(undefined);
    mocks.deleteExportSchedule.mockResolvedValue(undefined);
    const root = render(createElement(AuditSinksPage));
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Cold storage"),
      );
      const sinkRow = Array.from(document.querySelectorAll("tr")).find((row) =>
        row.textContent?.includes("Cold storage"),
      );
      if (!sinkRow) throw new Error("Sink row missing");
      const sinkDeleteTrigger = exactButton("Delete", sinkRow);
      await click(sinkDeleteTrigger);
      expect(openDialog().textContent).toContain("cursor + dead-letter queue");
      await click(exactButton("Cancel", openDialog()));
      expect(mocks.deleteAuditSink).not.toHaveBeenCalled();

      await click(sinkDeleteTrigger);
      const sinkToken = openDialog().querySelector<HTMLInputElement>(
        'input[placeholder="DELETE"]',
      );
      if (!sinkToken) throw new Error("Sink delete token input missing");
      await change(sinkToken, "DELETE");
      await act(async () => {
        exactButton("Delete", openDialog()).click();
        await flush();
      });
      const alert = openDialog().querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain("currently locked");
      expect(document.activeElement).toBe(alert);
      await act(async () => {
        exactButton("Delete", openDialog()).click();
        await flush();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.deleteAuditSink).toHaveBeenCalledTimes(2);
      expect(document.activeElement?.textContent?.trim()).toBe("Delete");

      const scheduleRow = Array.from(document.querySelectorAll("tr")).find(
        (row) => row.textContent?.includes("compliance@acme.com"),
      );
      if (!scheduleRow) throw new Error("Schedule row missing");
      await click(exactButton("Delete", scheduleRow));
      expect(openDialog().textContent).toContain("Past exports are unaffected");
      const scheduleToken = openDialog().querySelector<HTMLInputElement>(
        'input[placeholder="DELETE"]',
      );
      if (!scheduleToken)
        throw new Error("Schedule delete token input missing");
      await change(scheduleToken, "DELETE");
      await act(async () => {
        exactButton("Delete", openDialog()).click();
        await flush();
      });
      expect(mocks.deleteExportSchedule).toHaveBeenCalledWith(
        "sc_1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
