// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/commerce — the Store data tab (commerce-7/8/9/10/11) and the
// Integrations panel's per-store "Browse data" link into it. Every assertion
// is on the CONSEQUENCE of a verb: the request's method + path + query, the
// rendered result, or the server's sentence rendered verbatim. `@/lib/api` is
// mocked at the transport so the literal "/api/v1/…" paths are what is
// asserted, not a friendlier wrapper.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { COMMERCE_ADMIN_ONLY_MESSAGE } from "@/lib/commerce-authority";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  replace: vi.fn(),
  search: { current: "" },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: mocks.replace,
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/commerce",
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fixtures: the shapes the Go handlers answer with ---------- */

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
};
const VIEWER = {
  ...OWNER,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const SHOP = "brand.myshopify.com";
const INTEGRATIONS_PATH = "/api/v1/commerce/integrations";
const CATALOGS_PATH = "/api/v1/commerce/catalogs";
const STORE = "/api/v1/commerce/integrations/int_1";
const ANALYTICS_PATH = `${STORE}/analytics`;
const CUSTOMERS_PATH = `${STORE}/customers`;
const PRODUCTS_PATH = `${STORE}/products`;
const ORDERS_PATH = `${STORE}/orders`;
const EVENTS_PATH = `${STORE}/events`;
const VARIANTS_PATH = `${STORE}/products/prod_1/variants`;
const INVENTORY_PATH = `${STORE}/products/prod_1/inventory`;
const PRICE_HISTORY_PATH = `${STORE}/products/prod_1/price-history`;

const STAMP = "2026-08-01T00:00:00Z";

const INTEGRATIONS = [
  {
    id: "int_1",
    provider: "shopify",
    shop_domain: SHOP,
    status: "connected",
    scopes: [],
    settings: {},
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "int_2",
    provider: "woocommerce",
    shop_domain: "shop.example",
    status: "connected",
    scopes: [],
    settings: {},
    created_at: STAMP,
    updated_at: STAMP,
  },
];

const ANALYTICS = {
  customers: 42,
  products: 7,
  orders: 12,
  revenue_cents: 123456,
  average_order_cents: 10288,
  currency: "USD",
  orders_by_status: { paid: 11, cancelled: 1 },
  last_order_at: "2026-09-01T10:00:00Z",
};

const CUSTOMER_1 = {
  id: "cust_1",
  source_id: "c-1",
  email: "jane@example.com",
  first_name: "Jane",
  last_name: "Doe",
  accepts_marketing: true,
  tags: ["vip", "newsletter"],
  created_at: STAMP,
  updated_at: "2026-08-30T12:00:00Z",
};
const CUSTOMER_2 = {
  id: "cust_2",
  source_id: "c-2",
  email: "sam@example.com",
  accepts_marketing: false,
  tags: null,
  created_at: STAMP,
  updated_at: STAMP,
};
const CUSTOMER_3 = {
  id: "cust_3",
  source_id: "c-3",
  accepts_marketing: false,
  tags: [],
  created_at: STAMP,
  updated_at: STAMP,
};
const CUSTOMERS_PAGE_1 = { items: [CUSTOMER_1, CUSTOMER_2], next_cursor: "cust_2" };
const CUSTOMERS_PAGE_2 = { items: [CUSTOMER_3] };

const PRODUCT_1 = {
  id: "prod_1",
  source_id: "p-1",
  title: "Enamel mug",
  price_cents: 1900,
  currency: "USD",
  created_at: STAMP,
  updated_at: STAMP,
};
const PRODUCT_2 = { ...PRODUCT_1, id: "prod_2", source_id: "p-2", title: "Canvas tote", price_cents: 2400 };

const ORDER_1 = {
  id: "ord_1",
  source_id: "o-1001",
  customer_email: "jane@example.com",
  status: "paid",
  subtotal_cents: 4300,
  discount_cents: 300,
  shipping_cents: 500,
  tax_cents: 200,
  total_cents: 4700,
  currency: "USD",
  campaign_id: "camp_9",
  attribution: {},
  line_items: [],
  ordered_at: "2026-09-01T10:00:00Z",
  created_at: STAMP,
  updated_at: STAMP,
};

const EVENT_FAILED = {
  id: 501,
  event_type: "sync_failed",
  provider_topic: "bulk_operations/finish",
  provider_event_id: "evt-501",
  metadata: { error: "shopify bulk operation failed: TIMEOUT" },
  at: "2026-09-02T08:00:00Z",
};
const EVENT_ORDER = {
  id: 502,
  event_type: "order_created",
  customer_email: "jane@example.com",
  order_id: "ord_1",
  metadata: {},
  at: "2026-09-01T10:00:00Z",
};

const VARIANT_1 = {
  id: "var_1",
  product_id: "prod_1",
  source_id: "v-1",
  sku: "MUG-RED-12",
  title: "Red / 12oz",
  option_values: { color: "red", size: "12oz" },
  price_cents: 1900,
  compare_at_price_cents: 2200,
  currency: "USD",
  inventory_quantity: 14,
  inventory_policy: "deny",
  available: true,
  created_at: STAMP,
  updated_at: STAMP,
};
const SNAPSHOT_1 = {
  id: "snap_1",
  product_id: "prod_1",
  variant_id: "var_1",
  quantity: 0,
  available: false,
  inventory_policy: "deny",
  observed_at: "2026-09-03T09:00:00Z",
  source_event_id: "evt-777",
  metadata: {},
};
const PRICE_1 = {
  id: "pp_1",
  product_id: "prod_1",
  variant_id: "var_1",
  price_cents: 1700,
  compare_at_price_cents: 2200,
  currency: "USD",
  observed_at: "2026-09-03T09:00:00Z",
  source_event_id: "evt-778",
  metadata: {},
};

type Answer = () => Promise<unknown>;
const overrides = new Map<string, Answer>();

function stubTransport(): void {
  mocks.apiGet.mockImplementation(
    (path: string, opts?: { query?: Record<string, unknown> }) => {
      const override = overrides.get(path);
      if (override) return override();
      const cursor = opts?.query?.cursor;
      switch (path) {
        case INTEGRATIONS_PATH:
          return Promise.resolve(INTEGRATIONS);
        case CATALOGS_PATH:
          return Promise.resolve({ items: [] });
        case ANALYTICS_PATH:
          return Promise.resolve(ANALYTICS);
        case CUSTOMERS_PATH:
          if (cursor === undefined) return Promise.resolve(CUSTOMERS_PAGE_1);
          if (cursor === "cust_2") return Promise.resolve(CUSTOMERS_PAGE_2);
          return Promise.reject(new Error(`Unexpected cursor ${String(cursor)}`));
        case PRODUCTS_PATH:
          return Promise.resolve({ items: [PRODUCT_1, PRODUCT_2] });
        case ORDERS_PATH:
          return Promise.resolve({ items: [ORDER_1] });
        case EVENTS_PATH:
          return Promise.resolve({ items: [EVENT_FAILED, EVENT_ORDER] });
        case VARIANTS_PATH:
          return Promise.resolve({ items: [VARIANT_1] });
        case INVENTORY_PATH:
          return Promise.resolve({ items: [SNAPSHOT_1] });
        case PRICE_HISTORY_PATH:
          return Promise.resolve({ items: [PRICE_1] });
        default:
          // The Integrations panel polls every store's events; others are empty.
          if (/^\/api\/v1\/commerce\/integrations\/[^/]+\/events$/u.test(path)) {
            return Promise.resolve({ items: [] });
          }
          return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    },
  );
  mocks.apiPost.mockImplementation((path: string) =>
    Promise.reject(new Error(`Unexpected POST ${path}`)),
  );
}

/* ---------- harness ---------- */

async function render(ui: ReactNode): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function text(): string {
  return document.body.textContent ?? "";
}

function q<T extends Element>(selector: string, scope: ParentNode = document): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

function dialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function dialogContaining(needle: string): HTMLElement {
  const el = dialogs().find((d) => d.textContent?.includes(needle));
  if (!el) throw new Error(`No open dialog containing "${needle}"`);
  return el;
}

function buttonByText(label: string, scope: ParentNode = document): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`Missing button "${label}"`);
  return el;
}

function maybeButtonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

function buttonByLabel(label: string): HTMLButtonElement {
  return q<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

/** The Store data view switcher (Customers / Products / Orders / Events). */
function viewTab(label: string): HTMLElement {
  const list = q<HTMLElement>('[role="tablist"][aria-label="Store data view"]');
  const tab = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.textContent?.trim() === label,
  );
  if (!tab) throw new Error(`Missing store data view tab "${label}"`);
  return tab;
}

function selectedTabs(): string[] {
  return [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(
    (t) => t.textContent?.trim() ?? "",
  );
}

/** The analytics strip's tiles, by label: first <dd> is the value, second the hint. */
function analyticsTiles(): Map<string, { value: string; hint: string | null }> {
  const section = [...document.querySelectorAll("section")].find((s) =>
    s.querySelector("h3")?.textContent?.startsWith("Store analytics"),
  );
  if (!section) throw new Error("Missing store analytics section");
  const map = new Map<string, { value: string; hint: string | null }>();
  for (const tile of section.querySelectorAll("dl > div")) {
    const label = tile.querySelector("dt")?.textContent?.trim() ?? "";
    const dds = [...tile.querySelectorAll("dd")].map((dd) => dd.textContent?.trim() ?? "");
    map.set(label, { value: dds[0] ?? "", hint: dds[1] ?? null });
  }
  return map;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

/** Radix activates a tab on left mousedown (or on focus); a bare click() is
 *  neither, so press it the way a pointer does. */
async function pressTab(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
    await flush();
  });
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function getCalls(path: string): Array<{ query?: Record<string, unknown> } | undefined> {
  return mocks.apiGet.mock.calls
    .filter(([p]) => p === path)
    .map(([, opts]) => opts as { query?: Record<string, unknown> } | undefined);
}

async function mountPage(search: string): Promise<Root> {
  mocks.search.current = search;
  const Page = (await import("@/app/(dashboard)/app/commerce/page")).default;
  const root = await render(createElement(Page));
  await waitFor(() => {
    expect(document.querySelector("h1")?.textContent).toBe("Commerce workspace");
  });
  return root;
}

async function mountStore(): Promise<Root> {
  const root = await mountPage("tab=stores&store=int_1");
  await waitFor(() => expect(text()).toContain("j•••@example.com"));
  return root;
}

function unmount(root: Root): void {
  act(() => root.unmount());
}

// The modules these tests import are cold work for vitest's transform
// pipeline; pay them before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/commerce/page"),
  () => import("@/app/(dashboard)/app/integrations/commerce-integrations-panel"),
);

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  overrides.clear();
  stubTransport();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/* ---------- commerce-7: browse store data ---------- */

