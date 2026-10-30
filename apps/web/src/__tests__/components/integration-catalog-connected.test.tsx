// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// INTG-029: renders the real IntegrationCatalogPage and asserts the connected
// view — the "Your integrations" section, a green "Connected" badge on a
// provider with a live connection, none on an unconnected one, and explicit
// fail-closed handling when one protected fan-out surface rejects authority.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import IntegrationCatalogPage from "@/app/(dashboard)/app/integrations/catalog/page";
import { ApiError } from "@/lib/api";

import { importBeforeTests, waitFor } from "../pages/_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
  searchParams: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/integrations/catalog",
  useSearchParams: () => new URLSearchParams(mocks.searchParams),
  useParams: () => ({}),
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

const NOW = "2026-07-01T00:00:00.000Z";

function catalogItem(slug: string, name: string, category: string) {
  return {
    slug,
    name,
    category,
    badge: "native",
    runtime_status: "available",
    summary: `${name} summary`,
    capabilities: [],
    native: true,
  };
}

const CATALOG = {
  schema_version: "1",
  target_public_entries: 5,
  target_native_managed: 5,
  honest_badges: [],
  categories: [],
  capabilities: [],
  items: [
    catalogItem("salesforce", "Salesforce", "crm"),
    catalogItem("slack", "Slack", "customer_service"),
    catalogItem("zendesk", "Zendesk", "customer_service"),
    catalogItem("trustpilot", "Trustpilot", "reviews"),
    catalogItem("typeform", "Typeform", "forms"),
  ],
  counts: { available: 5 },
};

function primeAuth() {
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
}

function installMocks(
  opts: { reviewForbidden?: boolean; reviewFailure?: boolean } = {},
) {
  mocks.apiGet.mockImplementation((path: string) => {
    const p = String(path).split("?")[0];
    if (p === "/api/v1/integrations/catalog") return Promise.resolve(CATALOG);
    if (p === "/api/v1/crm/integrations") {
      return Promise.resolve({
        items: [
          {
            id: "c1",
            tenant_id: "tnt_1",
            provider: "salesforce",
            name: "SF",
            status: "active",
            scopes: [],
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      });
    }
    if (p === "/api/v1/integrations/slack") {
      // chat clients return a BARE array (no {items} envelope)
      return Promise.resolve([
        {
          id: "s1",
          tenant_id: "tnt_1",
          enabled: true,
          events: [],
          created_at: NOW,
          updated_at: NOW,
        },
      ]);
    }
    if (
      p === "/api/v1/integrations/discord" ||
      p === "/api/v1/integrations/teams" ||
      p === "/api/v1/commerce/integrations"
    ) {
      return Promise.resolve([]); // bare arrays
    }
    if (opts.reviewForbidden && p === "/api/v1/review-integrations") {
      return Promise.reject(new ApiError("forbidden", 403));
    }
    if (opts.reviewFailure && p === "/api/v1/review-integrations") {
      return Promise.reject(new Error("review surface unavailable"));
    }
    // every other active surface endpoint (review/loyalty/subscription/
    // analytics/marketing) + any unhandled path
    return Promise.resolve({ items: [] });
  });
}

function render(ui: ReactNode): { root: Root; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root, queryClient };
}

/**
 * The page's next/dynamic sections (posture panels, filters, grid) have all
 * landed: the grid's "Showing N of M" line is up, and no role="status"
 * skeleton labelled "Loading …" is left. The sections mount only once the
 * admin principal resolves, so the absence of skeletons alone would also
 * hold before anything had mounted.
 */
function expectSectionsLoaded(): void {
  const loading = Array.from(
    document.querySelectorAll('[role="status"][aria-label^="Loading"]'),
  ).map((node) => node.getAttribute("aria-label") ?? "");
  expect(loading).toEqual([]);
  expect(
    Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
      /^Showing \d+ of \d+/.test(node.textContent?.trim() ?? ""),
    ),
  ).toBe(true);
}

