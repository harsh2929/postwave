// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  createBatch: vi.fn(),
  createExport: vi.fn(),
  confirmWrite: vi.fn(),
  identity: undefined as MeResponse | undefined,
  invalidate: vi.fn(),
  queryKeys: [] as (readonly unknown[])[],
  refetch: vi.fn(),
  setQueryData: vi.fn(),
}));

vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignWriteAuthority: mocks.confirmWrite,
}));

vi.mock("@/lib/mailchimp-compat-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mailchimp-compat-api")>()),
  createAccountExport: mocks.createExport,
  createBatch: mocks.createBatch,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidate,
    setQueryData: mocks.setQueryData,
  }),
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    mocks.queryKeys.push(options.queryKey);
    const common = {
      error: null,
      isError: false,
      isFetched: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
      refetch: mocks.refetch,
    };
    if (options.queryKey[0] === "auth-me") {
      return { ...common, data: mocks.identity };
    }
    return {
      ...common,
      data: {
        agency: null,
        batches: null,
        domains: null,
        exportsState: null,
        marketplace: null,
        sites: null,
      },
    };
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PlatformOpsPanel } from "@/components/mailchimp-parity/platform-ops-panel";

const EDITOR: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

let root: Root | null = null;

beforeEach(() => {
  mocks.identity = EDITOR;
  mocks.queryKeys.length = 0;
  for (const mock of [
    mocks.createBatch,
    mocks.createExport,
    mocks.confirmWrite,
    mocks.invalidate,
    mocks.refetch,
    mocks.setQueryData,
  ]) {
    mock.mockReset();
  }
  mocks.confirmWrite.mockResolvedValue(undefined);
  mocks.createBatch.mockResolvedValue({
    completed_at: null,
    errored_operations: 0,
    finished_operations: 0,
    id: "batch-1",
    started_at: "2026-09-04T00:00:00Z",
    status: "started",
    submitted_at: "2026-09-04T00:00:00Z",
    total_operations: 1,
  });
  mocks.createExport.mockResolvedValue({
    created_at: "2026-09-04T00:00:00Z",
    id: "export-1",
    status: "pending",
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("platform operations write authority", () => {
  it("deduplicates clicks and confirms fresh authority before batch transport", async () => {
    render();
    const action = button("Validate batch request");
    await act(async () => {
      action.click();
      action.click();
      await Promise.resolve();
    });

    expect(mocks.confirmWrite).toHaveBeenCalledTimes(1);
    expect(mocks.createBatch).toHaveBeenCalledTimes(1);
    expect(mocks.confirmWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createBatch.mock.invocationCallOrder[0]!,
    );
  });

  it("uses an effective viewer cache and disables both writes in viewer mode", () => {
    mocks.identity = {
      ...EDITOR,
      role: "admin",
      effective_role: "viewer",
      viewer_mode: true,
    };
    render();

    expect(button("Validate batch request").disabled).toBe(true);
    expect(button("Start account export").disabled).toBe(true);
    const key = mocks.queryKeys.find((item) =>
      item.includes("mailchimp-platform-ops"),
    );
    expect(key).toContain("viewer");
    expect(key).not.toContain("admin");
    expect(document.body.textContent).toContain(
      "Campaign changes are read-only",
    );
  });
});

function render(): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(PlatformOpsPanel)));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}
