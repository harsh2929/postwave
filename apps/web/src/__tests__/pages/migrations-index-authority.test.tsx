// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  listJobs: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/migration-api", () => ({
  listCapabilities: mocks.listCapabilities,
  listJobs: mocks.listJobs,
}));

import MigrationsPage from "@/app/(dashboard)/app/migrations/page";
import { qk } from "@/lib/query-keys";
import { mockCapabilities } from "@/lib/migration-mocks";
import type { MeResponse } from "@/lib/auth-api";

const ADMIN: MeResponse = {
  user_id: "admin-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function renderPage() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MigrationsPage />
      </QueryClientProvider>,
    );
  });
}

async function waitForText(text: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (container?.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${text}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.listCapabilities.mockResolvedValue(mockCapabilities());
  mocks.listJobs.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  queryClient.clear();
  root = null;
  container = null;
});

describe("migration index authority", () => {
  it("does not request protected migration data for viewer mode", async () => {
    mocks.whoami.mockResolvedValue({ ...ADMIN, viewer_mode: true });
    await renderPage();
    await waitForText("Administrator access required");
    expect(mocks.listCapabilities).not.toHaveBeenCalled();
    expect(mocks.listJobs).not.toHaveBeenCalled();
  });

  it("does not request protected data after an identity error", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity unavailable"));
    await renderPage();
    await waitForText("Migration access could not be verified");
    expect(container?.textContent).toContain("No migration data was requested");
    expect(mocks.listCapabilities).not.toHaveBeenCalled();
    expect(mocks.listJobs).not.toHaveBeenCalled();
  });

  it("removes admin data and its principal cache when viewer mode starts", async () => {
    mocks.whoami.mockResolvedValue(ADMIN);
    await renderPage();
    await waitForText("Mailchimp");
    expect(mocks.listCapabilities).toHaveBeenCalledTimes(1);
    expect(mocks.listJobs).toHaveBeenCalledTimes(1);

    const adminPrincipal = "tenant-1:admin-1:admin:member";
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .some((query) => query.queryKey.includes(adminPrincipal)),
    ).toBe(true);

    await act(async () => {
      queryClient.setQueryData(qk.authMe(), { ...ADMIN, viewer_mode: true });
      await Promise.resolve();
    });
    await waitForText("Viewer mode never loads migration data");
    expect(container?.textContent).not.toContain("Mailchimp");
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .some((query) => query.queryKey.includes(adminPrincipal)),
    ).toBe(false);
  });

  it("suppresses retained admin data when a background identity refresh fails", async () => {
    mocks.whoami.mockResolvedValueOnce(ADMIN);
    await renderPage();
    await waitForText("Mailchimp");
    const adminPrincipal = "tenant-1:admin-1:admin:member";

    mocks.whoami.mockRejectedValueOnce(new Error("session check failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.authMe(), exact: true });
    });
    await waitForText("Migration access could not be verified");

    expect(container?.textContent).not.toContain("Mailchimp");
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .some((query) => query.queryKey.includes(adminPrincipal)),
    ).toBe(false);
  });
});
