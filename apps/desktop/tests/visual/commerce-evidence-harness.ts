import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const FIXED_TIME = "2026-07-29T12:00:00.000Z";
export const COMMERCE_HERO_TITLE =
  "Commerce — Turn storefront signals into timely customer moments.";
export const PRIMARY_INTEGRATION_ID = "integration-northstar";
export const SECONDARY_INTEGRATION_ID = "integration-fieldnotes";
export const PRIMARY_STORE = "northstar.example";
export const PRIMARY_CATALOG_ID = "catalog-summer-launch";
export const PRIMARY_CATALOG_NAME = "Summer launch catalog";
export const PRIMARY_FEED_ID = "feed-recent-arrivals";
export const PRIMARY_FEED_NAME = "Recent arrivals";
export const PRIMARY_PRODUCT_ID = "product-linen-overshirt";
export const PRIMARY_PRODUCT_TITLE = "Linen overshirt";
export const CUSTOMER_CURSOR = "customer-page-two:opaque";
export const RECOVERY_SECRET_PATH = "/recover/cart-private-canary";
export const RECOVERY_SECRET_TOKEN = "recovery-token-private-canary";
export const RECOVERY_EMAIL = "recovery-private@customer.example";
export const FEED_SECRET_PATH = "/merchant-feed/private.xml";
export const FEED_SECRET_TOKEN = "feed-token-private-canary";

export type Theme = "dark" | "light";
export type BootApp = (page: Page) => Promise<void>;
export type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

export interface CommerceRequestEvidence {
  method: string;
  pathname: string;
  search: string;
  body: string | null;
}

export interface CommerceHarness {
  requests: CommerceRequestEvidence[];
  unexpected: CommerceRequestEvidence[];
}

const INTEGRATIONS = [
  {
    id: PRIMARY_INTEGRATION_ID,
    provider: "shopify",
    shop_domain: PRIMARY_STORE,
    status: "active",
    scopes: ["read_customers", "read_products", "read_orders"],
    settings: {},
    sync_state: {
      cursor_kind: "shopify",
      last_status: "completed",
      complete: true,
    },
    last_sync_at: "2026-07-29T11:45:00.000Z",
    created_at: "2026-05-01T09:00:00.000Z",
    updated_at: "2026-07-29T11:45:00.000Z",
  },
  {
    id: SECONDARY_INTEGRATION_ID,
    provider: "woocommerce",
    shop_domain: "fieldnotes.example",
    status: "paused",
    scopes: ["customers", "products", "orders"],
    settings: {},
    sync_state: {
      cursor_kind: "woocommerce",
      last_status: "retrying",
      last_error: "Provider backfill needs operator review.",
      complete: false,
    },
    last_sync_at: "2026-07-27T08:30:00.000Z",
    error_message: "Recorded provider sync needs review.",
    created_at: "2026-05-14T10:00:00.000Z",
    updated_at: "2026-07-27T08:30:00.000Z",
  },
] as const;

const PROVIDERS = {
  items: [
    {
      provider: "shopify",
      name: "Shopify",
      category: "commerce",
      auth_mode: "oauth",
      managed: true,
      runtime_status: "partial",
      sync_model: "provider_pull",
      verification_mode: "oauth_state",
      capabilities: ["customers", "products", "orders", "webhooks"],
      required_settings: [
        {
          key: "shop_domain",
          label: "Shop domain",
          required: true,
          help: "Your store's myshopify.com domain.",
        },
      ],
      optional_settings: [],
      scopes: ["read_customers", "read_products", "read_orders"],
      webhook_topics: ["orders/create", "carts/update"],
      sync_objects: ["customers", "products", "orders"],
      docs_url: "https://shopify.dev/docs",
    },
    {
      provider: "woocommerce",
      name: "WooCommerce",
      category: "commerce",
      auth_mode: "api_key_ref",
      managed: false,
      runtime_status: "partial",
      sync_model: "postwave_commerce_ingest",
      verification_mode: "credential_reference",
      capabilities: ["customers", "products", "orders"],
      required_settings: [
        {
          key: "credential_ref",
          label: "Credential reference",
          required: true,
          secret: true,
          help: "Reference to a credential stored in the workspace vault.",
        },
      ],
      optional_settings: [],
      scopes: ["customers", "products", "orders"],
      webhook_topics: [],
      sync_objects: ["customers", "products", "orders"],
      docs_url: "https://woocommerce.com/documentation/",
    },
  ],
} as const;

