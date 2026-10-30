// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import IntegrationDetailPage from "@/app/(dashboard)/app/integrations/catalog/[slug]/page";
import {
  isConnectableCategory,
  surfaceForCatalogItem,
} from "@/lib/catalog-connect-map";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "zendesk" }),
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/integrations/catalog/zendesk",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
      post: mocks.apiPost,
      delete: mocks.apiDelete,
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SUPPORT_ITEM = {
  slug: "zendesk",
  name: "Zendesk",
  category: "customer_service",
  badge: "native" as const,
  runtime_status: "partial" as const,
  summary: "Support provider",
  capabilities: ["support"],
  native: true,
  sources: ["commerce"],
};

function render(ui: ReactNode): { root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("support catalog release hold", () => {
  it("renders catalog-only truth and makes zero support runtime requests", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
      effective_role: "admin",
      workspace_name: "Acme",
      workspace_slug: "acme",
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path !== "/api/v1/integrations/catalog") {
        throw new Error("unexpected GET " + path);
      }
      return Promise.resolve({
        schema_version: "1",
        target_public_entries: 1,
        target_native_managed: 1,
        honest_badges: [],
        categories: [],
        capabilities: [],
        items: [SUPPORT_ITEM],
        counts: { partial: 1 },
      });
    });

    expect(surfaceForCatalogItem(SUPPORT_ITEM)).toBeNull();
    expect(isConnectableCategory("customer_service")).toBe(false);

    const { root } = render(createElement(IntegrationDetailPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Support integration runtime held",
        );
        expect(document.body.textContent).toContain(
          "support_integration_runtime_held",
        );
      });

      expect(mocks.apiGet).toHaveBeenCalledTimes(1);
      expect(mocks.apiPost).not.toHaveBeenCalled();
      expect(mocks.apiDelete).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Provision ingest");
      expect(document.body.textContent).not.toContain("Sync now");
      expect(document.body.textContent).not.toContain("Disconnect");
    } finally {
      act(() => root.unmount());
    }
  });
});
