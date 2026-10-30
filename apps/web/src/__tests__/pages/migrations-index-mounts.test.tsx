// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// analytics-106: the /migrations index renders MigrationHistory (search,
// status filter, page size, pager, Refresh) in place of RecentMigrations.
// Rendered through the real page so the history is reachable for an admin,
// fed by the page's own jobs query, and its Refresh re-runs BOTH of the
// page's reads — GET /api/v1/migrations (history) and
// GET /api/v1/migrations/sources (capabilities).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { mockCapabilities } from "@/lib/migration-mocks";
import type { MeResponse } from "@/lib/auth-api";
import type { MigrationJob, MigrationStatus, SourcePlatform } from "@/lib/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function job(
  id: string,
  source: SourcePlatform,
  status: MigrationStatus,
  minute: number,
): MigrationJob {
  return {
    id,
    tenant_id: "tenant-1",
    source,
    status,
    progress: {
      subscribers_total: 10,
      subscribers_done: 10,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    },
    cursor: {},
    started_at: new Date(Date.UTC(2026, 8, 1, 0, minute, 0)).toISOString(),
    completed_at: null,
    rollback_until: null,
    verification_report: null,
    error: null,
    label: null,
  };
}

const JOBS = [
  job("job-01-mailchimp", "mailchimp", "completed", 1),
  job("job-02-klaviyo", "klaviyo", "failed", 2),
  job("job-03-brevo", "brevo", "rolled_back", 3),
];

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

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function rows(): Element[] {
  return [
    ...(container?.querySelectorAll('[data-testid="migration-history-row"]') ??
      []),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.whoami.mockResolvedValue(ADMIN);
  mocks.listCapabilities.mockResolvedValue(mockCapabilities());
  mocks.listJobs.mockResolvedValue(JOBS);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  queryClient.clear();
  root = null;
  container = null;
});

describe("migrations index mounts MigrationHistory (analytics-106)", () => {
  it("renders the searchable history of the page's jobs", async () => {
    await renderPage();
    await eventually(() => expect(rows()).toHaveLength(3));
    expect(mocks.listJobs).toHaveBeenCalledTimes(1);

    const labels = [...container!.querySelectorAll("label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(
      expect.arrayContaining(["Search migrations", "Status", "Per page"]),
    );
    expect(container!.textContent).toContain(
      "3 matching migrations · page 1 of 1",
    );
  });

  it("Refresh re-runs both the history and the sources reads", async () => {
    await renderPage();
    await eventually(() => expect(rows()).toHaveLength(3));
    expect(mocks.listJobs).toHaveBeenCalledTimes(1);
    expect(mocks.listCapabilities).toHaveBeenCalledTimes(1);

    mocks.listJobs.mockResolvedValue([
      ...JOBS,
      job("job-04-mailchimp", "mailchimp", "completed", 4),
    ]);
    const refresh = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh?.click();
    });

    await eventually(() => expect(rows()).toHaveLength(4));
    expect(mocks.listJobs).toHaveBeenCalledTimes(2);
    expect(mocks.listCapabilities).toHaveBeenCalledTimes(2);
  });
});