const CUSTOMER_PAGE_ONE = {
  items: [
    {
      id: "customer-postwave-001",
      source_id: "shopify-customer-001",
      email: "maya.private@customer.example",
      first_name: "Maya",
      last_name: "Rivera",
      accepts_marketing: true,
      tags: ["studio", "returning"],
      created_at: "2026-04-04T09:00:00.000Z",
      updated_at: "2026-07-29T11:20:00.000Z",
    },
  ],
  next_cursor: CUSTOMER_CURSOR,
} as const;

const CUSTOMER_PAGE_TWO = {
  items: [
    {
      id: "customer-postwave-002",
      source_id: "shopify-customer-002",
      email: "noah.private@customer.example",
      first_name: "Noah",
      last_name: "Chen",
      accepts_marketing: false,
      tags: ["new"],
      created_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-29T10:50:00.000Z",
    },
  ],
} as const;

const PRODUCTS = {
  items: [
    {
      id: PRIMARY_PRODUCT_ID,
      source_id: "gid://shopify/Product/101",
      title: PRIMARY_PRODUCT_TITLE,
      url: "https://northstar.example/products/linen-overshirt",
      image_url: "https://northstar.example/media/linen-overshirt.jpg",
      price_cents: 12900,
      currency: "USD",
      created_at: "2026-05-02T09:00:00.000Z",
      updated_at: "2026-07-29T10:30:00.000Z",
    },
  ],
} as const;

const CATALOGS = {
  items: [
    {
      id: PRIMARY_CATALOG_ID,
      integration_id: PRIMARY_INTEGRATION_ID,
      name: PRIMARY_CATALOG_NAME,
      source_type: "integration",
      feed_url: `https://feeds.northstar.example${FEED_SECRET_PATH}?token=${FEED_SECRET_TOKEN}`,
      status: "active",
      locale: "en-US",
      default_currency: "USD",
      settings: {},
      last_sync_at: "2026-07-29T11:15:00.000Z",
      created_at: "2026-06-01T09:00:00.000Z",
      updated_at: "2026-07-29T11:15:00.000Z",
    },
  ],
} as const;

const FEEDS = {
  items: [
    {
      id: PRIMARY_FEED_ID,
      catalog_id: PRIMARY_CATALOG_ID,
      name: PRIMARY_FEED_NAME,
      feed_type: "recent",
      status: "draft",
      criteria: {
        collection: "private-summer-canary",
        audience_hint: "private-audience-canary",
      },
      fallback: { product_id: "private-fallback-canary" },
      max_items: 6,
      exclude_out_of_stock: true,
      created_at: "2026-07-28T09:00:00.000Z",
      updated_at: "2026-07-29T10:00:00.000Z",
    },
  ],
} as const;

const RECOVERY_URL = `https://checkout.northstar.example${RECOVERY_SECRET_PATH}?token=${RECOVERY_SECRET_TOKEN}`;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function requestEvidence(route: Route): CommerceRequestEvidence {
  const request = route.request();
  const url = new URL(request.url());
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    body: request.postData(),
  };
}

function integrationDataPath(pathname: string): {
  integrationId: string;
  dataset: string;
} | null {
  const match = pathname.match(
    /^\/api\/v1\/commerce\/integrations\/([^/]+)\/(customers|products|orders|events|analytics)$/u,
  );
  if (!match) return null;
  return {
    integrationId: decodeURIComponent(match[1]!),
    dataset: match[2]!,
  };
}

