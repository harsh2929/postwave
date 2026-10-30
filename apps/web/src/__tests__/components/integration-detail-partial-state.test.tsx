// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import IntegrationDetailPage from "@/app/(dashboard)/app/integrations/catalog/[slug]/page";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "salesforce" }),
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/integrations/catalog/salesforce",
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
    api: { ...actual.api, get: mocks.apiGet },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
      slug: "salesforce",
      name: "Salesforce",
      category: "crm",
      badge: "native",
      runtime_status: "available",
      summary: "CRM account and lifecycle data.",
      capabilities: ["contacts"],
      native: true,
    },
  ],
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
      await act(async () => flush());
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("integration detail partial provider data", () => {
  it("keeps identity visible but pauses setup when provider requirements fail", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "admin",
      effective_role: "admin",
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/api/v1/integrations/catalog") {
        return Promise.resolve(CATALOG);
      }
      if (path === "/api/v1/crm/providers") {
        return Promise.reject(new Error("provider registry unavailable"));
      }
      if (path === "/api/v1/crm/integrations") {
        return Promise.resolve({ items: [] });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const { root } = render(createElement(IntegrationDetailPage));
    try {
      await waitFor(() => {
        expect(document.querySelector("h1")?.textContent).toBe("Salesforce");
        expect(document.body.textContent).toContain(
          "Integration setup data is incomplete",
        );
      });

      expect(document.body.textContent).toContain(
        "Provider requirements could not be loaded",
      );
      expect(document.body.textContent).toContain("Setup controls are paused");
      expect(document.body.textContent).not.toContain("Add another connection");
      expect(
        [...document.querySelectorAll("button")].some(
          (candidate) => candidate.textContent === "Connect",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
