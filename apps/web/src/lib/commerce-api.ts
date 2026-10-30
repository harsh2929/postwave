// SPDX-License-Identifier: AGPL-3.0-only
import { api } from "./api";

export interface CommerceRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function liveOptions(
  options: CommerceRequestOptions = {},
  extra: { timeoutMs?: number } = {},
) {
  return {
    ...extra,
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

function verifiedCreatedRecord<T extends { id: string }>(
  value: unknown,
  label: string,
): T {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !(value as { id: string }).id.trim()
  ) {
    throw new Error(
      `The ${label} request may have completed, but the service did not return a verifiable record. Refresh before trying again.`,
    );
  }
  return value as T;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export interface CommercePageInfo {
  total: number;
  page: number;
  per_page: number;
}

export interface CommercePage<T> extends CommercePageInfo {
  items: T[];
}

export interface CommerceIntegrationSyncState {
  cursor_kind: string;
  mode?: string;
  object?: string;
  operation_id?: string;
  line_offset?: number;
  attempts?: number;
  next_attempt_at?: string;
  last_status?: string;
  last_error?: string;
  retry_due?: boolean;
  retry_wait_seconds?: number;
  complete?: boolean;
}

export interface CommerceIntegration {
  id: string;
  provider: string;
  shop_domain?: string;
  status: string;
  scopes: string[];
  settings: Record<string, unknown>;
  sync_cursor?: string;
  sync_state?: CommerceIntegrationSyncState | null;
  last_sync_at?: string | null;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceEventRow {
  id: number;
  event_type: string;
  customer_email?: string;
  order_id?: string;
  provider_event_id?: string;
  provider_topic?: string;
  metadata: Record<string, unknown>;
  at: string;
}

export type CommerceSyncTone = "success" | "warning" | "danger" | "neutral";

/**
 * Cursor page: what the catalog and feed list handlers really send
 * (`{items, next_cursor}` via pagination.ReadParamsWithDefault). The
 * `CommercePage` shape above (`total/page/per_page`) is the older offset
 * contract and is NOT what these endpoints answer with.
 */
export interface CommerceCursorPage<T> {
  items: T[];
  next_cursor?: string;
}

export interface CommerceCursorQuery {
  limit?: number;
  cursor?: string;
}

export interface CommerceCatalog {
  id: string;
  integration_id?: string;
  name: string;
  source_type: string;
  feed_url?: string;
  status: string;
  locale?: string;
  default_currency: string;
  settings?: Record<string, unknown>;
  last_sync_at?: string | null;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceCatalogInput {
  integration_id?: string;
  name: string;
  source_type: string;
  feed_url?: string;
  status?: string;
  locale?: string;
  default_currency?: string;
  settings?: Record<string, unknown>;
}

export interface CommerceCatalogImportInput {
  products: Array<Record<string, unknown>>;
  replace?: boolean;
}

/** The 202 summary the import handler answers with — rendered verbatim. */
export interface CommerceCatalogImportSummary {
  catalog_id: string;
  integration_id: string;
  products_seen: number;
  products_upserted: number;
  catalog_items_upserted: number;
  products_skipped: number;
  imported_at: string;
}

export interface CommerceProductFeed {
  id: string;
  catalog_id?: string;
  name: string;
  feed_type: string;
  status: string;
  criteria: Record<string, unknown>;
  fallback: Record<string, unknown>;
  max_items: number;
  exclude_out_of_stock: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommerceProductFeedInput {
  name: string;
  feed_type: string;
  status?: string;
  criteria?: Record<string, unknown>;
  fallback?: Record<string, unknown>;
  max_items?: number;
  exclude_out_of_stock?: boolean;
}

export interface CommerceFeedResolveInput {
  subscriber_email?: string;
  max_items?: number;
  exclude_out_of_stock?: boolean;
  context?: Record<string, unknown>;
}

export interface CommerceResolvedFeedItem {
  product_id: string;
  variant_id?: string;
  source_id: string;
  variant_source_id?: string;
  title: string;
  image_url?: string;
  url?: string;
  price_cents: number;
  compare_at_price_cents?: number | null;
  currency: string;
  available: boolean;
  reason?: string;
  rank: number;
  metadata?: Record<string, unknown>;
}

export interface CommerceResolvedFeed extends CommercePageInfo {
  feed_id: string;
  catalog_id?: string;
  feed_type: string;
  subscriber_email?: string;
  exclude_out_of_stock: boolean;
  items: CommerceResolvedFeedItem[];
}

export interface CommerceShopifyOAuthStart {
  provider: string;
  shop_domain: string;
  authorize_url: string;
  state: string;
  scopes: string[];
  local: boolean;
}

/* ---------- recovery & lifecycle (per-integration subscription records) ---------- */

/** Cursor page plus the optional `?status=` the three recovery lists accept. */
export interface CommerceStatusQuery extends CommerceCursorQuery {
  status?: string;
}

export interface CommerceCartRecoveryLink {
  id: string;
  integration_id?: string;
  cart_order_id?: string;
  source_cart_id: string;
  customer_email?: string;
  recovery_url: string;
  status: string;
  expires_at?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CommerceCartRecoveryLinkInput {
  cart_order_id?: string;
  source_cart_id: string;
  customer_email?: string;
  recovery_url: string;
  status?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface CommerceBackInStockSubscription {
  id: string;
  integration_id?: string;
  product_id: string;
  variant_id?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  status: string;
  requested_at: string;
  eligible_at?: string | null;
  notified_at?: string | null;
  expires_at?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CommerceBackInStockSubscriptionInput {
  variant_id?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface CommercePriceDropWatcher {
  id: string;
  integration_id?: string;
  product_id: string;
  variant_id?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  original_price_cents: number;
  target_price_cents?: number | null;
  min_drop_percent?: number | null;
  currency: string;
  status: string;
  watched_at: string;
  eligible_at?: string | null;
  notified_at?: string | null;
  expires_at?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CommercePriceDropWatcherInput {
  variant_id?: string;
  subscriber_id?: string;
  subscriber_email?: string;
  original_price_cents?: number;
  target_price_cents?: number;
  min_drop_percent?: number;
  currency?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface CommerceLifecycleStats {
  total: number;
  by_status: Record<string, number>;
}

/** GET …/lifecycle/report — stored subscription state, not delivery evidence. */
export interface CommerceLifecycleReport {
  integration_id: string;
  generated_at: string;
  cart_recovery: CommerceLifecycleStats;
  back_in_stock: CommerceLifecycleStats;
  price_drop: CommerceLifecycleStats;
  events_last_30_days: Record<string, number>;
  eligible_last_30_days: number;
  notified_pending: number;
}

/** POST …/lifecycle/evaluate — the counters the evaluator acknowledges with. */
export interface CommerceLifecycleEvaluation {
  back_in_stock_eligible: number;
  price_drop_eligible: number;
  evaluated_at: string;
}

/* ---------- store data: the records synced from one integration ---------- */
/* Shapes mirror internal/commerce/types.go (Customer, Product, ProductVariant,
 * InventorySnapshot, PriceHistoryPoint, Order, Analytics); the provider `raw`
 * payloads are omitted because no client surface renders them. */

export interface CommerceCustomer {
  id: string;
  source_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  accepts_marketing: boolean;
  /** `[]string` on the wire — a nil slice serializes as null, so read defensively. */
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface CommerceProduct {
  id: string;
  source_id: string;
  title: string;
  url?: string;
  image_url?: string;
  price_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceProductVariant {
  id: string;
  product_id: string;
  source_id: string;
  sku?: string;
  title?: string;
  option_values: Record<string, unknown> | null;
  price_cents: number;
  compare_at_price_cents?: number | null;
  currency: string;
  inventory_quantity?: number | null;
  inventory_policy: string;
  available: boolean;
  image_url?: string;
  url?: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceInventorySnapshot {
  id: string;
  product_id: string;
  variant_id?: string;
  quantity?: number | null;
  available: boolean;
  inventory_policy: string;
  observed_at: string;
  source_event_id?: string;
  metadata: Record<string, unknown> | null;
}

export interface CommercePriceHistoryPoint {
  id: string;
  product_id: string;
  variant_id?: string;
  price_cents: number;
  compare_at_price_cents?: number | null;
  currency: string;
  observed_at: string;
  source_event_id?: string;
  metadata: Record<string, unknown> | null;
}

export interface CommerceOrder {
  id: string;
  source_id: string;
  customer_email?: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  campaign_id?: string;
  attribution: Record<string, unknown> | null;
  line_items: Array<Record<string, unknown>> | null;
  ordered_at: string;
  created_at: string;
  updated_at: string;
}

/** GET …/analytics — an aggregate over the imported records, computed at
 *  request time. The response carries no reporting window or generation
 *  timestamp, so the client must not invent one. */
export interface CommerceAnalytics {
  customers: number;
  products: number;
  orders: number;
  revenue_cents: number;
  average_order_cents: number;
  currency: string;
  orders_by_status: Record<string, number> | null;
  last_order_at?: string | null;
}

function integrationPath(integrationId: string, suffix: string): string {
  return `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}${suffix}`;
}

function productPath(
  integrationId: string,
  productId: string,
  suffix: string,
): string {
  return integrationPath(
    integrationId,
    `/products/${encodeURIComponent(productId)}${suffix}`,
  );
}

export const commerceApi = {
  integrations: (): Promise<CommerceIntegration[]> =>
    api.get<CommerceIntegration[]>("/api/v1/commerce/integrations"),

  // The events endpoint is CURSOR-paginated: the handler reads `limit` and
  // `cursor` (pagination.ReadParamsWithDefault) and answers with
  // `{items, next_cursor}`. The client used to send `page`/`per_page`, which
  // the handler never looks at — so every caller silently got the default 50
  // rows no matter what cap it asked for. (It was also typed as the offset
  // envelope; the type now says what the handler sends.)
  events: (
    integrationId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceEventRow>> =>
    api.get<CommerceCursorPage<CommerceEventRow>>(
      integrationPath(integrationId, "/events"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/customers?limit=&cursor= (read:reports). */
  listCustomers: (
    integrationId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceCustomer>> =>
    api.get<CommerceCursorPage<CommerceCustomer>>(
      integrationPath(integrationId, "/customers"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/products?limit=&cursor= (read:reports). */
  listProducts: (
    integrationId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceProduct>> =>
    api.get<CommerceCursorPage<CommerceProduct>>(
      integrationPath(integrationId, "/products"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/orders?limit=&cursor= (read:reports). */
  listOrders: (
    integrationId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceOrder>> =>
    api.get<CommerceCursorPage<CommerceOrder>>(
      integrationPath(integrationId, "/orders"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/products/{product_id}/variants (read:reports). */
  listProductVariants: (
    integrationId: string,
    productId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceProductVariant>> =>
    api.get<CommerceCursorPage<CommerceProductVariant>>(
      productPath(integrationId, productId, "/variants"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/products/{product_id}/inventory (read:reports). */
  listInventorySnapshots: (
    integrationId: string,
    productId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceInventorySnapshot>> =>
    api.get<CommerceCursorPage<CommerceInventorySnapshot>>(
      productPath(integrationId, productId, "/inventory"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/products/{product_id}/price-history (read:reports). */
  listPriceHistory: (
    integrationId: string,
    productId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommercePriceHistoryPoint>> =>
    api.get<CommerceCursorPage<CommercePriceHistoryPoint>>(
      productPath(integrationId, productId, "/price-history"),
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** GET /api/v1/commerce/integrations/{id}/analytics (read:reports). */
  analytics: (integrationId: string): Promise<CommerceAnalytics> =>
    api.get<CommerceAnalytics>(integrationPath(integrationId, "/analytics")),

  /** GET /api/v1/commerce/catalogs?limit=&cursor= (read:reports). */
  listCatalogs: (
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceCatalog>> =>
    api.get<CommerceCursorPage<CommerceCatalog>>("/api/v1/commerce/catalogs", {
      query: { limit: query.limit, cursor: query.cursor },
    }),

  /** POST /api/v1/commerce/catalogs (admin) — 201 with the created catalog. */
  createCatalog: (
    input: CommerceCatalogInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceCatalog> =>
    api
      .post<unknown>("/api/v1/commerce/catalogs", input, liveOptions(options))
      .then((value) => {
        const catalog = verifiedCreatedRecord<CommerceCatalog>(
          value,
          "catalog create",
        );
        if (
          catalog.name !== input.name ||
          catalog.source_type !== input.source_type ||
          (input.integration_id !== undefined &&
            catalog.integration_id !== input.integration_id) ||
          (input.default_currency !== undefined &&
            catalog.default_currency !== input.default_currency) ||
          (input.status !== undefined && catalog.status !== input.status) ||
          (input.locale !== undefined && catalog.locale !== input.locale) ||
          (input.feed_url !== undefined && catalog.feed_url !== input.feed_url)
        ) {
          throw new Error(
            "The catalog create request may have completed, but the returned record did not match the submitted catalog.",
          );
        }
        return catalog;
      }),

  /**
   * POST /api/v1/commerce/catalogs/{catalog_id}/import (admin) — 202 with a
   * summary. The server processes the whole batch synchronously, so the call
   * gets one attempt and a long timeout: a retry would re-submit products the
   * first attempt may already have upserted.
   */
  importCatalogProducts: (
    catalogId: string,
    input: CommerceCatalogImportInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceCatalogImportSummary> =>
    api
      .post<unknown>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/import`,
        input,
        liveOptions(options, { timeoutMs: 60_000 }),
      )
      .then((value) => {
        const row = value as Partial<CommerceCatalogImportSummary> | null;
        if (
          !row ||
          row.catalog_id !== catalogId ||
          typeof row.integration_id !== "string" ||
          !row.integration_id ||
          !nonNegativeInteger(row.products_seen) ||
          !nonNegativeInteger(row.products_upserted) ||
          !nonNegativeInteger(row.catalog_items_upserted) ||
          !nonNegativeInteger(row.products_skipped) ||
          typeof row.imported_at !== "string" ||
          !row.imported_at
        ) {
          throw new Error(
            "The catalog import may have completed, but its acknowledgement could not be verified. Refresh the catalog before importing again.",
          );
        }
        return row as CommerceCatalogImportSummary;
      }),

  /** GET /api/v1/commerce/catalogs/{catalog_id}/feeds?limit=&cursor= (read:reports). */
  listProductFeeds: (
    catalogId: string,
    query: CommerceCursorQuery = {},
  ): Promise<CommerceCursorPage<CommerceProductFeed>> =>
    api.get<CommerceCursorPage<CommerceProductFeed>>(
      `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds`,
      { query: { limit: query.limit, cursor: query.cursor } },
    ),

  /** POST /api/v1/commerce/catalogs/{catalog_id}/feeds (admin) — 201 draft feed. */
  createProductFeed: (
    catalogId: string,
    input: CommerceProductFeedInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceProductFeed> =>
    api
      .post<unknown>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds`,
        input,
        liveOptions(options),
      )
      .then((value) => {
        const feed = verifiedCreatedRecord<CommerceProductFeed>(
          value,
          "product-feed create",
        );
        if (
          feed.name !== input.name ||
          feed.catalog_id !== catalogId ||
          feed.feed_type !== input.feed_type ||
          (input.status !== undefined && feed.status !== input.status) ||
          (input.max_items !== undefined &&
            feed.max_items !== input.max_items) ||
          (input.exclude_out_of_stock !== undefined &&
            feed.exclude_out_of_stock !== input.exclude_out_of_stock)
        ) {
          throw new Error(
            "The product-feed request may have completed, but the returned record did not match the submitted feed.",
          );
        }
        return feed;
      }),

  /**
   * POST /api/v1/commerce/catalogs/{catalog_id}/feeds/{feed_id}/resolve
   * (read:reports). A read-scope POST: it returns the resolver's selection as
   * review evidence and changes nothing, so it carries no idempotency key.
   */
  resolveProductFeed: (
    catalogId: string,
    feedId: string,
    input: CommerceFeedResolveInput = {},
  ): Promise<CommerceResolvedFeed> =>
    api.post<CommerceResolvedFeed>(
      `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds/${encodeURIComponent(feedId)}/resolve`,
      input,
      { idempotencyKey: null },
    ),

  /** GET /api/v1/commerce/shopify/oauth/start?shop= (admin). */
  startShopifyOAuth: (
    shopDomain: string,
    options: Pick<CommerceRequestOptions, "signal"> = {},
  ): Promise<CommerceShopifyOAuthStart> =>
    api.get<CommerceShopifyOAuthStart>("/api/v1/commerce/shopify/oauth/start", {
      query: { shop: shopDomain },
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    }),

  /* ---------- recovery & alerts (read:reports lists, admin creates) ---------- */

  /** GET /api/v1/commerce/integrations/{id}/cart-recovery-links?status=&limit=&cursor= (read:reports). */
  listCartRecoveryLinks: (
    integrationId: string,
    query: CommerceStatusQuery = {},
  ): Promise<CommerceCursorPage<CommerceCartRecoveryLink>> =>
    api.get<CommerceCursorPage<CommerceCartRecoveryLink>>(
      integrationPath(integrationId, "/cart-recovery-links"),
      {
        query: {
          status: query.status || undefined,
          limit: query.limit,
          cursor: query.cursor,
        },
      },
    ),

  /**
   * POST /api/v1/commerce/integrations/{id}/cart-recovery-links (admin) — 201.
   * An upsert keyed on `source_cart_id`: re-registering the same cart updates
   * the link rather than creating a second one.
   */
  upsertCartRecoveryLink: (
    integrationId: string,
    input: CommerceCartRecoveryLinkInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceCartRecoveryLink> =>
    api
      .post<unknown>(
        integrationPath(integrationId, "/cart-recovery-links"),
        input,
        liveOptions(options),
      )
      .then((value) => {
        const link = verifiedCreatedRecord<CommerceCartRecoveryLink>(
          value,
          "cart-recovery link",
        );
        if (
          link.source_cart_id !== input.source_cart_id ||
          link.recovery_url !== input.recovery_url ||
          (input.cart_order_id !== undefined &&
            link.cart_order_id !== input.cart_order_id) ||
          (input.customer_email !== undefined &&
            link.customer_email !== input.customer_email) ||
          (input.status !== undefined && link.status !== input.status) ||
          (input.expires_at !== undefined &&
            link.expires_at !== input.expires_at)
        ) {
          throw new Error(
            "The cart-recovery request may have completed, but the returned record did not match the submitted cart and URL.",
          );
        }
        return link;
      }),

  /** GET /api/v1/commerce/integrations/{id}/back-in-stock-subscriptions?status=&limit=&cursor= (read:reports). */
  listBackInStockSubscriptions: (
    integrationId: string,
    query: CommerceStatusQuery = {},
  ): Promise<CommerceCursorPage<CommerceBackInStockSubscription>> =>
    api.get<CommerceCursorPage<CommerceBackInStockSubscription>>(
      integrationPath(integrationId, "/back-in-stock-subscriptions"),
      {
        query: {
          status: query.status || undefined,
          limit: query.limit,
          cursor: query.cursor,
        },
      },
    ),

  /** POST /api/v1/commerce/integrations/{id}/products/{product_id}/back-in-stock-subscriptions (admin) — 201. */
  createBackInStockSubscription: (
    integrationId: string,
    productId: string,
    input: CommerceBackInStockSubscriptionInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceBackInStockSubscription> =>
    api
      .post<unknown>(
        productPath(integrationId, productId, "/back-in-stock-subscriptions"),
        input,
        liveOptions(options),
      )
      .then((value) => {
        const subscription =
          verifiedCreatedRecord<CommerceBackInStockSubscription>(
            value,
            "back-in-stock subscription",
          );
        if (
          subscription.product_id !== productId ||
          (input.variant_id !== undefined &&
            subscription.variant_id !== input.variant_id) ||
          (input.subscriber_id !== undefined &&
            subscription.subscriber_id !== input.subscriber_id) ||
          (input.subscriber_email !== undefined &&
            subscription.subscriber_email !== input.subscriber_email) ||
          (input.expires_at !== undefined &&
            subscription.expires_at !== input.expires_at)
        ) {
          throw new Error(
            "The back-in-stock request may have completed, but the returned record did not match the submitted subscription.",
          );
        }
        return subscription;
      }),

  /** GET /api/v1/commerce/integrations/{id}/price-drop-watchers?status=&limit=&cursor= (read:reports). */
  listPriceDropWatchers: (
    integrationId: string,
    query: CommerceStatusQuery = {},
  ): Promise<CommerceCursorPage<CommercePriceDropWatcher>> =>
    api.get<CommerceCursorPage<CommercePriceDropWatcher>>(
      integrationPath(integrationId, "/price-drop-watchers"),
      {
        query: {
          status: query.status || undefined,
          limit: query.limit,
          cursor: query.cursor,
        },
      },
    ),

  /** POST /api/v1/commerce/integrations/{id}/products/{product_id}/price-drop-watchers (admin) — 201. */
  createPriceDropWatcher: (
    integrationId: string,
    productId: string,
    input: CommercePriceDropWatcherInput,
    options: CommerceRequestOptions = {},
  ): Promise<CommercePriceDropWatcher> =>
    api
      .post<unknown>(
        productPath(integrationId, productId, "/price-drop-watchers"),
        input,
        liveOptions(options),
      )
      .then((value) => {
        const watcher = verifiedCreatedRecord<CommercePriceDropWatcher>(
          value,
          "price-drop watcher",
        );
        if (
          watcher.product_id !== productId ||
          (input.variant_id !== undefined &&
            watcher.variant_id !== input.variant_id) ||
          (input.subscriber_id !== undefined &&
            watcher.subscriber_id !== input.subscriber_id) ||
          (input.subscriber_email !== undefined &&
            watcher.subscriber_email !== input.subscriber_email) ||
          (input.original_price_cents !== undefined &&
            watcher.original_price_cents !== input.original_price_cents) ||
          (input.target_price_cents !== undefined &&
            watcher.target_price_cents !== input.target_price_cents) ||
          (input.min_drop_percent !== undefined &&
            watcher.min_drop_percent !== input.min_drop_percent) ||
          (input.currency !== undefined &&
            watcher.currency !== input.currency) ||
          (input.expires_at !== undefined &&
            watcher.expires_at !== input.expires_at)
        ) {
          throw new Error(
            "The price-drop request may have completed, but the returned record did not match the submitted watcher.",
          );
        }
        return watcher;
      }),

  /* ---------- lifecycle (report is read:reports, evaluate is admin) ---------- */

  /** GET /api/v1/commerce/integrations/{id}/lifecycle/report (read:reports). */
  lifecycleReport: (integrationId: string): Promise<CommerceLifecycleReport> =>
    api.get<CommerceLifecycleReport>(
      integrationPath(integrationId, "/lifecycle/report"),
    ),

  /**
   * POST /api/v1/commerce/integrations/{id}/lifecycle/evaluate (admin) — 200
   * with the acknowledgement counters. The evaluator walks every pending
   * back-in-stock and price-drop subscription for the store in one request,
   * so it gets one attempt and a long timeout: a transport-level retry could
   * run the same evaluation twice before the first acknowledgement arrives.
   */
  evaluateLifecycle: (
    integrationId: string,
    options: CommerceRequestOptions = {},
  ): Promise<CommerceLifecycleEvaluation> =>
    api.post<CommerceLifecycleEvaluation>(
      integrationPath(integrationId, "/lifecycle/evaluate"),
      {},
      liveOptions(options, { timeoutMs: 30_000 }),
    ),
};

export function commerceSyncStateLabel(
  integration: CommerceIntegration,
): string | null {
  const state = integration.sync_state;
  if (!state) return null;
  if (state.cursor_kind === "shopify_complete" || state.complete) {
    return "Backfill complete";
  }
  if (state.cursor_kind === "shopify_bulk") {
    const object = titleCase(state.object || "bulk");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "running";
    const progress =
      (state.line_offset ?? 0) > 0
        ? ` · ${state.line_offset?.toLocaleString()} lines`
        : "";
    if (state.retry_due)
      return `${object} bulk retry due · ${status}${progress}`;
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} bulk retry in ${formatDurationSeconds(
        state.retry_wait_seconds ?? 0,
      )} · ${status}${progress}`;
    }
    if ((state.attempts ?? 0) > 0) {
      return `${object} bulk retry ${state.attempts} · ${status}${progress}`;
    }
    return `${object} bulk ${status}${progress}`;
  }
  if (state.cursor_kind === "shopify_cursor") {
    return `${titleCase(state.object || "sync")} backfill queued`;
  }
  if (state.cursor_kind === "woocommerce_retry") {
    const object = titleCase(state.object || "sync");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "failed";
    if (state.retry_due) return `${object} WooCommerce retry due · ${status}`;
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} WooCommerce retry in ${formatDurationSeconds(
        state.retry_wait_seconds ?? 0,
      )} · ${status}`;
    }
    return `${object} WooCommerce retry ${state.attempts ?? 1} · ${status}`;
  }
  if (state.cursor_kind === "woocommerce_cursor") {
    return `${titleCase(state.object || "sync")} WooCommerce backfill queued`;
  }
  if (state.cursor_kind === "bigcommerce_retry") {
    const object = titleCase(state.object || "sync");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "failed";
    if (state.retry_due) return `${object} BigCommerce retry due · ${status}`;
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} BigCommerce retry in ${formatDurationSeconds(
        state.retry_wait_seconds ?? 0,
      )} · ${status}`;
    }
    return `${object} BigCommerce retry ${state.attempts ?? 1} · ${status}`;
  }
  if (state.cursor_kind === "bigcommerce_cursor") {
    return `${titleCase(state.object || "sync")} BigCommerce backfill queued`;
  }
  if (state.cursor_kind === "stripe_retry") {
    const object = titleCase(state.object || "sync");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "failed";
    if (state.retry_due) return `${object} Stripe retry due · ${status}`;
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} Stripe retry in ${formatDurationSeconds(
        state.retry_wait_seconds ?? 0,
      )} · ${status}`;
    }
    return `${object} Stripe retry ${state.attempts ?? 1} · ${status}`;
  }
  if (state.cursor_kind === "stripe_cursor") {
    return `${titleCase(state.object || "sync")} Stripe backfill queued`;
  }
  if (state.cursor_kind === "stripe_complete") {
    return "Stripe backfill complete";
  }
  if (state.cursor_kind === "legacy") return "Legacy backfill cursor";
  return null;
}

export function commerceSyncStateTone(
  integration: CommerceIntegration,
): CommerceSyncTone {
  const state = integration.sync_state;
  if (!state) return "neutral";
  if (state.last_error || integration.error_message) return "danger";
  if (state.cursor_kind === "shopify_complete" || state.complete) {
    return "success";
  }
  if (
    state.cursor_kind === "woocommerce_retry" ||
    state.cursor_kind === "bigcommerce_retry" ||
    state.cursor_kind === "stripe_retry"
  ) {
    return "danger";
  }
  if (state.cursor_kind === "shopify_bulk") return "warning";
  return "neutral";
}

export function commerceEventError(event: CommerceEventRow): string | null {
  const err = event.metadata?.error;
  return typeof err === "string" && err.trim() ? err.trim() : null;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
