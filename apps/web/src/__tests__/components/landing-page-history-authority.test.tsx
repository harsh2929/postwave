// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryTab } from "@/app/(dashboard)/app/landing-pages/[id]/history-tab";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listAuditLog: vi.fn(),
  listVersions: vi.fn(),
  restoreVersion: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/audit-api", () => ({
  listAuditLog: mocks.listAuditLog,
}));

vi.mock("@/lib/landing-pages-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/landing-pages-api")>();
  return {
    ...actual,
    landingPagesApi: {
      ...actual.landingPagesApi,
      listVersions: mocks.listVersions,
      restoreVersion: mocks.restoreVersion,
    },
  };
});

function identity(role: "admin" | "editor") {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "user@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  };
}

const version = {
  version_no: 2,
  name: "Welcome v2",
  status: "draft" as const,
  slug: "welcome",
  created_at: "2026-08-01T00:00:00Z",
};

let root: Root | null = null;
let client: QueryClient | null = null;

async function renderHistory(role: "admin" | "editor") {
  const host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client = queryClient;
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HistoryTab, {
          pageId: "page-1",
          baseKey: ["landing-pages", "tenant-1", role, "user-1", false],
          identity: identity(role),
          canAdmin: role === "admin",
          onRestored: vi.fn(),
        }),
      ),
    );
  });
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return host;
}

function findButton(text: string, within: ParentNode = document) {
  return Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

beforeEach(() => {
  mocks.listVersions.mockResolvedValue([version]);
  mocks.listAuditLog.mockResolvedValue({ rows: [], nextCursor: null });
  mocks.restoreVersion.mockResolvedValue({ id: "page-1" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  client?.clear();
  root = null;
  client = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("landing-page history authority", () => {
  it("preserves readable versions but suppresses protected audit evidence for editors", async () => {
    const host = await renderHistory("editor");
    expect(host.textContent).toContain("Version 2");
    expect(host.textContent).toContain("raw audit evidence");
    expect(findButton("Restore", host)?.disabled).toBe(true);
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
    expect(mocks.listAuditLog).not.toHaveBeenCalled();
  });

  it("fresh-checks a delayed restore and blocks stale admin transport", async () => {
    mocks.whoamiFresh.mockResolvedValue(identity("editor"));
    const host = await renderHistory("admin");
    const trigger = findButton("Restore", host);
    expect(trigger?.disabled).toBe(false);
    await act(async () => trigger?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const confirm = findButton("Restore", dialog ?? document);
    await act(async () => confirm?.click());
    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.restoreVersion).not.toHaveBeenCalled();
  });
});