describe("/app/commerce — Store data tab (commerce-7)", () => {
  it("a shared ?tab=stores&store= URL opens on that store, lists its customers through the cursor contract, and pages Next/Previous", async () => {
    const root = await mountStore();
    try {
      expect(selectedTabs()).toEqual(["Store data", "Customers"]);
      expect(q<HTMLSelectElement>('select[id$="-store"]').value).toBe("int_1");
      expect(getCalls(CUSTOMERS_PATH)[0]).toEqual({
        query: { limit: 25, cursor: undefined },
      });
      // The row is the provider record, with the address masked the way
      // desktop masks it; the raw address never reaches the page.
      expect(text()).toContain("Customer ID: cust_1 · Source ID: c-1");
      expect(text()).toContain("Jane Doe");
      expect(text()).toContain("Tags: vip, newsletter");
      expect(text()).toContain("Store flag: accepts");
      expect(text()).toContain("Name not recorded");
      expect(text()).toContain("Tags: none");
      expect(text()).toContain("Store flag: does not accept");
      expect(text()).not.toContain("jane@example.com");
      expect(text()).toContain("Page 1 · 2 items on this page; more are available.");
      expect(buttonByLabel("Previous page of customers").disabled).toBe(true);

      await click(buttonByLabel("Next page of customers"));
      await waitFor(() => expect(text()).toContain("Email not recorded"));
      expect(getCalls(CUSTOMERS_PATH).at(-1)).toEqual({
        query: { limit: 25, cursor: "cust_2" },
      });
      expect(text()).toContain("Page 2 · 1 item on this page.");
      expect(text()).not.toContain("j•••@example.com");
      expect(buttonByLabel("Next page of customers").disabled).toBe(true);

      await click(buttonByLabel("Previous page of customers"));
      await waitFor(() => expect(text()).toContain("j•••@example.com"));
      expect(text()).toContain("Page 1 · 2 items on this page");
      expect(text()).not.toContain("Email not recorded");
    } finally {
      unmount(root);
    }
  });

  it("choosing a store mirrors ?store= to the URL, and each view requests its own list from the store's route", async () => {
    const root = await mountPage("tab=stores");
    try {
      await waitFor(() =>
        expect(q<HTMLSelectElement>('select[id$="-store"]').options.length).toBe(3),
      );
      expect(text()).toContain(
        "Choose a store to browse its synced customers, products, orders, and events.",
      );
      expect(getCalls(CUSTOMERS_PATH)).toHaveLength(0);
      expect(getCalls(ANALYTICS_PATH)).toHaveLength(0);

      await choose(q<HTMLSelectElement>('select[id$="-store"]'), "int_1");
      expect(mocks.replace).toHaveBeenLastCalledWith(
        "/app/commerce?tab=stores&store=int_1",
        { scroll: false },
      );
      await waitFor(() => expect(text()).toContain("j•••@example.com"));
      expect(text()).toContain(`Store analytics — ${SHOP}`);

      await pressTab(viewTab("Products"));
      await waitFor(() => expect(text()).toContain("Enamel mug"));
      expect(getCalls(PRODUCTS_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      expect(text()).toContain("Product ID: prod_1 · Source ID: p-1");
      expect(text()).toContain("Canvas tote");
      expect(text()).toMatch(/19[.,]00/u);
      expect(text()).toContain("Page 1 · 2 items on this page.");

      await pressTab(viewTab("Orders"));
      await waitFor(() => expect(text()).toContain("Source ID: o-1001"));
      expect(getCalls(ORDERS_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      expect(text()).toContain("Order ID: ord_1");
      expect(text()).toContain("Campaign ID: camp_9");
      expect(text()).toContain("Paid");
      expect(text()).toMatch(/Total: \D*47[.,]00/u);
      expect(text()).toMatch(/Subtotal \D*43[.,]00 · Discount \D*3[.,]00 · Shipping \D*5[.,]00 · Tax \D*2[.,]00/u);

      await pressTab(viewTab("Events"));
      await waitFor(() => expect(text()).toContain("sync_failed"));
      expect(getCalls(EVENTS_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      expect(text()).toContain(
        "Event ID: 501 · Provider topic: bulk_operations/finish · Provider event ID: evt-501",
      );
      expect(text()).toContain("shopify bulk operation failed: TIMEOUT");
      expect(text()).toContain("Order not recorded");
      expect(text()).toContain("order_created");
      expect(text()).toContain("ord_1");
    } finally {
      unmount(root);
    }
  });

  it("a refusal on a store list is rendered in the server's words — a 404 here is the server's 'integration not found', not the catalogs sentence", async () => {
    overrides.set(CUSTOMERS_PATH, () =>
      Promise.reject(
        new ApiError("integration not found", 404, undefined, { code: "not_found" }),
      ),
    );
    const root = await mountPage("tab=stores&store=int_1");
    try {
      await waitFor(() => expect(text()).toContain("integration not found"));
      expect(text()).not.toContain("Commerce catalogs are not enabled");
      expect(buttonByText("Retry customers")).toBeTruthy();
      // The analytics strip is independent of the failed list.
      await waitFor(() => expect(analyticsTiles().get("Customers")?.value).toBe("42"));
    } finally {
      unmount(root);
    }
  });

  it("with no connected store there is nothing to browse, and no per-store request is made", async () => {
    overrides.set(INTEGRATIONS_PATH, () => Promise.resolve([]));
    const root = await mountPage("tab=stores");
    try {
      await waitFor(() => expect(text()).toContain("No connected stores"));
      expect(text()).toContain("No connected store is available");
      expect(mocks.apiGet.mock.calls.some(([p]) => String(p).startsWith(`${INTEGRATIONS_PATH}/`))).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-8: analytics strip ---------- */

describe("/app/commerce — Store data analytics strip (commerce-8)", () => {
  it("requests the store's analytics, renders the imported-record tiles verbatim, and Refresh analytics requests them again", async () => {
    const root = await mountStore();
    try {
      await waitFor(() => expect(analyticsTiles().size).toBe(5));
      expect(getCalls(ANALYTICS_PATH)).toEqual([undefined]);
      expect(text()).toContain(
        "Imported-record aggregate. Reporting window, generation time, and currency-mix provenance are unavailable from this response.",
      );
      const tiles = analyticsTiles();
      expect([...tiles.keys()]).toEqual(["Customers", "Products", "Orders", "Revenue", "Avg order"]);
      expect(tiles.get("Customers")).toEqual({ value: "42", hint: null });
      expect(tiles.get("Products")).toEqual({ value: "7", hint: null });
      expect(tiles.get("Orders")).toEqual({ value: "12", hint: "cancelled 1 · paid 11" });
      expect(tiles.get("Revenue")?.value).toMatch(/1[,.]234[.,]56/u);
      expect(tiles.get("Avg order")?.value).toMatch(/102[.,]88/u);
      expect(tiles.get("Avg order")?.hint).toMatch(/^last order /u);

      await click(buttonByText("Refresh analytics"));
      await waitFor(() => expect(getCalls(ANALYTICS_PATH)).toHaveLength(2));
      // The lists were not re-requested by an analytics refresh.
      expect(getCalls(CUSTOMERS_PATH)).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("an analytics refusal keeps the server's sentence and the tables still load", async () => {
    overrides.set(ANALYTICS_PATH, () =>
      Promise.reject(new ApiError("Reports scope required.", 403, undefined, { code: "forbidden" })),
    );
    const root = await mountStore();
    try {
      await waitFor(() => expect(text()).toContain("Reports scope required."));
      expect(buttonByText("Retry store analytics")).toBeTruthy();
      expect(() => analyticsTiles().size).not.toThrow();
      expect(analyticsTiles().size).toBe(0);
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-9/10/11: per-product drill-downs ---------- */

describe("/app/commerce — Store data product drill-downs", () => {
  async function openProducts(): Promise<Root> {
    const root = await mountStore();
    await pressTab(viewTab("Products"));
    await waitFor(() => expect(text()).toContain("Enamel mug"));
    return root;
  }

  it("commerce-9: Variants requests the product's variants route and renders each variant's identifiers, options, prices and stock", async () => {
    const root = await openProducts();
    try {
      await click(buttonByLabel("View variants for Enamel mug"));
      await waitFor(() => expect(getCalls(VARIANTS_PATH)).toHaveLength(1));
      expect(getCalls(VARIANTS_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      await waitFor(() =>
        expect(dialogContaining("Variants — Enamel mug").textContent).toContain("Red / 12oz"),
      );
      const dialog = dialogContaining("Variants — Enamel mug");
      expect(dialog.textContent).toContain(
        "Every variant Moosewave has synced for this product, with price and stock state.",
      );
      expect(dialog.textContent).toContain("Variant ID: var_1 · Source ID: v-1");
      expect(dialog.textContent).toContain("MUG-RED-12");
      expect(dialog.textContent).toContain("Options: color: red · size: 12oz");
      expect(dialog.textContent).toMatch(/19[.,]00/u);
      expect(dialog.textContent).toMatch(/Compare at: \D*22[.,]00/u);
      expect(dialog.textContent).toContain("14");
      expect(dialog.textContent).toContain("Policy: deny");
      expect(dialog.textContent).toContain("In stock");
      expect(dialog.textContent).toContain("Page 1 · 1 item on this page.");
      expect(buttonByLabel("Next page of variants").disabled).toBe(true);
      expect(getCalls(INVENTORY_PATH)).toHaveLength(0);
      expect(getCalls(PRICE_HISTORY_PATH)).toHaveLength(0);

      await click(buttonByText("Close", dialog));
      await waitFor(() => expect(dialogs()).toHaveLength(0));
    } finally {
      unmount(root);
    }
  });

  it("commerce-10: Inventory requests the product's inventory route and renders the snapshots newest first", async () => {
    const root = await openProducts();
    try {
      await click(buttonByLabel("View inventory for Enamel mug"));
      await waitFor(() => expect(getCalls(INVENTORY_PATH)).toHaveLength(1));
      expect(getCalls(INVENTORY_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      await waitFor(() =>
        expect(dialogContaining("Inventory — Enamel mug").textContent).toContain("Snapshot ID: snap_1"),
      );
      const dialog = dialogContaining("Inventory — Enamel mug");
      expect(dialog.textContent).toContain("Back-in-stock alerts key off these.");
      expect(dialog.textContent).toContain("Variant ID: var_1");
      expect(dialog.textContent).toContain("Out of stock");
      expect(dialog.textContent).toContain("deny");
      expect(dialog.textContent).toContain("Source event ID: evt-777");
      expect(buttonByLabel("Next page of inventory snapshots").disabled).toBe(true);
      expect(getCalls(VARIANTS_PATH)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("commerce-11: Prices requests the product's price-history route and renders each observed price with its compare-at", async () => {
    const root = await openProducts();
    try {
      await click(buttonByLabel("View price history for Enamel mug"));
      await waitFor(() => expect(getCalls(PRICE_HISTORY_PATH)).toHaveLength(1));
      expect(getCalls(PRICE_HISTORY_PATH)[0]).toEqual({ query: { limit: 25, cursor: undefined } });
      await waitFor(() =>
        expect(dialogContaining("Price history — Enamel mug").textContent).toContain("Price point ID: pp_1"),
      );
      const dialog = dialogContaining("Price history — Enamel mug");
      expect(dialog.textContent).toContain("Price-drop watchers key off these.");
      expect(dialog.textContent).toContain("Variant ID: var_1");
      expect(dialog.textContent).toMatch(/17[.,]00/u);
      expect(dialog.textContent).toMatch(/22[.,]00/u);
      expect(dialog.textContent).toContain("Source event ID: evt-778");
      expect(buttonByLabel("Next page of price history").disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("a drill-down refusal is the server's sentence — 'product not found' stays 'product not found'", async () => {
    overrides.set(VARIANTS_PATH, () =>
      Promise.reject(new ApiError("product not found", 404, undefined, { code: "not_found" })),
    );
    const root = await openProducts();
    try {
      await click(buttonByLabel("View variants for Enamel mug"));
      await waitFor(() =>
        expect(dialogContaining("Variants — Enamel mug").textContent).toContain("product not found"),
      );
      expect(dialogContaining("Variants — Enamel mug").textContent).not.toContain(
        "Commerce catalogs are not enabled",
      );
    } finally {
      unmount(root);
    }
  });
});

/* ---------- role gating ---------- */

describe("/app/commerce — Store data role gating", () => {
  it("a viewer can browse store data (every route is read-scope) while the workspace note still names the withheld admin verbs", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const root = await mountStore();
    try {
      expect(getCalls(CUSTOMERS_PATH)).toHaveLength(1);
      await waitFor(() => expect(getCalls(ANALYTICS_PATH)).toHaveLength(1));
      expect(text()).toContain(COMMERCE_ADMIN_ONLY_MESSAGE);
      expect(maybeButtonByText("Connect Shopify")).toBeUndefined();
      expect(q<HTMLSelectElement>('select[id$="-store"]').disabled).toBe(false);
      expect(buttonByLabel("Next page of customers")).toBeTruthy();
      expect(buttonByText("Refresh analytics")).toBeTruthy();
    } finally {
      unmount(root);
    }
  });
});

/* ---------- Integrations page → Store data ---------- */

describe("Integrations page native commerce panel → Browse data", () => {
  it("each connected store links to its Store data view by URL", async () => {
    const { CommerceIntegrationsPanel } = await import(
      "@/app/(dashboard)/app/integrations/commerce-integrations-panel"
    );
    const root = await render(createElement(CommerceIntegrationsPanel));
    try {
      await waitFor(() => expect(text()).toContain(SHOP));
      const link = q<HTMLAnchorElement>(`a[aria-label="Browse data for ${SHOP}"]`);
      expect(link.textContent?.trim()).toBe("Browse data");
      expect(link.getAttribute("href")).toBe("/app/commerce?tab=stores&store=int_1");
      expect(
        q<HTMLAnchorElement>('a[aria-label="Browse data for shop.example"]').getAttribute("href"),
      ).toBe("/app/commerce?tab=stores&store=int_2");
    } finally {
      unmount(root);
    }
  });
});