export async function installCommerceHarness(
  page: Page,
): Promise<CommerceHarness> {
  const harness: CommerceHarness = { requests: [], unexpected: [] };

  await page.route("**/api/v1/dashboard/layout", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    // The shell resolves this unrelated preference before Commerce is
    // selected. A complete order prevents a fixture-only Dashboard fallback
    // toast from contaminating screenshots and accessibility evidence.
    await json(route, {
      userId: "visual-user",
      tenantId: "test-tenant",
      order: [
        "subs",
        "opens",
        "clicks",
        "bounces",
        "forecast",
        "anomalies",
        "goals",
        "benchmarks",
        "engagement",
        "parity",
        "inbox-health",
        "clv",
      ],
      updatedAt: FIXED_TIME,
    });
  });

  // The shared optimized-build fixture owns `**/api/**`. During an explicitly
  // requested source-mode audit, Vite module URLs such as
  // `/src/lib/api/commerce.ts` also match that broad pattern. Continue source
  // modules directly so the API fixture cannot replace JavaScript with JSON.
  // Optimized qualification builds never request `/src/**`, so this guard is a
  // no-op in the canonical release evidence path.
  await page.route("**/src/**", async (route) => route.continue());

  await page.route("**/api/v1/commerce/**", async (route) => {
    const evidence = requestEvidence(route);
    const { method, pathname } = evidence;
    const url = new URL(route.request().url());
    harness.requests.push(evidence);

    if (pathname === "/api/v1/commerce/integrations" && method === "GET") {
      await json(route, INTEGRATIONS);
      return;
    }
    if (pathname === "/api/v1/commerce/providers" && method === "GET") {
      await json(route, PROVIDERS);
      return;
    }

    const integrationData = integrationDataPath(pathname);
    if (
      integrationData &&
      integrationData.integrationId === PRIMARY_INTEGRATION_ID &&
      method === "GET"
    ) {
      if (integrationData.dataset === "analytics") {
        await json(route, {
          customers: 2482,
          products: 164,
          orders: 392,
          revenue_cents: 18745000,
          average_order_cents: 47819,
          currency: "USD",
          orders_by_status: { paid: 361, refunded: 12, pending: 19 },
          last_order_at: "2026-07-29T11:32:00.000Z",
        });
        return;
      }
      if (integrationData.dataset === "customers") {
        await json(
          route,
          url.searchParams.get("cursor") === CUSTOMER_CURSOR
            ? CUSTOMER_PAGE_TWO
            : CUSTOMER_PAGE_ONE,
        );
        return;
      }
      if (integrationData.dataset === "products") {
        await json(route, PRODUCTS);
        return;
      }
      if (integrationData.dataset === "orders") {
        await json(route, {
          items: [
            {
              id: "order-postwave-001",
              source_id: "shopify-order-2401",
              customer_email: "Customer recorded",
              status: "paid",
              subtotal_cents: 12900,
              discount_cents: 0,
              shipping_cents: 900,
              tax_cents: 1104,
              total_cents: 14904,
              currency: "USD",
              campaign_id: "campaign-summer-launch",
              attribution: {},
              line_items: [],
              ordered_at: "2026-07-29T11:32:00.000Z",
              created_at: "2026-07-29T11:32:00.000Z",
              updated_at: "2026-07-29T11:32:00.000Z",
            },
          ],
        });
        return;
      }
      await json(route, {
        items: [
          {
            id: 101,
            event_type: "Order created",
            customer_email: "Customer recorded",
            order_id: "order-postwave-001",
            provider_event_id: "provider-event-101",
            provider_topic: "orders/create",
            metadata: {},
            at: "2026-07-29T11:32:00.000Z",
          },
        ],
      });
      return;
    }

    const productDrill = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)\/products\/([^/]+)\/(variants|inventory|price-history)$/u,
    );
    if (
      productDrill &&
      decodeURIComponent(productDrill[1]!) === PRIMARY_INTEGRATION_ID &&
      decodeURIComponent(productDrill[2]!) === PRIMARY_PRODUCT_ID &&
      method === "GET"
    ) {
      const drill = productDrill[3]!;
      if (drill === "variants") {
        await json(route, {
          items: [
            {
              id: "variant-sand-medium",
              product_id: PRIMARY_PRODUCT_ID,
              source_id: "gid://shopify/ProductVariant/1011",
              sku: "LINEN-SAND-M",
              title: "Sand / Medium",
              option_values: { color: "Sand", size: "Medium" },
              price_cents: 12900,
              compare_at_price_cents: 14900,
              currency: "USD",
              inventory_quantity: 18,
              inventory_policy: "deny",
              available: true,
            },
          ],
        });
        return;
      }
      if (drill === "inventory") {
        await json(route, {
          items: [
            {
              id: "inventory-snapshot-101",
              product_id: PRIMARY_PRODUCT_ID,
              variant_id: "variant-sand-medium",
              quantity: 18,
              available: true,
              inventory_policy: "deny",
              observed_at: "2026-07-29T11:00:00.000Z",
              source_event_id: "inventory-event-101",
              metadata: {},
            },
          ],
        });
        return;
      }
      await json(route, {
        items: [
          {
            id: "price-point-101",
            product_id: PRIMARY_PRODUCT_ID,
            variant_id: "variant-sand-medium",
            price_cents: 12900,
            compare_at_price_cents: 14900,
            currency: "USD",
            observed_at: "2026-07-29T11:00:00.000Z",
            source_event_id: "price-event-101",
            metadata: {},
          },
        ],
      });
      return;
    }

    if (pathname === "/api/v1/commerce/catalogs" && method === "GET") {
      await json(route, CATALOGS);
      return;
    }
    if (pathname === "/api/v1/commerce/catalogs" && method === "POST") {
      await json(route, CATALOGS.items[0], 201);
      return;
    }

    const feedsPath = pathname.match(
      /^\/api\/v1\/commerce\/catalogs\/([^/]+)\/feeds$/u,
    );
    if (feedsPath && decodeURIComponent(feedsPath[1]!) === PRIMARY_CATALOG_ID) {
      if (method === "GET") await json(route, FEEDS);
      else if (method === "POST") await json(route, FEEDS.items[0], 201);
      else {
        harness.unexpected.push(evidence);
        await json(route, { error: { message: "Method not allowed" } }, 405);
      }
      return;
    }

    const resolvePath = pathname.match(
      /^\/api\/v1\/commerce\/catalogs\/([^/]+)\/feeds\/([^/]+)\/resolve$/u,
    );
    if (
      resolvePath &&
      decodeURIComponent(resolvePath[1]!) === PRIMARY_CATALOG_ID &&
      decodeURIComponent(resolvePath[2]!) === PRIMARY_FEED_ID &&
      method === "POST"
    ) {
      await json(route, {
        feed_id: PRIMARY_FEED_ID,
        catalog_id: PRIMARY_CATALOG_ID,
        feed_type: "recent",
        exclude_out_of_stock: true,
        total: 1,
        page: 1,
        per_page: 1,
        items: [
          {
            product_id: PRIMARY_PRODUCT_ID,
            variant_id: "variant-sand-medium",
            source_id: "gid://shopify/Product/101",
            variant_source_id: "gid://shopify/ProductVariant/1011",
            title: PRIMARY_PRODUCT_TITLE,
            price_cents: 12900,
            compare_at_price_cents: 14900,
            currency: "USD",
            available: true,
            reason: "Most recently updated eligible product",
            rank: 1,
            metadata: {},
          },
        ],
      });
      return;
    }

    const catalogImportPath = pathname.match(
      /^\/api\/v1\/commerce\/catalogs\/([^/]+)\/import$/u,
    );
    if (
      catalogImportPath &&
      decodeURIComponent(catalogImportPath[1]!) === PRIMARY_CATALOG_ID &&
      method === "POST"
    ) {
      await json(route, {
        catalog_id: PRIMARY_CATALOG_ID,
        integration_id: PRIMARY_INTEGRATION_ID,
        products_seen: 1,
        products_upserted: 1,
        catalog_items_upserted: 1,
        products_skipped: 0,
        imported_at: FIXED_TIME,
      });
      return;
    }

    const recoveryList = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)\/(cart-recovery-links|back-in-stock-subscriptions|price-drop-watchers)$/u,
    );
    if (
      recoveryList &&
      decodeURIComponent(recoveryList[1]!) === PRIMARY_INTEGRATION_ID &&
      method === "GET"
    ) {
      const dataset = recoveryList[2]!;
      if (dataset === "cart-recovery-links") {
        await json(route, {
          items: [
            {
              id: "recovery-link-101",
              integration_id: PRIMARY_INTEGRATION_ID,
              cart_order_id: "cart-order-101",
              source_cart_id: "source-cart-101",
              customer_email: RECOVERY_EMAIL,
              recovery_url: RECOVERY_URL,
              status: "active",
              expires_at: "2026-08-05T12:00:00.000Z",
              metadata: {},
              created_at: "2026-07-29T10:00:00.000Z",
              updated_at: "2026-07-29T11:00:00.000Z",
            },
          ],
        });
        return;
      }
      if (dataset === "back-in-stock-subscriptions") {
        await json(route, {
          items: [
            {
              id: "back-in-stock-101",
              integration_id: PRIMARY_INTEGRATION_ID,
              product_id: PRIMARY_PRODUCT_ID,
              variant_id: "variant-sand-medium",
              subscriber_id: "subscriber-101",
              subscriber_email: "stock-private@customer.example",
              status: "waiting",
              requested_at: "2026-07-28T09:00:00.000Z",
              expires_at: "2026-08-28T09:00:00.000Z",
              metadata: {},
              created_at: "2026-07-28T09:00:00.000Z",
              updated_at: "2026-07-29T10:00:00.000Z",
            },
          ],
        });
        return;
      }
      await json(route, {
        items: [
          {
            id: "price-watch-101",
            integration_id: PRIMARY_INTEGRATION_ID,
            product_id: PRIMARY_PRODUCT_ID,
            variant_id: "variant-sand-medium",
            subscriber_id: "subscriber-102",
            subscriber_email: "price-private@customer.example",
            original_price_cents: 14900,
            target_price_cents: 12900,
            min_drop_percent: 10,
            currency: "USD",
            status: "eligible",
            watched_at: "2026-07-27T09:00:00.000Z",
            eligible_at: "2026-07-29T10:00:00.000Z",
            expires_at: "2026-08-27T09:00:00.000Z",
            metadata: {},
            created_at: "2026-07-27T09:00:00.000Z",
            updated_at: "2026-07-29T10:00:00.000Z",
          },
        ],
      });
      return;
    }

    const recoveryWrite = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)\/(?:cart-recovery-links|products\/[^/]+\/(?:back-in-stock-subscriptions|price-drop-watchers))$/u,
    );
    if (
      recoveryWrite &&
      decodeURIComponent(recoveryWrite[1]!) === PRIMARY_INTEGRATION_ID &&
      method === "POST"
    ) {
      await json(route, { ok: true }, 201);
      return;
    }

    const lifecycleReport = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)\/lifecycle\/report$/u,
    );
    if (lifecycleReport && method === "GET") {
      const integrationId = decodeURIComponent(lifecycleReport[1]!);
      const primary = integrationId === PRIMARY_INTEGRATION_ID;
      await json(route, {
        integration_id: integrationId,
        generated_at: FIXED_TIME,
        cart_recovery: {
          total: primary ? 34 : 7,
          by_status: primary
            ? { active: 14, converted: 20 }
            : { active: 3, converted: 4 },
        },
        back_in_stock: {
          total: primary ? 18 : 4,
          by_status: primary
            ? { waiting: 11, eligible: 7 }
            : { waiting: 2, eligible: 2 },
        },
        price_drop: {
          total: primary ? 12 : 3,
          by_status: primary
            ? { watching: 8, eligible: 4 }
            : { watching: 2, eligible: 1 },
        },
        events_last_30_days: {
          cart_abandoned: 42,
          inventory_restocked: 9,
          product_price_changed: 16,
        },
        eligible_last_30_days: 23,
        notified_pending: 11,
      });
      return;
    }

    const lifecycleEvaluate = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)\/lifecycle\/evaluate$/u,
    );
    if (lifecycleEvaluate && method === "POST") {
      await json(route, {
        back_in_stock_eligible: 7,
        price_drop_eligible: 4,
        evaluated_at: FIXED_TIME,
      });
      return;
    }

    const storeMutation = pathname.match(
      /^\/api\/v1\/commerce\/integrations\/([^/]+)(?:\/(?:sync|pause))?$/u,
    );
    if (storeMutation && method !== "GET") {
      if (method === "DELETE") {
        await json(route, {
          ok: true,
          provider_cleanup: {
            provider: "shopify",
            status: "recorded",
            postwave_status: "disconnected",
            provider_cleanup_posture: "provider_console_review",
            managed_provider_cleanup: false,
            webhook_cleanup_status: "not_managed",
            credential_cleanup_status: "not_managed",
            postwave_effects: ["Local sync scheduling stopped"],
            provider_console_actions: [
              "Confirm webhook removal in the provider console",
            ],
            provider_cleanup_evidence: [
              "Local integration state changed to disconnected",
            ],
          },
        });
      } else if (pathname.endsWith("/sync")) {
        await json(route, {
          customers_upserted: 1,
          products_upserted: 1,
          orders_upserted: 1,
        });
      } else {
        await json(route, {
          ...INTEGRATIONS[0],
          status: "paused",
        });
      }
      return;
    }

    harness.unexpected.push(evidence);
    await json(
      route,
      {
        error: {
          code: "commerce_evidence_contract_violation",
          message: `Commerce evidence harness has no contract for ${method} ${pathname}.`,
        },
      },
      405,
    );
  });

  return harness;
}

