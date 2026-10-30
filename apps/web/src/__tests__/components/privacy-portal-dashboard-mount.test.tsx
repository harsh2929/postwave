// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// governance-108 reachability: the privacy-portal admin workspace mounts
// PortalDashboard (via next/dynamic) in place of the legacy metrics grid and
// DSAR table. Assertions are consequences of the mount — the KPI values and
// hints computed from the verified GET /api/v1/privacy/portal snapshot, the
// DSAR-by-type chart rows, and the CSV export reaching the download helper.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  getPortal: vi.fn(),
  getPending: vi.fn(),
  getBranding: vi.fn(),
  downloadTextFile: vi.fn(
    (_name: string, _content: string, _mime?: string) => undefined,
  ),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/privacy-portal-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy-portal-api")>()),
  getPrivacyPortal: mocks.getPortal,
  getDoubleOptInPending: mocks.getPending,
  getPreferenceCentreBranding: mocks.getBranding,
}));

vi.mock("@/lib/download", () => ({
  downloadTextFile: mocks.downloadTextFile,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PrivacyPortalAdmin } from "@/app/(dashboard)/app/privacy-portal/privacy-portal-admin";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const ME: MeResponse = {
  user_id: "99999999-9999-4999-8999-999999999999",
  tenant_id: TENANT,
  email: "admin@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};
const PORTAL = {
  tenantId: TENANT,
  regions: [],
  dsar_requests: [
    { request_type: "erasure", open: 3, overdue: 1, closed: 9 },
    { request_type: "access", open: 2, overdue: 0, closed: 4 },
  ],
  suppression_breakdown: [{ reason: "hard_bounce", count: 4 }],
  consent_proof_summary: [{ source: "hosted_form", count: 12 }],
  gpc_signaled_count: 7,
  do_not_sell_count: 5,
  double_optin_pending: 1,
  generated_at: "2026-08-29T10:00:00Z",
};

let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(ME);
  mocks.getPortal.mockResolvedValue(PORTAL);
  mocks.getPending.mockResolvedValue({ tenantId: TENANT, count: 0, pending: [] });
  mocks.getBranding.mockResolvedValue({
    tenantId: TENANT,
    logo_url: "",
    primary_color: "#123ABC",
    footer_text: "Subscriber controls",
    show_postwave_badge: true,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function settle(turns = 1): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function renderAdmin(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PrivacyPortalAdmin, { me: ME, role: "admin" }),
      ),
    );
  });
  // The dashboard is a next/dynamic chunk; wait for it rather than for a
  // fixed number of event-loop turns.
  const deadline = Date.now() + 10_000;
  while (
    !container.textContent?.includes("DSAR by request type") &&
    Date.now() < deadline
  ) {
    await settle();
  }
  return container;
}

describe("privacy portal admin mounts PortalDashboard (governance-108)", () => {
  it("renders the KPI strip with hints and the DSAR chart from the verified snapshot", async () => {
    const container = await renderAdmin();
    expect(mocks.getPortal).toHaveBeenCalledTimes(1);

    const kpis = [...container.querySelectorAll("dl > div")]
      .map((cell) => ({
        label: cell.querySelector("dt")?.textContent,
        value: cell.querySelector("dd")?.textContent,
      }))
      .filter((cell) => cell.label?.startsWith("DSAR") || cell.label === "GPC signaled");
    expect(kpis).toEqual([
      { label: "DSAR · open", value: "5" },
      { label: "DSAR · overdue", value: "1" },
      { label: "GPC signaled", value: "7" },
    ]);
    expect(container.textContent).toContain(
      "Open requests past their statutory due date (GDPR Art.12: 30d; CCPA: 45d).",
    );

    const chartRows = [
      ...container.querySelectorAll('ul[aria-label="DSAR requests by type"] li'),
    ].map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    expect(chartRows).toEqual([
      "erasure3 open · 1 overdue · 9 closed",
      "access2 open · 0 overdue · 4 closed",
    ]);
    expect(container.textContent).toContain("Suppressions · top reasons");

    // The legacy metrics grid and its DSAR summary table are gone.
    expect(
      container.querySelector('[aria-label="Privacy request summary table"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Completed requests in the aggregate");
    // The snapshot timestamp line beneath the dashboard stays.
    expect(container.textContent).toContain("Snapshot ");
  });

  it("exports the DSAR chart data as CSV through the download helper", async () => {
    const container = await renderAdmin();
    const exportButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Export DSAR requests by request type and status data as CSV"]',
    );
    expect(exportButton).toBeTruthy();
    expect(exportButton!.disabled).toBe(false);
    await act(async () => exportButton!.click());

    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1);
    const [name, csv, mime] = mocks.downloadTextFile.mock.calls[0]!;
    expect(name).toBe("privacy-dsar-requests-by-type.csv");
    expect(mime).toBe("text/csv;charset=utf-8");
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("Source,GET /api/v1/privacy/portal");
    expect(lines.slice(6)).toEqual([
      "Request type,Open requests,Overdue requests,Closed requests",
      "erasure,3,1,9",
      "access,2,0,4",
    ]);
    expect(container.textContent).toContain("Chart data export started.");
  });
});