function cardFor(slug: string): HTMLElement | null {
  const link = document.querySelector(
    `a[href="/app/integrations/catalog/${slug}"]`,
  );
  return (link?.closest("[data-slot='card']") as HTMLElement) ?? null;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.searchParams = "";
  document.body.innerHTML = "";
});

describe("IntegrationCatalogPage connected view (INTG-029)", () => {
  // The posture panels, filters and grid load through next/dynamic. Import
  // their chunk in a hook, on the cold-import timeout, and let every test wait
  // for all three sections before it asserts. Otherwise an absent card could
  // mean "filtered out" or only "grid not loaded yet", and a chunk still in
  // flight when a test ended landed after it, outside act().
  importBeforeTests(
    () => import("@/app/(dashboard)/app/integrations/catalog/catalog-posture"),
  );

  it("shows the Your integrations section + Connected badges for connected providers only", async () => {
    primeAuth();
    installMocks();
    const { root } = render(createElement(IntegrationCatalogPage));
    try {
      await waitFor(expectSectionsLoaded);
      await waitFor(() => {
        expect(document.body.textContent).toContain("Your integrations");
        // Salesforce (CRM active) is connected → its card shows a Connected badge.
        const sf = cardFor("salesforce");
        expect(sf).not.toBeNull();
        expect(sf?.textContent).toContain("Connected");
      });
      // Typeform has no connection and no connectable surface → no badge.
      await waitFor(() => {
        const tf = cardFor("typeform");
        expect(tf).not.toBeNull();
        expect(tf?.textContent).not.toContain("Connected");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("deep-linked ?connected=1 narrows to connected items once the fan-out settles (no empty flash)", async () => {
    primeAuth();
    installMocks();
    mocks.searchParams = "connected=1";
    const { root } = render(createElement(IntegrationCatalogPage));
    try {
      await waitFor(expectSectionsLoaded);
      await waitFor(() => {
        // Connected providers remain...
        expect(cardFor("salesforce")).not.toBeNull();
        // ...and the unconnected one is filtered out of the whole page.
        expect(cardFor("typeform")).toBeNull();
      });
      // The connectedOnly gate must never have produced the empty-state card
      // (the whole point of gating on the fan-out-aware isFetched).
      expect(document.body.textContent).not.toContain(
        "No integrations match your filters",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("reports an authorization rejection instead of treating a 403 surface as empty", async () => {
    primeAuth();
    installMocks({ reviewForbidden: true });
    const { root } = render(createElement(IntegrationCatalogPage));
    try {
      await waitFor(expectSectionsLoaded);
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Admin authorization was rejected while checking connection status",
        );
      });
      await waitFor(() => {
        const sf = cardFor("salesforce");
        expect(sf).not.toBeNull();
        expect(sf?.textContent).not.toContain("Connected");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks a non-auth surface failure as partial and pauses Connected only", async () => {
    primeAuth();
    installMocks({ reviewFailure: true });
    const { root } = render(createElement(IntegrationCatalogPage));
    try {
      await waitFor(expectSectionsLoaded);
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Some connection surfaces could not be checked",
        );
      });

      // Known results remain useful, but an incomplete fan-out must never let
      // the operator apply a filter that presents those results as complete.
      expect(cardFor("salesforce")?.textContent).toContain("Connected");
      expect(
        [...document.querySelectorAll("button")].some(
          (candidate) => candidate.textContent?.trim() === "Connected only",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps support providers discoverable without requesting the held support surface", async () => {
    primeAuth();
    installMocks();
    const { root } = render(createElement(IntegrationCatalogPage));
    try {
      await waitFor(expectSectionsLoaded);
      await waitFor(() => {
        const zendesk = cardFor("zendesk");
        expect(zendesk).not.toBeNull();
        expect(zendesk?.textContent).not.toContain("Connected");
      });
      const paths = mocks.apiGet.mock.calls.map(([path]) => String(path));
      expect(paths.some((path) => path.includes("/support-integrations"))).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
