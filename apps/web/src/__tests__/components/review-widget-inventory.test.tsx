// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-43 — storefront review widgets on /app/reviews: Refresh
// inventory, search, lifecycle filter, clear. Rendered through the real page
// so the asserted refresh is the page's own GET /api/v1/reviews/widgets and
// the asserted list is what the operator sees in the widget surface.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReviewsPage from "@/app/(dashboard)/app/reviews/page";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/reviews",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, whoami: mocks.whoami };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "viewer@example.test",
  role: "viewer",
  effective_role: "viewer",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
} as const;

function widget(
  id: string,
  name: string,
  status: string,
  extra: Record<string, string> = {},
) {
  return {
    id,
    slug: `${id}-slug`,
    name,
    status,
    widget_type: "product_reviews",
    language: "en",
    public_url: "",
    ...extra,
  };
}

let inventory: unknown[];

beforeEach(() => {
  inventory = [
    widget("w-1", "Storefront carousel", "active"),
    widget("w-2", "Checkout badge", "draft", { language: "de" }),
    widget("w-3", "Archive wall", "archived"),
  ];
  mocks.whoami.mockResolvedValue(VIEWER);
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === "/api/v1/reviews/widgets") {
      return Promise.resolve({ items: inventory });
    }
    if (path === "/api/v1/reviews/catalog") {
      return Promise.resolve({
        statuses: [],
        widget_types: [],
        authenticity: [],
        request_channels: [],
        public_contract: "",
        schema_version: "",
      });
    }
    if (path === "/api/v1/reviews") return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
});

let root: Root | null = null;

async function flush() {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReviewsPage),
      ),
    );
  });
  await flush();
  return container;
}

function widgetSurface(scope: ParentNode): HTMLElement {
  const heading = scope.querySelector("#rv-widgets");
  const section = heading?.closest("section");
  if (!section) throw new Error("widget surface missing");
  return section;
}

function shownWidgets(scope: ParentNode): string[] {
  return [
    ...widgetSurface(scope).querySelectorAll(
      'ul[aria-label="Review widgets"] > li p.font-medium',
    ),
  ].map((node) => node.textContent ?? "");
}

function widgetGets(): number {
  return mocks.apiGet.mock.calls.filter(
    ([path]) => path === "/api/v1/reviews/widgets",
  ).length;
}

function button(scope: ParentNode, label: string | RegExp): HTMLButtonElement {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => {
      const text = candidate.textContent?.trim() ?? "";
      return typeof label === "string" ? text === label : label.test(text);
    },
  );
  if (!node) throw new Error(`missing button ${String(label)}`);
  return node;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("review widget inventory controls", () => {
  it("lists widgets in lifecycle order with per-state counts", async () => {
    const scope = await renderPage();
    const surface = widgetSurface(scope);
    expect(shownWidgets(scope)).toEqual([
      "Storefront carousel",
      "Checkout badge",
      "Archive wall",
    ]);
    expect(button(surface, /^All/).textContent).toBe("All 3");
    expect(button(surface, /^Paused/).textContent).toBe("Paused 0");
  });

  it("Refresh re-reads GET /api/v1/reviews/widgets and renders the new inventory", async () => {
    const scope = await renderPage();
    expect(widgetGets()).toBe(1);
    inventory = [...inventory, widget("w-4", "Footer stars", "paused")];

    await act(async () => {
      button(widgetSurface(scope), "Refresh").click();
    });
    await flush();

    expect(widgetGets()).toBe(2);
    expect(shownWidgets(scope)).toContain("Footer stars");
    expect(button(widgetSurface(scope), /^Paused/).textContent).toBe(
      "Paused 1",
    );
  });

  it("filters by lifecycle state and by search, then clears both", async () => {
    const scope = await renderPage();
    const surface = widgetSurface(scope);

    act(() => button(surface, /^Draft/).click());
    expect(button(surface, /^Draft/).getAttribute("aria-pressed")).toBe("true");
    expect(shownWidgets(scope)).toEqual(["Checkout badge"]);

    act(() => button(surface, /^All/).click());
    const search = surface.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    // Language is searchable, as on desktop.
    type(search, "de");
    expect(shownWidgets(scope)).toEqual(["Checkout badge"]);

    act(() => button(surface, /^Archived/).click());
    expect(shownWidgets(scope)).toEqual([]);
    expect(surface.textContent).toContain("No widgets match this view");

    act(() => button(surface, "Reset view").click());
    expect(shownWidgets(scope)).toHaveLength(3);
    expect(search.value).toBe("");
    expect(button(surface, /^All/).getAttribute("aria-pressed")).toBe("true");
    // Filtering is local: no extra read.
    expect(widgetGets()).toBe(1);
  });

  it("keeps the confirmed-empty inventory state and still offers Refresh", async () => {
    inventory = [];
    const scope = await renderPage();
    const surface = widgetSurface(scope);
    expect(surface.textContent).toContain("No review widgets yet");
    await act(async () => {
      button(surface, "Refresh").click();
    });
    await flush();
    expect(widgetGets()).toBe(2);
  });
});
