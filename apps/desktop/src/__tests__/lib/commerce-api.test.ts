import { describe, expect, it } from "vitest";

import {
  createCommerceApi,
  type CommerceCursorOptions,
} from "../../lib/api/commerce";
import type { ApiResult } from "../../lib/api/result";

type CommerceRequester = Parameters<typeof createCommerceApi>[0];
type CommerceRequestOptions = Parameters<CommerceRequester>[2];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: CommerceRequestOptions;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: CommerceRequester;
} {
  const calls: RequestCall[] = [];
  const request: CommerceRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: CommerceRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const COMMERCE_OPERATIONS = [
  "listProviders",
  "listIntegrations",
  "createIntegration",
  "getIntegration",
  "syncIntegration",
  "pauseIntegration",
  "disconnectIntegration",
  "startShopifyOAuth",
  "listCatalogs",
  "createCatalog",
  "importCatalogProducts",
  "listProductFeeds",
  "createProductFeed",
  "resolveProductFeed",
  "listCartRecoveryLinks",
  "upsertCartRecoveryLink",
  "listBackInStockSubscriptions",
  "createBackInStockSubscription",
  "listPriceDropWatchers",
  "createPriceDropWatcher",
  "evaluateLifecycle",
  "lifecycleReport",
  "listCustomers",
  "listProducts",
  "listProductVariants",
  "listInventorySnapshots",
  "listPriceHistory",
  "listOrders",
  "listEvents",
  "analytics",
] as const;

describe("createCommerceApi", () => {
  it("retains the complete 30-operation Commerce surface", () => {
    const { request } = recordingRequester();

    expect(Object.keys(createCommerceApi(request))).toEqual(
      COMMERCE_OPERATIONS,
    );
  });

  it("preserves encoded nested routes, bodies, paging, and execution policies", async () => {
    const { calls, request } = recordingRequester();
    const api = createCommerceApi(request);

    await api.syncIntegration("integration/one", { customers: [] });
    await api.importCatalogProducts("catalog/one", {
      products: [{ id: "product_1" }],
      replace: true,
    });
    await api.listCartRecoveryLinks("integration/one", {
      status: "ready & waiting",
      cursor: "cursor/next+one==",
      limit: 25,
    });
    await api.listProductVariants("integration/one", "product/one", {
      cursor: "variant cursor",
      limit: 10,
    });
    await api.createPriceDropWatcher("integration/one", "product/one", {
      subscriber_email: "reader@example.test",
      min_drop_percent: 20,
    });
    await api.evaluateLifecycle("integration/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/commerce/integrations/integration%2Fone/sync",
        init: { method: "POST", body: JSON.stringify({ customers: [] }) },
        opts: {
          timeoutMs: 60_000,
          maxAttempts: 1,
          requireOnline: true,
        },
      },
      {
        path: "/api/v1/commerce/catalogs/catalog%2Fone/import",
        init: {
          method: "POST",
          body: JSON.stringify({
            products: [{ id: "product_1" }],
            replace: true,
          }),
        },
        opts: { timeoutMs: 60_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/commerce/integrations/integration%2Fone/cart-recovery-links?status=ready+%26+waiting&limit=25&cursor=cursor%2Fnext%2Bone%3D%3D",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/commerce/integrations/integration%2Fone/products/product%2Fone/variants?limit=10&cursor=variant+cursor",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/commerce/integrations/integration%2Fone/products/product%2Fone/price-drop-watchers",
        init: {
          method: "POST",
          body: JSON.stringify({
            subscriber_email: "reader@example.test",
            min_drop_percent: 20,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/commerce/integrations/integration%2Fone/lifecycle/evaluate",
        init: { method: "POST", body: "{}" },
        opts: { timeoutMs: 30_000, maxAttempts: 1 },
      },
    ]);
  });

  it("composes every commerce data/read method at the original facade boundary", async () => {
    const { calls, request } = recordingRequester();
    const api = createCommerceApi(request);

    await api.listCustomers("integration/one", {
      cursor: "customer-cursor",
      limit: 5,
    });
    await api.listProducts("integration/one", {
      cursor: "product-cursor",
      limit: 5,
    });
    await api.listProductVariants("integration/one", "product/one", {
      cursor: "variant-cursor",
      limit: 5,
    });
    await api.listInventorySnapshots("integration/one", "product/one", {
      cursor: "inventory-cursor",
      limit: 5,
    });
    await api.listPriceHistory("integration/one", "product/one", {
      cursor: "price-cursor",
      limit: 5,
    });
    await api.listOrders("integration/one", {
      cursor: "order-cursor",
      limit: 5,
    });
    await api.listEvents("integration/one", {
      cursor: "event-cursor",
      limit: 5,
    });
    await api.analytics("integration/one");

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/commerce/integrations/integration%2Fone/customers?limit=5&cursor=customer-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/products?limit=5&cursor=product-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/products/product%2Fone/variants?limit=5&cursor=variant-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/products/product%2Fone/inventory?limit=5&cursor=inventory-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/products/product%2Fone/price-history?limit=5&cursor=price-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/orders?limit=5&cursor=order-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/events?limit=5&cursor=event-cursor",
      "/api/v1/commerce/integrations/integration%2Fone/analytics",
    ]);
    expect(calls.every((call) => call.init === undefined)).toBe(true);
    expect(calls.every((call) => call.opts === undefined)).toBe(true);
  });

  it("maps the legacy page-size alias to limit and never serializes numeric pages or NaN", async () => {
    const { calls, request } = recordingRequester();
    const api = createCommerceApi(request);
    const legacyOptions = {
      page: Number.NaN,
      perPage: 7,
    } as CommerceCursorOptions & { page: number };

    await api.listCustomers("integration/one", legacyOptions);
    await api.listCatalogs({ limit: Number.NaN, cursor: "opaque-cursor" });

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/commerce/integrations/integration%2Fone/customers?limit=7",
      "/api/v1/commerce/catalogs?cursor=opaque-cursor",
    ]);
    expect(calls.map((call) => call.path).join(" ")).not.toContain("page=");
    expect(calls.map((call) => call.path).join(" ")).not.toContain("NaN");
  });
});
