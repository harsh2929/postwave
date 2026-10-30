// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  analytics: vi.fn(),
  createBackInStockSubscription: vi.fn(),
  createCatalog: vi.fn(),
  createPriceDropWatcher: vi.fn(),
  createProductFeed: vi.fn(),
  importCatalogProducts: vi.fn(),
  listBackInStockSubscriptions: vi.fn(),
  listCartRecoveryLinks: vi.fn(),
  listCatalogs: vi.fn(),
  listCustomers: vi.fn(),
  listEvents: vi.fn(),
  listInventorySnapshots: vi.fn(),
  listOrders: vi.fn(),
  listPriceDropWatchers: vi.fn(),
  listPriceHistory: vi.fn(),
  listProductFeeds: vi.fn(),
  listProducts: vi.fn(),
  listProductVariants: vi.fn(),
  resolveProductFeed: vi.fn(),
  upsertCartRecoveryLink: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  commerceApi: {
    analytics: mocks.analytics,
    createBackInStockSubscription: mocks.createBackInStockSubscription,
    createCatalog: mocks.createCatalog,
    createPriceDropWatcher: mocks.createPriceDropWatcher,
    createProductFeed: mocks.createProductFeed,
    importCatalogProducts: mocks.importCatalogProducts,
    listBackInStockSubscriptions: mocks.listBackInStockSubscriptions,
    listCartRecoveryLinks: mocks.listCartRecoveryLinks,
    listCatalogs: mocks.listCatalogs,
    listCustomers: mocks.listCustomers,
    listEvents: mocks.listEvents,
    listInventorySnapshots: mocks.listInventorySnapshots,
    listOrders: mocks.listOrders,
    listPriceDropWatchers: mocks.listPriceDropWatchers,
    listPriceHistory: mocks.listPriceHistory,
    listProductFeeds: mocks.listProductFeeds,
    listProducts: mocks.listProducts,
    listProductVariants: mocks.listProductVariants,
    resolveProductFeed: mocks.resolveProductFeed,
    upsertCartRecoveryLink: mocks.upsertCartRecoveryLink,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { discounts: "commerce-discounts.webp" },
}));

import { CatalogsTab } from "../../components/commerce/CatalogsTab";
import { IntegrationsTab } from "../../components/commerce/IntegrationsTab";
import { Pager } from "../../components/commerce/Pager";
import { RecoveryTab } from "../../components/commerce/RecoveryTab";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const page = <T,>(items: T[], nextCursor?: string) => ({
  items,
  ...(nextCursor ? { next_cursor: nextCursor } : {}),
});

const integration = {
  id: "integration-complete-id-123456789",
  provider: "shopify",
  shop_domain: "mature-store.myshopify.com",
  status: "active",
  scopes: ["read_products"],
  settings: {},
  last_sync_at: "2026-07-16T06:30:00.000Z",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-16T06:30:00.000Z",
};

const catalog = {
  id: "catalog-complete-id-123456789",
  integration_id: integration.id,
  name: "A complete seasonal catalog name",
  source_type: "feed",
  feed_url: "https://catalog.example/products.json?tenant=full",
  status: "active",
  locale: "en-IN",
  default_currency: "INR",
  last_sync_at: "2026-07-16T06:30:00.000Z",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-16T06:30:00.000Z",
};

