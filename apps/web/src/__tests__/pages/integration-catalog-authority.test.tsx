// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IntegrationCatalogPage from "@/app/(dashboard)/app/integrations/catalog/page";
import { ApiError } from "@/lib/api";

import { waitFor } from "./_wait";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/integrations/catalog",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

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

const CATALOG = {
  schema_version: "1",
  target_public_entries: 1,
  target_native_managed: 1,
  honest_badges: ["native"],
  categories: [{ key: "crm", label: "CRM" }],
  capabilities: ["contacts"],
  counts: { available: 1, native: 1 },
  items: [
    {
      slug: "secret-crm",
      name: "Prior tenant secret CRM",
      category: "crm",
      badge: "native",
      runtime_status: "available",
      summary: "Only the original admin may see this.",
      capabilities: ["contacts"],
      native: true,
    },
  ],
};

function installTransport(
  catalog: Promise<unknown> = Promise.resolve(CATALOG),
) {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === "/api/v1/integrations/catalog") return catalog;
    if (path.startsWith("/api/v1/integrations/")) return Promise.resolve([]);
    if (path === "/api/v1/commerce/integrations") return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
}

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { client, container, root };
}

let mounted: Root | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  installTransport();
});
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

describe("integration catalog admin-read containment", () => {
  for (const identity of [
    { ...ADMIN, role: "editor" as const, effective_role: "editor" as const },
    { ...ADMIN, viewer_mode: true, effective_role: "viewer" as const },
  ]) {
    it(`makes zero protected calls for ${identity.viewer_mode ? "viewer mode" : "an editor"}`, async () => {
      mocks.whoami.mockResolvedValue(identity);
      const view = mount(createElement(IntegrationCatalogPage));
      mounted = view.root;

      await waitFor(() =>
        expect(view.container.textContent).toContain(
          "Owner or admin access required",
        ),
      );
      expect(mocks.apiGet).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain(
        "No integration catalog or connection request was made",
      );
    });
  }

  it("makes zero protected calls when identity resolution fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity offline"));
    const view = mount(createElement(IntegrationCatalogPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Couldn’t verify catalog access",
      ),
    );
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain(
      "No integration catalog request was made",
    );
  });

  it("keys admin data by tenant, user, effective role, and viewer state", async () => {
    mocks.whoami.mockResolvedValue(ADMIN);
    const view = mount(createElement(IntegrationCatalogPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain("Prior tenant secret CRM"),
    );
    expect(
      view.client.getQueryData([
        "integrations",
        "tenant-a",
        "admin",
        "admin-user",
        "durable-mode",
        "catalog",
      ]),
    ).toBeTruthy();
  });

  it("renders a catalog 403 as unavailable without retrying or showing an empty catalog", async () => {
    mocks.whoami.mockResolvedValue(ADMIN);
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/api/v1/integrations/catalog") {
        return Promise.reject(new ApiError("forbidden", 403));
      }
      if (path.startsWith("/api/v1/integrations/")) {
        return Promise.resolve([]);
      }
      if (path === "/api/v1/commerce/integrations") {
        return Promise.resolve([]);
      }
      return Promise.resolve({ items: [] });
    });
    const view = mount(createElement(IntegrationCatalogPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "server did not accept owner/admin authority",
      ),
    );
    expect(view.container.textContent).not.toContain(
      "No integrations match your filters",
    );
    expect(
      mocks.apiGet.mock.calls.filter(
        ([path]) => path === "/api/v1/integrations/catalog",
      ),
    ).toHaveLength(1);
  });

  it("aborts and purges an old admin cache, ignoring its late response after a viewer switch", async () => {
    let resolveCatalog!: (value: typeof CATALOG) => void;
    const pendingCatalog = new Promise<typeof CATALOG>((resolve) => {
      resolveCatalog = resolve;
    });
    installTransport(pendingCatalog);
    mocks.whoami.mockResolvedValue(ADMIN);
    const view = mount(createElement(IntegrationCatalogPage));
    mounted = view.root;

    await waitFor(() =>
      expect(
        mocks.apiGet.mock.calls.some(
          ([path]) => path === "/api/v1/integrations/catalog",
        ),
      ).toBe(true),
    );
    const catalogCall = mocks.apiGet.mock.calls.find(
      ([path]) => path === "/api/v1/integrations/catalog",
    );
    const signal = catalogCall?.[1]?.signal as AbortSignal;

    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() => expect(signal.aborted).toBe(true));
    resolveCatalog(CATALOG);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(view.container.textContent).toContain(
      "Owner or admin access required",
    );
    expect(view.container.textContent).not.toContain("Prior tenant secret CRM");
    expect(
      view.client.getQueryData([
        "integrations",
        "tenant-a",
        "admin",
        "admin-user",
        "durable-mode",
        "catalog",
      ]),
    ).toBeUndefined();
    expect(
      view.client.getQueriesData({
        queryKey: [
          "integrations",
          "tenant-a",
          "admin",
          "admin-user",
          "durable-mode",
        ],
      }),
    ).toEqual([]);
  });
});
