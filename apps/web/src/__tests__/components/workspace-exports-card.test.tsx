// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  verifyAdmin: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  authorize: vi.fn(),
  successToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, error: vi.fn() },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/workspace-exports-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-exports-api")>()),
  listWorkspaceExports: mocks.list,
  createWorkspaceExport: mocks.create,
  getWorkspaceExport: mocks.get,
  authorizeWorkspaceExportDownload: mocks.authorize,
}));

import { WorkspaceExportsCard } from "@/components/settings/workspace-exports-card";
import type { MeResponse } from "@/lib/auth-api";
import type { WorkspaceExport } from "@/lib/workspace-exports-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};
const EXPORT_ID = "33333333-3333-4333-8333-333333333333";
const READY: WorkspaceExport = {
  id: EXPORT_ID,
  status: "ready",
  include: ["consent"],
  requestedByEmail: OWNER.email,
  bytesTotal: 1_024,
  rowsTotal: 42,
  downloadPath: `/api/v1/exports/${EXPORT_ID}/download`,
  expiresAt: "2030-08-30T10:00:00Z",
  error: "",
  createdAt: "2026-08-30T10:00:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.verifyAdmin.mockResolvedValue(OWNER);
  mocks.list.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkspaceExportsCard", () => {
  it("queues the exact selected dataset and reads the job back before success", async () => {
    mocks.create.mockResolvedValue({
      id: EXPORT_ID,
      status: "queued",
      include: ["consent"],
    });
    mocks.get.mockResolvedValue({ ...READY, status: "queued", downloadPath: "" });
    const root = render();
    try {
      await flush();
      await click(button("Clear"));
      const consent = document.querySelector<HTMLInputElement>(
        "#workspace-export-resource-consent",
      );
      await clickInput(consent as HTMLInputElement);
      await click(button("Queue selective export"));
      await flush(8);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(OWNER, expect.any(AbortSignal));
      expect(mocks.create).toHaveBeenCalledWith(["consent"], {
        signal: expect.any(AbortSignal),
      });
      expect(mocks.get).toHaveBeenCalledWith(EXPORT_ID, {
        signal: expect.any(AbortSignal),
        fresh: true,
      });
      expect(document.body.textContent).toContain(
        "queued and read back from the server",
      );
      expect(document.body.textContent).toContain("33333333");
    } finally {
      act(() => root.unmount());
    }
  });

  it("freshly verifies a ready row and completes step-up preflight before browser download", async () => {
    mocks.list.mockResolvedValue([READY]);
    mocks.get.mockResolvedValue(READY);
    mocks.authorize.mockResolvedValue(READY.downloadPath);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const root = render();
    try {
      await flush();
      await click(button("Download ZIP"));
      await flush(8);
      expect(mocks.verifyAdmin).toHaveBeenCalledWith(OWNER, expect.any(AbortSignal));
      expect(mocks.get).toHaveBeenCalledWith(EXPORT_ID, {
        signal: expect.any(AbortSignal),
        fresh: true,
      });
      expect(mocks.authorize).toHaveBeenCalledWith(READY, {
        signal: expect.any(AbortSignal),
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Download authorized");
    } finally {
      clickSpy.mockRestore();
      act(() => root.unmount());
    }
  });

  it("does not fetch sensitive export history for a viewer", async () => {
    mocks.whoami.mockResolvedValue({ ...OWNER, role: "viewer" });
    const root = render();
    try {
      await flush();
      expect(document.body.textContent).toContain("Owner or admin access required");
      expect(mocks.list).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Queue selective export");
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WorkspaceExportsCard),
      ),
    );
  });
  return root;
}

async function flush(turns = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickInput(target: HTMLInputElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
