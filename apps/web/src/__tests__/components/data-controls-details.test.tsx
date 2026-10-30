// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPii: vi.fn(),
  listHooks: vi.fn(),
  listRules: vi.fn(),
  listTemplates: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/data-controls-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data-controls-api")>()),
  getPiiScanConfig: mocks.getPii,
  listImportTemplates: mocks.listTemplates,
  listInboundWebhooks: mocks.listHooks,
  listProfileTransformRules: mocks.listRules,
}));

import DataControlsPage from "@/app/(dashboard)/app/data-controls/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue({
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Parity",
    workspace_slug: "parity",
  });
  mocks.getPii.mockResolvedValue({
    available: true,
    scan_enabled: true,
    scheduled_scans_available: false,
    status: "ready",
    detector_name: "structured-detector",
  });
  mocks.listRules.mockResolvedValue([
    {
      id: "rule-1",
      name: "Canonical campaign source",
      source_path: "metadata.utm_source",
      target_key: "campaign_source",
      transform: "lowercase",
      status: "active",
    },
  ]);
  mocks.listTemplates.mockResolvedValue([
    {
      id: "template-1",
      name: "Conference import",
      source_hint: "Conference CSV",
      mapping: { columns: [{ source: "Email", target: "email" }] },
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    },
  ]);
  mocks.listHooks.mockResolvedValue([
    {
      id: "hook-1",
      name: "Signup relay",
      slug: "signup-relay",
      enabled: true,
      created_at: "2026-08-03T00:00:00Z",
    },
  ]);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("data-controls row visibility", () => {
  it("shows rule, template, and webhook evidence and delegates webhook CRUD", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <DataControlsPage />
        </QueryClientProvider>,
      );
    });

    await waitFor(() =>
      expect(container.textContent).toContain("Canonical campaign source"),
    );
    expect(container.textContent).toContain("metadata.utm_source");
    expect(container.textContent).toContain("custom_fields.campaign_source");
    expect(container.textContent).toContain("Conference CSV · 1 mapped column");
    expect(container.textContent).toContain("/api/public/inbound/signup-relay");
    expect(container.textContent).toContain("Enabled");

    const manage = container.querySelector<HTMLAnchorElement>(
      'a[href="/app/inbound-webhooks"]',
    );
    const detail = container.querySelector<HTMLAnchorElement>(
      'a[href="/app/inbound-webhooks/hook-1"]',
    );
    expect(manage?.textContent).toContain("Manage endpoints");
    expect(detail?.textContent).toContain("View");
    expect(container.textContent).not.toMatch(
      /create transform|delete template/i,
    );
  });
});