const feed = {
  id: "feed-complete-id-123456789",
  catalog_id: catalog.id,
  name: "Complete best sellers feed",
  feed_type: "best_sellers",
  status: "active",
  criteria: { collection: "summer", market: "india" },
  fallback: { feed_id: "fallback-complete-id" },
  max_items: 6,
  exclude_out_of_stock: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-16T06:30:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analytics.mockResolvedValue({
    data: {
      customers: 1,
      products: 1,
      orders: 1,
      revenue_cents: 10000,
      average_order_cents: 10000,
      currency: "INR",
      orders_by_status: { paid: 1 },
      last_order_at: "2026-07-16T06:30:00.000Z",
    },
  });
  mocks.listCustomers.mockResolvedValue({
    data: page([
      {
        id: "customer-complete-id-123456789",
        source_id: "provider-customer-complete-id",
        email: "customer@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
        accepts_marketing: true,
        tags: ["loyal", "wholesale"],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-16T06:30:00.000Z",
      },
    ]),
  });
  mocks.listProducts.mockResolvedValue({ data: page([]) });
  mocks.listOrders.mockResolvedValue({ data: page([]) });
  mocks.listEvents.mockResolvedValue({ data: page([]) });
  mocks.listProductVariants.mockResolvedValue({ data: page([]) });
  mocks.listInventorySnapshots.mockResolvedValue({ data: page([]) });
  mocks.listPriceHistory.mockResolvedValue({ data: page([]) });
  mocks.listCartRecoveryLinks.mockResolvedValue({
    data: page([
      {
        id: "recovery-link-complete-id-123456789",
        integration_id: integration.id,
        source_cart_id: "cart-complete-id-123456789",
        customer_email: "customer@example.com",
        recovery_url:
          "https://store.example/cart/restore?token=sensitive-but-explicit",
        status: "pending",
        expires_at: "2026-07-18T06:30:00.000Z",
        metadata: {},
        created_at: "2026-07-16T06:00:00.000Z",
        updated_at: "2026-07-16T06:30:00.000Z",
      },
    ]),
  });
  mocks.listBackInStockSubscriptions.mockResolvedValue({ data: page([]) });
  mocks.listPriceDropWatchers.mockResolvedValue({ data: page([]) });
  mocks.listCatalogs.mockResolvedValue({ data: page([catalog]) });
  mocks.listProductFeeds.mockResolvedValue({ data: page([feed]) });
  mocks.resolveProductFeed.mockResolvedValue({
    data: {
      feed_id: feed.id,
      catalog_id: catalog.id,
      feed_type: feed.feed_type,
      subscriber_email: "customer@example.com",
      exclude_out_of_stock: true,
      total: 1,
      page: 1,
      per_page: 25,
      items: [
        {
          product_id: "product-complete-id-123456789",
          variant_id: "variant-complete-id-123456789",
          source_id: "provider-product-complete-id",
          variant_source_id: "provider-variant-complete-id",
          title: "Complete resolved product title",
          price_cents: 129900,
          compare_at_price_cents: 149900,
          currency: "INR",
          available: true,
          reason: "Highest verified revenue in the selected catalog window",
          rank: 1,
        },
      ],
    },
  });
  mocks.createCatalog.mockResolvedValue({ data: catalog });
  mocks.createBackInStockSubscription.mockResolvedValue({
    data: { id: "stock-subscription-created" },
  });
  mocks.createPriceDropWatcher.mockResolvedValue({
    data: { id: "price-watcher-created" },
  });
  mocks.createProductFeed.mockResolvedValue({ data: feed });
  mocks.importCatalogProducts.mockResolvedValue({
    data: {
      products_seen: 1,
      products_upserted: 1,
      catalog_items_upserted: 1,
      products_skipped: 0,
    },
  });
  mocks.upsertCartRecoveryLink.mockResolvedValue({
    data: { id: "recovery-link-created" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
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
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function change(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(control: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function expectNoSeriousAxeViolations(): Promise<void> {
  const result = await axe.run(container ?? document.body);
  expect(
    result.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

describe("commerce UI maturity wave 11", () => {
  it("qualifies integrations as a semantic, complete, keyboard-operable surface", async () => {
    render(
      <IntegrationsTab
        integrations={[integration]}
        err={null}
        canAdmin
        onReload={vi.fn().mockResolvedValue(undefined)}
        administrationIntent={null}
        onAdministrationIntentResolved={vi.fn()}
      />,
    );

    expect(
      container?.querySelector(
        '[role="table"][aria-label="Store integrations"]',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(integration.id);
    act(() => button("Browse data").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "customer-complete-id-123456789",
      );
      expect(document.body.textContent).toContain(
        "provider-customer-complete-id",
      );
      expect(document.querySelectorAll('[role="tab"]')).toHaveLength(4);
    });

    const customersTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((candidate) => candidate.textContent === "Customers");
    if (!customersTab) throw new Error("Missing Customers tab");
    act(() => {
      customersTab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('[role="tab"]'))
          .find((candidate) => candidate.textContent === "Products")
          ?.getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(container?.querySelector("[title]")).toBeNull();
    await expectNoSeriousAxeViolations();
  });

  it("qualifies recovery filters, secret masking, values, and table semantics", async () => {
    render(
      <RecoveryTab
        integrations={[integration]}
        integrationsErr={null}
        canAdmin={false}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "recovery-link-complete-id-123456789",
      );
    });
    expect(document.body.textContent).toContain("cart-complete-id-123456789");
    expect(document.body.textContent).toContain("https://store.example");
    expect(document.body.textContent).toContain("Secure path and token hidden");
    expect(document.body.textContent).not.toContain("/cart/restore");
    expect(document.body.textContent).not.toContain("sensitive-but-explicit");
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(5);
    expect(
      container?.querySelector(
        '[role="table"][aria-label="Cart-recovery links"]',
      ),
    ).toBeTruthy();
    expect(container?.querySelector("[title]")).toBeNull();
    await expectNoSeriousAxeViolations();
  });

  it("qualifies catalogs and feeds with complete source and rule context", async () => {
    render(<CatalogsTab canAdmin />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(catalog.id);
    });
    expect(document.body.textContent).toContain(integration.id);
    expect(document.body.textContent).toContain("en-IN");
    act(() => button("Feeds").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(feed.id);
      expect(document.body.textContent).toContain(
        "Criteria: 2 configured fields",
      );
      expect(document.body.textContent).toContain(
        "Fallback: 1 configured field",
      );
    });
    expect(document.body.textContent).not.toContain('"collection":"summer"');
    expect(document.body.textContent).not.toContain("fallback-complete-id");
    expect(container?.querySelector("[title]")).toBeNull();
    await expectNoSeriousAxeViolations();
  });

  it("covers every integration browse view and each product drill-down", async () => {
    const product = {
      id: "product-full-id-for-drills",
      source_id: "provider-product-full-id-for-drills",
      title: "Product with every drill-down",
      price_cents: 259900,
      currency: "INR",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-16T06:30:00.000Z",
    };
    mocks.listProducts.mockResolvedValue({ data: page([product]) });
    mocks.listProductVariants.mockResolvedValue({
      data: page([
        {
          id: "variant-full-id-for-drills",
          product_id: product.id,
          source_id: "provider-variant-full-id",
          sku: "SKU-COMPLETE",
          title: "Large / Indigo",
          option_values: { size: "Large", color: "Indigo" },
          price_cents: 259900,
          compare_at_price_cents: 289900,
          currency: "INR",
          inventory_quantity: 4,
          inventory_policy: "deny",
          available: true,
        },
      ]),
    });
    mocks.listInventorySnapshots.mockResolvedValue({
      data: page([
        {
          id: "snapshot-full-id-for-drills",
          product_id: product.id,
          variant_id: "variant-full-id-for-drills",
          quantity: 4,
          available: true,
          inventory_policy: "deny",
          observed_at: "2026-07-16T06:30:00.000Z",
          source_event_id: "inventory-event-full-id",
          metadata: {},
        },
      ]),
    });
    mocks.listPriceHistory.mockResolvedValue({
      data: page([
        {
          id: "price-point-full-id-for-drills",
          product_id: product.id,
          variant_id: "variant-full-id-for-drills",
          price_cents: 259900,
          compare_at_price_cents: 289900,
          currency: "INR",
          observed_at: "2026-07-16T06:30:00.000Z",
          source_event_id: "price-event-full-id",
          metadata: {},
        },
      ]),
    });
    mocks.listOrders.mockResolvedValue({
      data: page([
        {
          id: "order-full-id-for-drills",
          source_id: "provider-order-full-id",
          customer_email: "buyer@example.com",
          status: "paid",
          subtotal_cents: 250000,
          discount_cents: 10000,
          shipping_cents: 15000,
          tax_cents: 4900,
          total_cents: 259900,
          currency: "INR",
          campaign_id: "campaign-attribution-full-id",
          attribution: {},
          line_items: [],
          ordered_at: "2026-07-16T06:30:00.000Z",
          created_at: "2026-07-16T06:30:00.000Z",
          updated_at: "2026-07-16T06:30:00.000Z",
        },
      ]),
    });
    mocks.listEvents.mockResolvedValue({
      data: page([
        {
          id: 987654,
          event_type: "orders/paid",
          customer_email: "buyer@example.com",
          order_id: "order-full-id-for-drills",
          provider_event_id: "provider-event-full-id",
          provider_topic: "orders/paid",
          metadata: {},
          at: "2026-07-16T06:30:00.000Z",
        },
      ]),
    });
    render(
      <IntegrationsTab
        integrations={[integration]}
        err={null}
        canAdmin
        onReload={vi.fn().mockResolvedValue(undefined)}
        administrationIntent={null}
        onAdministrationIntentResolved={vi.fn()}
      />,
    );
    act(() => button("Browse data").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Customers"),
    );
    act(() => button("Products").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(product.id),
    );

    act(() => button("Variants").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("variant-full-id-for-drills"),
    );
    expect(document.body.textContent).toContain("color: Indigo");
    expect(document.body.textContent).not.toContain('"color":"Indigo"');
    act(() => button("Close").click());

    act(() => button("Inventory").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "snapshot-full-id-for-drills",
      ),
    );
    expect(document.body.textContent).toContain("inventory-event-full-id");
    act(() => button("Close").click());

    act(() => button("Prices").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "price-point-full-id-for-drills",
      ),
    );
    expect(document.body.textContent).toContain("price-event-full-id");
    act(() => button("Close").click());

    act(() => button("Orders").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("provider-order-full-id"),
    );
    expect(document.body.textContent).toContain("campaign-attribution-full-id");

    act(() => button("Events").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("provider-event-full-id"),
    );
    expect(document.body.textContent).toContain("Event ID: 987654");
    expect(container?.querySelector("[title]")).toBeNull();
  });

  it("validates and submits each recovery creation path without duplicate writes", async () => {
    render(
      <RecoveryTab
        integrations={[integration]}
        integrationsErr={null}
        canAdmin
      />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("recovery-link-complete-id"),
    );

    act(() => button("+ New link").click());
    const cartId = document.querySelector<HTMLInputElement>(
      'input[placeholder="cart_123"]',
    );
    const recoveryUrl = document.querySelector<HTMLInputElement>(
      'input[placeholder^="https://store.example.com/cart"]',
    );
    if (!cartId || !recoveryUrl) throw new Error("Missing cart link fields");
    change(cartId, "cart-new-complete-id");
    change(recoveryUrl, "http://store.example/cart?token=unsafe");
    act(() => button("Save link").click());
    await waitFor(() => {
      expect(mocks.upsertCartRecoveryLink).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("valid HTTPS recovery URL");
      expect(button("Save link")).toBeTruthy();
    });
    change(recoveryUrl, "https://store.example/cart?token=safe");
    act(() => {
      const save = button("Save link");
      save.click();
      save.click();
    });
    await waitFor(() => {
      expect(mocks.upsertCartRecoveryLink).toHaveBeenCalledTimes(1);
      expect(mocks.upsertCartRecoveryLink).toHaveBeenCalledWith(
        integration.id,
        {
          source_cart_id: "cart-new-complete-id",
          recovery_url: "https://store.example/cart?token=safe",
        },
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    const stockTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((candidate) => candidate.textContent?.includes("Back in stock"));
    if (!stockTab) throw new Error("Missing Back in stock recovery tab");
    act(() => stockTab.click());
    act(() => button("+ New subscription").click());
    const stockProduct = document.querySelector<HTMLInputElement>(
      'input[placeholder="prd_…"]',
    );
    const stockEmail = document.querySelector<HTMLInputElement>(
      'input[placeholder="customer@example.com"]',
    );
    const stockVariant = document.querySelector<HTMLInputElement>(
      'input[placeholder="var_…"]',
    );
    if (!stockProduct || !stockEmail || !stockVariant) {
      throw new Error("Missing stock subscription fields");
    }
    change(stockProduct, "product-stock-complete-id");
    change(stockEmail, "stock@example.com");
    change(stockVariant, "variant-stock-complete-id");
    act(() => button("Create subscription").click());
    await waitFor(() => {
      expect(mocks.createBackInStockSubscription).toHaveBeenCalledWith(
        integration.id,
        "product-stock-complete-id",
        {
          subscriber_email: "stock@example.com",
          variant_id: "variant-stock-complete-id",
        },
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    const priceTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((candidate) => candidate.textContent?.includes("Price drops"));
    if (!priceTab) throw new Error("Missing Price drops recovery tab");
    act(() => priceTab.click());
    act(() => button("+ New watcher").click());
    const watcherProduct = document.querySelector<HTMLInputElement>(
      'input[placeholder="prd_…"]',
    );
    const watcherEmail = document.querySelector<HTMLInputElement>(
      'input[placeholder="customer@example.com"]',
    );
    const target = document.querySelector<HTMLInputElement>(
      'input[placeholder="39.00"]',
    );
    if (!watcherProduct || !watcherEmail || !target) {
      throw new Error("Missing price watcher fields");
    }
    change(watcherProduct, "product-price-complete-id");
    change(watcherEmail, "price@example.com");
    change(target, "39");
    // happy-dom misclassifies decimal-step number inputs as invalid. Dispatch
    // submit directly so this component test exercises our validation and
    // payload contract; the browser evidence suite covers native form submit.
    act(() => {
      target.form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBe(
      null,
    );
    await waitFor(() => {
      expect(mocks.createPriceDropWatcher).toHaveBeenCalledWith(
        integration.id,
        "product-price-complete-id",
        {
          subscriber_email: "price@example.com",
          target_price_cents: 3900,
          currency: "USD",
        },
      );
    });
  });

  it("requires explicit replacement confirmation and creates a fully specified feed", async () => {
    render(<CatalogsTab canAdmin />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(catalog.id),
    );
    act(() => button("Import products").click());
    const payload = document.querySelector<HTMLTextAreaElement>("textarea");
    const replace = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!payload || !replace) throw new Error("Missing import controls");
    change(
      payload,
      '[{"source_id":"product-1","title":"Mug","price_cents":1900,"currency":"USD"}]',
    );
    act(() => replace.click());
    act(() => button("Review replacement import").click());
    expect(mocks.importCatalogProducts).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Replace products in");
    act(() => button("Import and replace").click());
    await waitFor(() => {
      expect(mocks.importCatalogProducts).toHaveBeenCalledTimes(1);
      expect(mocks.importCatalogProducts).toHaveBeenCalledWith(catalog.id, {
        products: [
          {
            source_id: "product-1",
            title: "Mug",
            price_cents: 1900,
            currency: "USD",
          },
        ],
        replace: true,
      });
    });

    act(() => button("Feeds").click());
    await waitFor(() => expect(document.body.textContent).toContain(feed.id));
    act(() => button("+ New feed").click());
    const feedName = document.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Best sellers"]',
    );
    const feedType = Array.from(
      document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select'),
    )[0];
    const maxItems = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="number"]',
    );
    if (!feedName || !feedType || !maxItems) {
      throw new Error("Missing feed creation fields");
    }
    change(feedName, "Five-year new arrivals");
    choose(feedType, "dynamic");
    change(maxItems, "12");
    act(() => button("Create draft feed").click());
    await waitFor(() => {
      expect(mocks.createProductFeed).toHaveBeenCalledWith(catalog.id, {
        name: "Five-year new arrivals",
        feed_type: "dynamic",
        max_items: 12,
        exclude_out_of_stock: true,
      });
    });
  });

  it("keeps a resolver preview truthfully tied to the last submitted email", async () => {
    render(<CatalogsTab canAdmin />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(catalog.id),
    );
    act(() => button("Feeds").click());
    await waitFor(() => expect(document.body.textContent).toContain(feed.id));
    act(() => button("Resolve preview").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Complete resolved product title",
      );
    });
    const email = document.querySelector<HTMLInputElement>(
      'input[type="email"]',
    );
    if (!email) throw new Error("Missing resolver email");
    change(email, "another@example.com");
    expect(document.body.textContent).toContain(
      "the table still represents the previous request",
    );
    const dialogResolve = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] form button[type="submit"]',
    );
    if (!dialogResolve) throw new Error("Missing dialog resolve action");
    await act(async () => {
      dialogResolve.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.resolveProductFeed).toHaveBeenLastCalledWith(
        catalog.id,
        feed.id,
        { subscriber_email: "another@example.com" },
      );
      expect(document.body.textContent).toContain(
        "product-complete-id-123456789",
      );
    });
    expect(document.body.textContent).toContain("provider-variant-complete-id");
    expect(document.body.textContent).toContain(
      "Highest verified revenue in the selected catalog window",
    );
    expect(container?.querySelector("[title]")).toBeNull();
  });

  it("contains catalog read failures, never exposes thrown detail, and single-flights retry", async () => {
    mocks.listCatalogs
      .mockImplementationOnce(() => {
        throw new Error("private database route must not leak");
      })
      .mockResolvedValueOnce({ data: page([catalog]) });
    render(<CatalogsTab canAdmin />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service could not be reached. Check the connection and retry.",
      );
    });
    expect(document.body.textContent).not.toContain("private database route");
    const retry = button("Retry catalogs");
    act(() => {
      retry.click();
      retry.click();
    });
    await waitFor(() => {
      expect(mocks.listCatalogs).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(catalog.id);
    });
  });

  it("single-flights catalog creation and keeps the busy action focusable", async () => {
    let finish!: (value: unknown) => void;
    mocks.createCatalog.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<CatalogsTab canAdmin integrations={[integration]} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(catalog.id),
    );
    act(() => button("+ New catalog").click());
    const name = document.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Spring collection"]',
    );
    if (!name) throw new Error("Missing catalog name");
    change(name, "Five-year mature catalog");
    const create = button("Create catalog");
    act(() => {
      create.click();
      create.click();
    });
    await waitFor(() => {
      expect(mocks.createCatalog).toHaveBeenCalledTimes(1);
      expect(button("Creating…").disabled).toBe(false);
      expect(button("Creating…").getAttribute("aria-disabled")).toBe("true");
    });
    await act(async () => {
      finish({ data: catalog });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("advances catalogs with the exact opaque cursor, retains Previous history, and stops repeated cursors", async () => {
    const secondCatalog = {
      ...catalog,
      id: "catalog-on-cursor-page-two",
      name: "Cursor page two",
    };
    mocks.listCatalogs.mockImplementation(({ cursor }: { cursor?: string }) =>
      Promise.resolve({
        data:
          cursor === "opaque/cursor+two=="
            ? page([secondCatalog], "opaque/cursor+two==")
            : page([catalog], "opaque/cursor+two=="),
      }),
    );

    render(<CatalogsTab canAdmin={false} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(catalog.id);
      expect(mocks.listCatalogs).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 25,
      });
    });

    act(() => button("Next →").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(secondCatalog.id);
      expect(mocks.listCatalogs).toHaveBeenLastCalledWith({
        cursor: "opaque/cursor+two==",
        limit: 25,
      });
    });
    expect(button("Next →").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("Last page of catalogs");

    act(() => button("← Previous").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(catalog.id);
      expect(mocks.listCatalogs).toHaveBeenCalledTimes(3);
      expect(mocks.listCatalogs).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 25,
      });
    });
  });

  it("keeps pager boundaries focusable, explained, and same-tick guarded", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <Pager
        itemCount={25}
        pageNumber={1}
        hasPrevious={false}
        nextCursor="opaque-next-cursor"
        onPrevious={onPrevious}
        onNext={onNext}
        label="Products"
      />,
    );
    const previous = button("← Previous");
    expect(previous.disabled).toBe(false);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("First page of products");
    act(() => {
      previous.click();
      const next = button("Next →");
      next.click();
      next.click();
    });
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith("opaque-next-cursor");
    expect(document.body.textContent).not.toContain("NaN");
    await expectNoSeriousAxeViolations();
  });
});