export async function openCommerce(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    theme?: Theme;
    width?: number;
    height?: number;
  } = {},
): Promise<CommerceHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 1000,
  });
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await bootApp(page);
  const harness = await installCommerceHarness(page);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="commerce"]');
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: COMMERCE_HERO_TITLE, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".commerce-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connected stores", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Store integrations" }),
  ).toBeVisible();
  return harness;
}

export function countCommerceRequests(
  harness: CommerceHarness,
  pathname: string | RegExp,
  method?: string,
): number {
  return harness.requests.filter((request) => {
    const pathMatches =
      typeof pathname === "string"
        ? request.pathname === pathname
        : pathname.test(request.pathname);
    return pathMatches && (!method || request.method === method);
  }).length;
}

export async function waitForCommerceRequest(
  harness: CommerceHarness,
  predicate: (request: CommerceRequestEvidence) => boolean,
): Promise<CommerceRequestEvidence> {
  let match: CommerceRequestEvidence | null = null;
  await expect
    .poll(() => {
      match = [...harness.requests].reverse().find(predicate) ?? null;
      return match !== null;
    })
    .toBe(true);
  return match!;
}

export function observeRenderer(
  page: Page,
  allowedHttpStatuses: readonly number[] = [],
): { expectClean: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  return {
    expectClean: () => {
      const unexpected = consoleErrors.filter(
        (message) =>
          !allowedHttpStatuses.some((status) =>
            message.includes(`status of ${status}`),
          ),
      );
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

export async function seriousAxeViolations(
  page: Page,
  options: {
    rootSelector?: string;
    disableColorContrast?: boolean;
  } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ rootSelector, disableColorContrast }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              root: Element,
              options: {
                runOnly: { type: "tag"; values: string[] };
                rules?: Record<string, { enabled: boolean }>;
              },
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{ target: string[]; failureSummary?: string }>;
              }>;
            }>;
          };
        }
      ).axe;
      const selector = rootSelector ?? ".commerce-page";
      const root = document.querySelector(selector);
      if (!root) {
        throw new Error(`Commerce axe root was not rendered: ${selector}`);
      }
      const result = await axe.run(root, {
        runOnly: {
          type: "tag",
          values: [
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22a",
            "wcag22aa",
          ],
        },
        ...(disableColorContrast
          ? { rules: { "color-contrast": { enabled: false } } }
          : {}),
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "serious" || violation.impact === "critical",
        )
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failure: node.failureSummary,
          })),
        }));
    },
    {
      rootSelector: options.rootSelector,
      disableColorContrast: options.disableColorContrast,
    },
  );
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".commerce-page");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      route: route ? route.scrollWidth - route.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
}

