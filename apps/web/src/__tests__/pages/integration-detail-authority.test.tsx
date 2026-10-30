// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IntegrationDetailPage from "@/app/(dashboard)/app/integrations/catalog/[slug]/page";
import { ApiError } from "@/lib/api";
import { stubFixtureTransport } from "./_harness";
import { waitFor } from "./_wait";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  catalog: vi.fn(),
  providers: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  sync: vi.fn(),
  pause: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "salesforce" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/integrations/catalog/salesforce",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/integrations-catalog-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations-catalog-api")>()),
  integrationsCatalogApi: { get: mocks.catalog },
}));

vi.mock("@/lib/catalog-connect-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog-connect-map")>()),
  surfaceForCatalogItem: () => ({
    key: "crm",
    label: "CRM",
    client: {
      providers: mocks.providers,
      list: mocks.list,
      create: mocks.create,
      sync: mocks.sync,
      pause: mocks.pause,
      disconnect: mocks.disconnect,
    },
  }),
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

const ITEM = {
  slug: "salesforce",
  name: "Salesforce",
  category: "crm",
  badge: "native" as const,
  runtime_status: "available" as const,
  summary: "CRM account data",
  capabilities: ["contacts"],
  native: true,
};

const SPEC = {
  provider: "salesforce",
  name: "Salesforce",
  category: "crm",
  auth_mode: "api_key_ref",
  managed: false,
  runtime_status: "available",
  capabilities: ["contacts"],
  required_settings: [],
  scopes: [],
  sync_objects: ["contact"],
  docs_url: "",
};

const CONNECTION = {
  id: "connection-1",
  provider: "salesforce",
  name: "Sensitive production CRM",
  status: "active",
  scopes: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

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

function button(label: string) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

let mounted: Root | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  // The connector detail panels and lead-capture form read through the shared
  // transport; unrecorded paths answer 404 instead of reaching the network.
  stubFixtureTransport();
  mocks.whoami.mockResolvedValue(ADMIN);
  mocks.whoamiFresh.mockResolvedValue(ADMIN);
  mocks.catalog.mockResolvedValue({
    schema_version: "1",
    target_public_entries: 1,
    target_native_managed: 1,
    honest_badges: ["native"],
    categories: [{ key: "crm", label: "CRM" }],
    capabilities: ["contacts"],
    counts: { available: 1 },
    items: [ITEM],
  });
  mocks.providers.mockResolvedValue([SPEC]);
  mocks.list.mockResolvedValue([CONNECTION]);
  mocks.create.mockResolvedValue(CONNECTION);
  mocks.sync.mockResolvedValue({ ok: true });
  mocks.pause.mockResolvedValue({ ok: true });
  mocks.disconnect.mockResolvedValue({ ok: true });
});
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("integration detail authority", () => {
  it("does not request catalog or surface data when identity verification fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity unavailable"));
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Couldn’t verify integration access",
      ),
    );
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not request catalog or surface data for a viewer", async () => {
    mocks.whoami.mockResolvedValue({
      ...ADMIN,
      role: "viewer",
      effective_role: "viewer",
    });
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("reports a protected provider 403 as unavailable and pauses setup", async () => {
    mocks.providers.mockRejectedValue(new ApiError("forbidden", 403));
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Admin authorization was rejected",
      ),
    );
    expect(view.container.textContent).toContain(
      "The denied request is unavailable, not an empty provider or workspace",
    );
    expect(view.container.textContent).not.toContain("Add another connection");
    expect(view.container.textContent).not.toContain(
      "Sensitive production CRM",
    );
    expect(button("Sync now")).toBeUndefined();
  });

  it("closes a privileged disconnect dialog when a refreshed surface read rejects authority", async () => {
    mocks.providers
      .mockResolvedValueOnce([SPEC])
      .mockRejectedValueOnce(new ApiError("forbidden", 403));
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;
    await waitFor(() => expect(button("Disconnect")).toBeDefined());

    act(() => button("Disconnect")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Disconnect integration?"),
    );
    await act(async () => {
      await view.client.invalidateQueries({
        queryKey: [
          "integrations",
          "tenant-a",
          "admin",
          "admin-user",
          "durable-mode",
          "catalog-detail",
          "salesforce",
        ],
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Admin authorization was rejected",
      ),
    );

    expect(document.body.textContent).not.toContain("Disconnect integration?");
    expect(document.body.textContent).not.toContain("Sensitive production CRM");
  });

  it("renders a catalog 403 as unavailable rather than as a missing integration", async () => {
    mocks.catalog.mockRejectedValue(new ApiError("forbidden", 403));
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "server did not accept owner/admin authority",
      ),
    );
    expect(view.container.textContent).not.toContain("Integration not found");
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("locks a double-click and performs fresh authority verification before sync", async () => {
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;
    await waitFor(() => expect(button("Sync now")).toBeDefined());

    act(() => {
      button("Sync now")?.click();
      button("Sync now")?.click();
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.sync).not.toHaveBeenCalled();

    await act(async () => resolveFresh(ADMIN));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0],
    );
    expect(mocks.sync.mock.calls[0]?.[0]).toBe("connection-1");
    expect(mocks.sync.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a frozen lifecycle intent when authority changes before the fresh check returns", async () => {
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;
    await waitFor(() => expect(button("Sync now")).toBeDefined());

    act(() => button("Sync now")?.click());
    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    await act(async () => resolveFresh(ADMIN));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(mocks.sync).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain(
      "Sensitive production CRM",
    );
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

  it("closes and purges a disconnect confirmation when the principal changes", async () => {
    const view = mount(createElement(IntegrationDetailPage));
    mounted = view.root;
    await waitFor(() => expect(button("Disconnect")).toBeDefined());

    act(() => button("Disconnect")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Disconnect integration?"),
    );
    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );

    expect(document.body.textContent).not.toContain("Disconnect integration?");
    expect(document.body.textContent).not.toContain("Sensitive production CRM");
  });
});
