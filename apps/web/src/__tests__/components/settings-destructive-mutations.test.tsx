// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeveloperSettingsPage from "@/app/(dashboard)/app/settings/developer/page";
import DomainSettingsPage from "@/app/(dashboard)/app/settings/domain/page";
import IntegrationsSettingsPage from "@/app/(dashboard)/app/settings/integrations/page";

const mocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  deleteCustomDomain: vi.fn(),
  getCustomDomainEvidence: vi.fn(),
  listAuditLog: vi.fn(),
  listCustomDomains: vi.fn(),
  slackAvailability: vi.fn(),
  slackDisconnect: vi.fn(),
  slackStatus: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});

vi.mock("@/lib/custom-domains-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/custom-domains-api")
  >("@/lib/custom-domains-api");
  return {
    ...actual,
    deleteCustomDomain: mocks.deleteCustomDomain,
    getCustomDomainEvidence: mocks.getCustomDomainEvidence,
    listCustomDomains: mocks.listCustomDomains,
    verifyCustomDomain: vi.fn(),
  };
});

vi.mock("@/lib/integrations-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations-api")>(
    "@/lib/integrations-api",
  );
  return {
    ...actual,
    slackWorkspaceApi: {
      availability: mocks.slackAvailability,
      disconnect: mocks.slackDisconnect,
      status: mocks.slackStatus,
    },
  };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      delete: mocks.apiDelete,
      get: mocks.apiGet,
      post: mocks.apiPost,
    },
  };
});

