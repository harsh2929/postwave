// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CompatibilityPage from "@/app/(dashboard)/app/compatibility/page";

import { waitFor } from "./_wait";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/app/(dashboard)/app/compatibility/compatibility-page-data", () => ({
  loadCompatibilityPageData: mocks.load,
}));

const ADMIN = {
  user_id: "admin-user",
  tenant_id: "tenant-a",
  email: "admin@example.test",
  role: "admin" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

const SUMMARY = {
  contacts: {
    total: 0,
    by_mailchimp_status: {},
    groups: 0,
    activity_events: 0,
  },
  campaigns: { total: 0, by_type: {}, assets: 0, reusable_sections: 0 },
  reports: { events: 0, reportable_campaigns: 0 },
  automations: { total: 0, by_status: {} },
  growth: { landing_pages: 0, popups: 0, views: 0, conversions: 0 },
  ecommerce: {
    integrations: 0,
    customers: 0,
    products: 0,
    orders: 0,
    revenue_cents: 0,
    attributed_revenue_cents: 0,
  },
};

function pageData(overrides: Record<string, unknown> = {}) {
  return {
    partialErrors: [],
    adminOnlyUnavailable: [],
    summary: SUMMARY,
    groups: [],
    templates: [],
    forms: [],
    assets: [],
    sections: [],
    journeys: [],
    landingPages: [],
    popups: [],
    integrations: [],
    reportHistory: [],
    campaigns: [],
    report: null,
    planner: null,
    multivariate: null,
    sendTime: null,
    sendDay: null,
    clickMap: null,
    customReport: null,
    deliveryInsights: null,
    inbox: null,
    multiChannel: null,
    surveys: null,
    landingParity: null,
    websiteStatus: null,
    audienceInsights: null,
    segmentSchema: null,
    contentStudio: null,
    blockCatalog: null,
    batches: null,
    accountExports: null,
    connectedSites: null,
    verifiedDomains: null,
    marketplace: null,
    agencyEcosystem: null,
    parityWorkbench: null,
    ...overrides,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CompatibilityPage),
      ),
    );
  });
  return { client, container, root };
}

let mounted: Root | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(pageData());
});
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

describe("compatibility authority and cache containment", () => {
  it("does not issue any compatibility request when identity verification fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity offline"));
    const view = mount();
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Couldn’t verify compatibility access",
      ),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain(
      "No compatibility request was made",
    );
  });

  it("requests only the viewer-safe subset for editor and viewer-mode identities", async () => {
    mocks.whoami.mockResolvedValue({
      ...ADMIN,
      effective_role: "editor",
      role: "editor",
    });
    mocks.load.mockResolvedValue(
      pageData({
        adminOnlyUnavailable: [
          "Automations",
          "Landing pages",
          "Popups",
          "Ecommerce integrations",
        ],
      }),
    );
    const view = mount();
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Some compatibility detail is admin-only",
      ),
    );
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load.mock.calls[0]?.[0]).toMatchObject({
      includeAdmin: false,
    });
    expect(mocks.load.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps demo writes hidden in viewer mode even if the durable effective role is admin", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS", "1");
    mocks.whoami.mockResolvedValue({
      ...ADMIN,
      viewer_mode: true,
    });
    mocks.load.mockResolvedValue(
      pageData({
        adminOnlyUnavailable: [
          "Automations",
          "Landing pages",
          "Popups",
          "Ecommerce integrations",
        ],
      }),
    );
    const view = mount();
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain("Read-only"),
    );
    expect(mocks.load.mock.calls[0]?.[0]).toMatchObject({
      includeAdmin: false,
    });
    expect(view.container.textContent).not.toContain("Create group");
    expect(view.container.textContent).not.toContain("Seed builder");
  });

  it("aborts, purges, and never paints a late admin response after switching to viewer mode", async () => {
    let resolveAdmin!: (value: ReturnType<typeof pageData>) => void;
    const pendingAdmin = new Promise<ReturnType<typeof pageData>>((resolve) => {
      resolveAdmin = resolve;
    });
    mocks.whoami.mockResolvedValue(ADMIN);
    mocks.load.mockImplementation(
      ({ includeAdmin }: { includeAdmin: boolean }) =>
        includeAdmin
          ? pendingAdmin
          : Promise.resolve(
              pageData({
                adminOnlyUnavailable: [
                  "Automations",
                  "Landing pages",
                  "Popups",
                  "Ecommerce integrations",
                ],
              }),
            ),
    );
    const view = mount();
    mounted = view.root;
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.load.mock.calls[0]?.[0]?.signal as AbortSignal;

    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        effective_role: "viewer",
        viewer_mode: true,
      });
    });
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    resolveAdmin(
      pageData({
        journeys: [{ id: "secret", name: "Prior admin secret journey" }],
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(view.container.textContent).not.toContain(
      "Prior admin secret journey",
    );
    expect(
      view.client.getQueryData([
        "compatibility",
        "tenant-a",
        "admin",
        "admin-user",
        "durable-mode",
        "overview",
      ]),
    ).toBeUndefined();
    expect(mocks.load.mock.calls[1]?.[0]).toMatchObject({
      includeAdmin: false,
    });
  });
});
