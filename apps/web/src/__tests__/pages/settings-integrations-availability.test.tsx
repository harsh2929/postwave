// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IntegrationsSettingsPage from "@/app/(dashboard)/app/settings/integrations/page";

const api = vi.hoisted(() => ({
  availability: vi.fn(),
  disconnect: vi.fn(),
  status: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

const ADMIN = {
  user_id: "user-1",
  email: "owner@example.com",
  tenant_id: "tenant-1",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: auth.whoami,
  whoamiFresh: auth.whoamiFresh,
}));

vi.mock("@/lib/integrations-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/integrations-api")>();
  return {
    ...actual,
    slackWorkspaceApi: {
      ...actual.slackWorkspaceApi,
      availability: api.availability,
      disconnect: api.disconnect,
      status: api.status,
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(auth)]) {
    mock.mockReset();
  }
  auth.whoami.mockResolvedValue(ADMIN);
  auth.whoamiFresh.mockResolvedValue(ADMIN);
  api.availability
    .mockRejectedValueOnce(new Error("availability unavailable"))
    .mockResolvedValue({ configured: true });
  api.status.mockResolvedValue({ connected: false });
  api.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Slack settings availability", () => {
  it("surfaces an access-check failure without probing Slack", async () => {
    auth.whoami.mockRejectedValue(new Error("identity unavailable"));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IntegrationsSettingsPage),
        ),
      );
    });

    try {
      await waitFor(
        () =>
          document.body.textContent?.includes("identity unavailable") === true,
      );
      expect(api.availability).not.toHaveBeenCalled();
      expect(api.status).not.toHaveBeenCalled();
      const alert = document.querySelector(
        '[data-testid="slack-section"] [role="alert"]',
      );
      expect(alert?.textContent).toContain("Retry access check");
      expect(alert?.textContent).not.toContain("Connect");
      expect(alert?.textContent).not.toContain("Disconnect");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("shows an unknown/error state and retries instead of assuming configured", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IntegrationsSettingsPage),
        ),
      );
    });

    try {
      await waitFor(
        () =>
          document.querySelector(
            '[data-testid="slack-section"] [role="alert"]',
          ) !== null,
      );
      const section = document.querySelector(
        '[data-testid="slack-section"]',
      ) as HTMLElement;
      expect(section.querySelector('[role="alert"]')?.textContent).toContain(
        "availability unavailable",
      );
      expect(section.textContent).not.toContain("Connect");

      const retry = Array.from(section.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      await waitFor(() => section.textContent?.includes("Connect") === true);

      expect(section.querySelector('[role="alert"]')).toBeNull();
      expect(api.availability).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });

  it("does not fetch or expose admin Slack controls in viewer mode", async () => {
    auth.whoami.mockResolvedValue({
      ...ADMIN,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IntegrationsSettingsPage),
        ),
      );
    });

    try {
      await waitFor(
        () =>
          document.body.textContent?.includes("read-only for this session") ===
          true,
      );
      expect(api.availability).not.toHaveBeenCalled();
      expect(api.status).not.toHaveBeenCalled();
      const section = document.querySelector(
        '[data-testid="slack-section"]',
      ) as HTMLElement;
      expect(section.textContent).not.toContain("Connect");
      expect(section.textContent).not.toContain("Disconnect");
      const slackKeys = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey)
        .filter((key) => key.includes("slack-workspace"));
      expect(slackKeys.some((key) => key.includes("viewer"))).toBe(true);
      expect(slackKeys.some((key) => key.includes("owner"))).toBe(false);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