vi.mock("@/lib/audit-api", () => ({ listAuditLog: mocks.listAuditLog }));
vi.mock("@/components/mailchimp-parity/platform-ops-panel", () => ({
  PlatformOpsPanel: () => null,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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

function render(Page: ComponentType): Root {
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
      createElement(QueryClientProvider, { client }, createElement(Page)),
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

async function expectFailedThenRetry({
  call,
  confirmLabel,
  pending,
  triggerLabel,
}: {
  call: ReturnType<typeof vi.fn>;
  confirmLabel: string;
  pending: ReturnType<typeof deferred<unknown>>;
  triggerLabel: string;
}) {
  act(() => button(triggerLabel).click());
  expect(dialog()).toBeTruthy();
  act(() => {
    const confirm = button(confirmLabel, dialog());
    confirm.click();
    confirm.click();
  });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(dialog().getAttribute("aria-busy")).toBe("true");
  expect(button("Cancel", dialog()).disabled).toBe(true);
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
  });
  expect(dialog()).toBeTruthy();

  await act(async () => pending.reject(new Error(`${triggerLabel} failed.`)));
  const alert = dialog().querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(`${triggerLabel} failed.`);
  expect(document.activeElement).toBe(alert);
  await act(async () => button(confirmLabel, dialog()).click());
  expect(call).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(document.querySelector('[role="dialog"]')).toBeNull(),
  );
}

beforeEach(() => {
  const identity = {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Settings closure",
    workspace_slug: "demo",
  } as const;
  mocks.whoami.mockResolvedValue(identity);
  mocks.whoamiFresh.mockResolvedValue(identity);
  mocks.listCustomDomains.mockResolvedValue([
    {
      id: "domain-1",
      tenantId: "tenant-1",
      domain: "news.example.test",
      purpose: "forms",
      verified: true,
      dns_records: [],
      createdAt: "2026-08-20T09:00:00Z",
    },
  ]);
  mocks.getCustomDomainEvidence.mockResolvedValue({
    id: "domain-1",
    tenantId: "tenant-1",
    domain: "news.example.test",
    purpose: "forms",
    verified: true,
    dns_records: [],
    createdAt: "2026-08-20T09:00:00Z",
  });
  mocks.slackAvailability.mockResolvedValue({ configured: true });
  mocks.slackStatus.mockResolvedValue({
    connected: true,
    slack_team_name: "Moosewave Test",
    default_channel_name: "launches",
  });
  mocks.listAuditLog.mockResolvedValue({ rows: [], total: 0 });
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === "/api/v1/onboarding/sample-data") {
      return Promise.resolve({ seeded: true });
    }
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
  mocks.apiPost.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("settings destructive mutations", () => {
  it("renders a review-gated read-only custom-domain registry", async () => {
    const root = render(DomainSettingsPage);
    try {
      await waitFor(() =>
        expect(button("Review ownership evidence")).toBeTruthy(),
      );
      expect(document.body.textContent).toContain(
        "Custom-domain operations are release-held",
      );
      expect(document.body.textContent).toContain("Legacy ownership registry");
      expect(document.body.textContent).not.toContain("Add domain");
      expect(document.body.textContent).not.toContain("Verify DNS");
      expect(document.body.textContent).not.toContain("Remove domain");
      expect(mocks.getCustomDomainEvidence).not.toHaveBeenCalled();

      act(() => button("Review ownership evidence").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Stored ownership evidence for news.example.test",
        ),
      );
      expect(mocks.getCustomDomainEvidence).toHaveBeenCalledTimes(1);
      expect(mocks.deleteCustomDomain).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not request domain evidence until identity succeeds and supports retry", async () => {
    mocks.whoami.mockRejectedValueOnce(new Error("identity unavailable"));
    const root = render(DomainSettingsPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Workspace access could not be verified",
        ),
      );
      expect(mocks.listCustomDomains).not.toHaveBeenCalled();

      act(() => button("Retry").click());
      await waitFor(() =>
        expect(button("Review ownership evidence")).toBeTruthy(),
      );
      expect(mocks.listCustomDomains).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps ownership evidence hidden while identity is loading", async () => {
    const identity = deferred<Awaited<ReturnType<typeof mocks.whoami>>>();
    mocks.whoami.mockReturnValueOnce(identity.promise);
    const root = render(DomainSettingsPage);
    try {
      expect(
        document.querySelector('[aria-label="Checking workspace access"]'),
      ).not.toBeNull();
      expect(mocks.listCustomDomains).not.toHaveBeenCalled();
      await act(async () =>
        identity.resolve({
          user_id: "user-1",
          tenant_id: "tenant-1",
          email: "owner@example.test",
          role: "owner",
          effective_role: "owner",
          auth_provider: "password",
          email_verified: true,
          workspace_name: "Settings closure",
          workspace_slug: "demo",
        }),
      );
      await waitFor(() =>
        expect(button("Review ownership evidence")).toBeTruthy(),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes a failed registry read from a verified empty retry", async () => {
    mocks.listCustomDomains
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce([]);
    const root = render(DomainSettingsPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Ownership registry could not be loaded",
        ),
      );
      expect(document.body.textContent).not.toContain(
        "No legacy ownership records",
      );

      act(() => button("Retry").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "No legacy ownership records",
        ),
      );
      expect(mocks.listCustomDomains).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("retries a failed review-gated evidence read without mounting a mutation", async () => {
    mocks.getCustomDomainEvidence
      .mockRejectedValueOnce(new Error("evidence unavailable"))
      .mockResolvedValueOnce({
        id: "domain-1",
        tenantId: "tenant-1",
        domain: "news.example.test",
        purpose: "forms",
        verified: true,
        dns_records: [],
        createdAt: "2026-08-20T09:00:00Z",
      });
    const root = render(DomainSettingsPage);
    try {
      await waitFor(() =>
        expect(button("Review ownership evidence")).toBeTruthy(),
      );
      act(() => button("Review ownership evidence").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Ownership evidence could not be loaded",
        ),
      );
      expect(document.body.textContent).not.toContain("Verify DNS");

      act(() => button("Retry").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Stored ownership evidence for news.example.test",
        ),
      );
      expect(mocks.getCustomDomainEvidence).toHaveBeenCalledTimes(2);
      expect(mocks.deleteCustomDomain).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("retains Slack disconnect through a transport failure and retry", async () => {
    const pending = deferred<unknown>();
    mocks.slackDisconnect
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, deleted: true });
    const root = render(IntegrationsSettingsPage);
    try {
      await waitFor(() => expect(button("Disconnect")).toBeTruthy());
      await expectFailedThenRetry({
        call: mocks.slackDisconnect,
        confirmLabel: "Disconnect",
        pending,
        triggerLabel: "Disconnect",
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("retains sample-data removal through a transport failure and retry", async () => {
    const pending = deferred<unknown>();
    mocks.apiDelete
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true });
    const root = render(DeveloperSettingsPage);
    try {
      await waitFor(() => expect(button("Remove sample data")).toBeTruthy());
      await expectFailedThenRetry({
        call: mocks.apiDelete,
        confirmLabel: "Remove",
        pending,
        triggerLabel: "Remove sample data",
      });
      expect(mocks.apiDelete).toHaveBeenCalledWith(
        "/api/v1/onboarding/sample-data",
      );
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.apiDelete.mock.invocationCallOrder[0]!,
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.apiDelete.mock.invocationCallOrder[1]!,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps sample-data status readable but removes writes for an editor", async () => {
    mocks.whoami.mockResolvedValueOnce({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "editor@example.test",
      role: "editor",
      effective_role: "editor",
      viewer_mode: false,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Settings closure",
      workspace_slug: "demo",
    });
    const root = render(DeveloperSettingsPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Current state: loaded"),
      );
      expect(document.body.textContent).toContain(
        "Only workspace owners and administrators can load or remove sample data",
      );
      expect(
        Array.from(document.querySelectorAll("button")).some((candidate) =>
          candidate.textContent?.includes("Remove sample data"),
        ),
      ).toBe(false);
      expect(mocks.apiDelete).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks sample-data removal when fresh admin authority was downgraded", async () => {
    mocks.whoamiFresh.mockResolvedValueOnce({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "editor@example.test",
      role: "editor",
      effective_role: "editor",
      viewer_mode: false,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Settings closure",
      workspace_slug: "demo",
    });
    const root = render(DeveloperSettingsPage);
    try {
      await waitFor(() => expect(button("Remove sample data")).toBeTruthy());
      act(() => button("Remove sample data").click());
      await act(async () => button("Remove", dialog()).click());
      await waitFor(() =>
        expect(dialog().textContent).toContain("authority changed"),
      );
      expect(mocks.apiDelete).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