export function expectCursorListContract(harness: CommerceHarness): void {
  const cursorLists = harness.requests.filter(
    ({ method, pathname }) =>
      method === "GET" &&
      (/^\/api\/v1\/commerce\/catalogs$/u.test(pathname) ||
        /^\/api\/v1\/commerce\/catalogs\/[^/]+\/feeds$/u.test(pathname) ||
        /^\/api\/v1\/commerce\/integrations\/[^/]+\/(?:customers|products|orders|events|cart-recovery-links|back-in-stock-subscriptions|price-drop-watchers)$/u.test(
          pathname,
        )),
  );
  expect(cursorLists.length).toBeGreaterThanOrEqual(1);
  for (const request of cursorLists) {
    const params = new URLSearchParams(request.search);
    expect(params.get("limit")).toBe("25");
    expect(params.has("page")).toBe(false);
    expect(params.has("per_page")).toBe(false);
    expect(params.has("offset")).toBe(false);
    expect(
      [...params.keys()].filter(
        (key) => !["limit", "cursor", "status"].includes(key),
      ),
    ).toEqual([]);
  }
  expect(harness.unexpected).toEqual([]);
}

export async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { resetScroll?: boolean } = {},
): Promise<void> {
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: false,
    }),
  ).toHaveCount(0);
  if (options.resetScroll !== false) {
    await page.evaluate(async () => {
      const main = document.querySelector<HTMLElement>(".main");
      const content = document.querySelector<HTMLElement>(".content");
      const reset = (): void => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
        content?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      };
      reset();
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      reset();
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      reset();
    });
  }
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

export async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}
