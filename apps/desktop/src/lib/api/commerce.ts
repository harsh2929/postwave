import type { ApiResult } from "./result";

interface CommerceRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type CommerceRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: CommerceRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- #33 Commerce suite (commerce) ----------------------------- */

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

export interface CommerceDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: "disconnected" | string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  webhook_endpoint?: string;
  webhook_ids?: string[];
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface CommerceDisconnectResponse {
  ok: boolean;
  provider_cleanup?: CommerceDisconnectCleanupEvidence;
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

export interface CommerceProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface CommerceProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: "oauth" | "api_key_ref" | string;
  managed: boolean;
  runtime_status: "available" | "delegated" | "partial" | "planned" | string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: CommerceProviderField[];
  optional_settings?: CommerceProviderField[];
  scopes: string[];
  webhook_topics?: string[];
  sync_objects: string[];
  docs_url: string;
}

export interface CommerceIntegrationInput {
  provider: string;
  shop_domain?: string;
  status?: string;
  scopes?: string[];
  settings?: Record<string, unknown>;
  credential_ref?: string;
}

export interface CommercePageInfo {
  total: number;
  page: number;
  per_page: number;
}

/**
 * Mounted Commerce list routes use opaque keyset cursors. `perPage` remains
 * as a defensive source-compatibility alias, but is sent to the API as
 * `limit`; numeric page offsets cannot be translated into an opaque cursor.
 */
export interface CommerceCursorOptions {
  cursor?: string;
  limit?: number;
  perPage?: number;
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

export interface CommerceLifecycleStats {
  total: number;
  by_status: Record<string, number>;
}

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

export interface CommerceCustomer {
  id: string;
  source_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  accepts_marketing: boolean;
  tags: string[];
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
  option_values: Record<string, unknown>;
  price_cents: number;
  compare_at_price_cents?: number | null;
  currency: string;
  inventory_quantity?: number | null;
  inventory_policy: string;
  available: boolean;
  image_url?: string;
  url?: string;
  [extra: string]: unknown;
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
  metadata: Record<string, unknown>;
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
  metadata: Record<string, unknown>;
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
  attribution: Record<string, unknown>;
  line_items: Array<Record<string, unknown>>;
  ordered_at: string;
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

export interface CommerceAnalytics {
  customers: number;
  products: number;
  orders: number;
  revenue_cents: number;
  average_order_cents: number;
  currency: string;
  orders_by_status: Record<string, number>;
  last_order_at?: string | null;
}

/**
 * Cursor envelope returned by mounted Commerce list endpoints.
 *
 * The optional numeric fields document an older facade response and keep
 * consumers source-compatible while they migrate. Navigation must use
 * `next_cursor`; the mounted API does not accept a numeric `page`.
 */
export interface CommercePage<T> {
  items: T[];
  next_cursor?: string;
  total?: number;
  page?: number;
  per_page?: number;
}

function validCommerceLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function commercePageQS(opts: CommerceCursorOptions): string {
  const params = new URLSearchParams();
  const limit = validCommerceLimit(opts.limit ?? opts.perPage);
  if (limit !== undefined) params.set("limit", String(limit));
  if (typeof opts.cursor === "string" && opts.cursor.length > 0) {
    params.set("cursor", opts.cursor);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function createCommerceDataMethods(request: CommerceRequester) {
  return {
    /** GET /api/v1/commerce/integrations/{id}/customers. */
    listCustomers(
      integrationId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceCustomer>>> {
      return request<CommercePage<CommerceCustomer>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/customers${commercePageQS(opts)}`,
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/products. */
    listProducts(
      integrationId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceProduct>>> {
      return request<CommercePage<CommerceProduct>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products${commercePageQS(opts)}`,
      );
    },
    /** GET .../products/{product_id}/variants. */
    listProductVariants(
      integrationId: string,
      productId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceProductVariant>>> {
      return request<CommercePage<CommerceProductVariant>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products/${encodeURIComponent(productId)}/variants${commercePageQS(opts)}`,
      );
    },
    /** GET .../products/{product_id}/inventory. */
    listInventorySnapshots(
      integrationId: string,
      productId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceInventorySnapshot>>> {
      return request<CommercePage<CommerceInventorySnapshot>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products/${encodeURIComponent(productId)}/inventory${commercePageQS(opts)}`,
      );
    },
    /** GET .../products/{product_id}/price-history. */
    listPriceHistory(
      integrationId: string,
      productId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommercePriceHistoryPoint>>> {
      return request<CommercePage<CommercePriceHistoryPoint>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products/${encodeURIComponent(productId)}/price-history${commercePageQS(opts)}`,
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/orders. */
    listOrders(
      integrationId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceOrder>>> {
      return request<CommercePage<CommerceOrder>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/orders${commercePageQS(opts)}`,
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/events. */
    listEvents(
      integrationId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceEventRow>>> {
      return request<CommercePage<CommerceEventRow>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/events${commercePageQS(opts)}`,
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/analytics. */
    analytics(integrationId: string): Promise<ApiResult<CommerceAnalytics>> {
      return request<CommerceAnalytics>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/analytics`,
      );
    },
  };
}

export function createCommerceApi(request: CommerceRequester) {
  return {
    /** GET /api/v1/commerce/providers (admin) — managed provider specs. */
    listProviders(): Promise<ApiResult<{ items: CommerceProviderSpec[] }>> {
      return request<{ items: CommerceProviderSpec[] }>(
        "/api/v1/commerce/providers",
      );
    },
    /** GET /api/v1/commerce/integrations (admin) — BARE ARRAY. */
    listIntegrations(): Promise<ApiResult<CommerceIntegration[]>> {
      return request<CommerceIntegration[]>("/api/v1/commerce/integrations");
    },
    /** POST /api/v1/commerce/integrations (admin) — non-Shopify managed connectors. */
    createIntegration(
      input: CommerceIntegrationInput,
    ): Promise<ApiResult<CommerceIntegration>> {
      return request<CommerceIntegration>("/api/v1/commerce/integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/commerce/integrations/{id}. */
    getIntegration(id: string): Promise<ApiResult<CommerceIntegration>> {
      return request<CommerceIntegration>(
        `/api/v1/commerce/integrations/${encodeURIComponent(id)}`,
      );
    },
    /** POST /api/v1/commerce/integrations/{id}/sync (admin) — 202 sync summary.
     *  Requires canonical customers/products/orders; provider pullers are not exposed yet.
     *  (POST .../backfill is the same handler.) */
    syncIntegration(
      id: string,
      input: Record<string, unknown>,
    ): Promise<
      ApiResult<{
        customers_upserted: number;
        products_upserted: number;
        orders_upserted: number;
        cursor?: string;
      }>
    > {
      return request<{
        customers_upserted: number;
        products_upserted: number;
        orders_upserted: number;
        cursor?: string;
      }>(
        `/api/v1/commerce/integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    /** POST /api/v1/commerce/integrations/{id}/pause (admin). */
    pauseIntegration(id: string): Promise<ApiResult<CommerceIntegration>> {
      return request<CommerceIntegration>(
        `/api/v1/commerce/integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    /** DELETE /api/v1/commerce/integrations/{id} (admin) — disconnect. */
    disconnectIntegration(
      id: string,
    ): Promise<ApiResult<CommerceDisconnectResponse>> {
      return request<CommerceDisconnectResponse>(
        `/api/v1/commerce/integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /** GET /api/v1/commerce/shopify/oauth/start?shop= (admin). */
    startShopifyOAuth(shopDomain: string): Promise<
      ApiResult<{
        provider: string;
        shop_domain: string;
        authorize_url: string;
        state: string;
        scopes: string[];
        local: boolean;
      }>
    > {
      return request<{
        provider: string;
        shop_domain: string;
        authorize_url: string;
        state: string;
        scopes: string[];
        local: boolean;
      }>(
        `/api/v1/commerce/shopify/oauth/start?shop=${encodeURIComponent(shopDomain)}`,
      );
    },
    /** GET /api/v1/commerce/catalogs?limit=&cursor=. */
    listCatalogs(
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceCatalog>>> {
      return request<CommercePage<CommerceCatalog>>(
        `/api/v1/commerce/catalogs${commercePageQS(opts)}`,
      );
    },
    /** POST /api/v1/commerce/catalogs (admin) — 201. */
    createCatalog(
      input: CommerceCatalogInput,
    ): Promise<ApiResult<CommerceCatalog>> {
      return request<CommerceCatalog>("/api/v1/commerce/catalogs", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** POST /api/v1/commerce/catalogs/{catalog_id}/import (admin) — 202. */
    importCatalogProducts(
      catalogId: string,
      input: {
        products: Array<Record<string, unknown>>;
        replace?: boolean;
      },
    ): Promise<ApiResult<CommerceCatalogImportSummary>> {
      return request<CommerceCatalogImportSummary>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/import`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1 },
      );
    },
    /** GET /api/v1/commerce/catalogs/{catalog_id}/feeds. */
    listProductFeeds(
      catalogId: string,
      opts: CommerceCursorOptions = {},
    ): Promise<ApiResult<CommercePage<CommerceProductFeed>>> {
      return request<CommercePage<CommerceProductFeed>>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds${commercePageQS(opts)}`,
      );
    },
    /** POST /api/v1/commerce/catalogs/{catalog_id}/feeds (admin) — 201. */
    createProductFeed(
      catalogId: string,
      input: CommerceProductFeedInput,
    ): Promise<ApiResult<CommerceProductFeed>> {
      return request<CommerceProductFeed>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** POST /api/v1/commerce/catalogs/{catalog_id}/feeds/{feed_id}/resolve. */
    resolveProductFeed(
      catalogId: string,
      feedId: string,
      input: {
        subscriber_email?: string;
        max_items?: number;
        exclude_out_of_stock?: boolean;
        context?: Record<string, unknown>;
      } = {},
    ): Promise<ApiResult<CommerceResolvedFeed>> {
      return request<CommerceResolvedFeed>(
        `/api/v1/commerce/catalogs/${encodeURIComponent(catalogId)}/feeds/${encodeURIComponent(feedId)}/resolve`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/cart-recovery-links?status=. */
    listCartRecoveryLinks(
      integrationId: string,
      opts: CommerceCursorOptions & { status?: string } = {},
    ): Promise<ApiResult<CommercePage<CommerceCartRecoveryLink>>> {
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const limit = validCommerceLimit(opts.limit ?? opts.perPage);
      if (limit !== undefined) params.set("limit", String(limit));
      if (typeof opts.cursor === "string" && opts.cursor.length > 0) {
        params.set("cursor", opts.cursor);
      }
      const qs = params.toString();
      return request<CommercePage<CommerceCartRecoveryLink>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/cart-recovery-links${qs ? `?${qs}` : ""}`,
      );
    },
    /** POST /api/v1/commerce/integrations/{id}/cart-recovery-links (admin) — 201 upsert. */
    upsertCartRecoveryLink(
      integrationId: string,
      input: {
        cart_order_id?: string;
        source_cart_id: string;
        customer_email?: string;
        recovery_url: string;
        status?: string;
        expires_at?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<ApiResult<CommerceCartRecoveryLink>> {
      return request<CommerceCartRecoveryLink>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/cart-recovery-links`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/back-in-stock-subscriptions?status=. */
    listBackInStockSubscriptions(
      integrationId: string,
      opts: CommerceCursorOptions & { status?: string } = {},
    ): Promise<ApiResult<CommercePage<CommerceBackInStockSubscription>>> {
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const limit = validCommerceLimit(opts.limit ?? opts.perPage);
      if (limit !== undefined) params.set("limit", String(limit));
      if (typeof opts.cursor === "string" && opts.cursor.length > 0) {
        params.set("cursor", opts.cursor);
      }
      const qs = params.toString();
      return request<CommercePage<CommerceBackInStockSubscription>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/back-in-stock-subscriptions${qs ? `?${qs}` : ""}`,
      );
    },
    /** POST .../integrations/{id}/products/{product_id}/back-in-stock-subscriptions (admin) — 201. */
    createBackInStockSubscription(
      integrationId: string,
      productId: string,
      input: {
        variant_id?: string;
        subscriber_id?: string;
        subscriber_email?: string;
        expires_at?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<ApiResult<CommerceBackInStockSubscription>> {
      return request<CommerceBackInStockSubscription>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products/${encodeURIComponent(productId)}/back-in-stock-subscriptions`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/price-drop-watchers?status=. */
    listPriceDropWatchers(
      integrationId: string,
      opts: CommerceCursorOptions & { status?: string } = {},
    ): Promise<ApiResult<CommercePage<CommercePriceDropWatcher>>> {
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const limit = validCommerceLimit(opts.limit ?? opts.perPage);
      if (limit !== undefined) params.set("limit", String(limit));
      if (typeof opts.cursor === "string" && opts.cursor.length > 0) {
        params.set("cursor", opts.cursor);
      }
      const qs = params.toString();
      return request<CommercePage<CommercePriceDropWatcher>>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/price-drop-watchers${qs ? `?${qs}` : ""}`,
      );
    },
    /** POST .../integrations/{id}/products/{product_id}/price-drop-watchers (admin) — 201. */
    createPriceDropWatcher(
      integrationId: string,
      productId: string,
      input: {
        variant_id?: string;
        subscriber_id?: string;
        subscriber_email?: string;
        original_price_cents?: number;
        target_price_cents?: number;
        min_drop_percent?: number;
        currency?: string;
        expires_at?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<ApiResult<CommercePriceDropWatcher>> {
      return request<CommercePriceDropWatcher>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/products/${encodeURIComponent(productId)}/price-drop-watchers`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** POST /api/v1/commerce/integrations/{id}/lifecycle/evaluate (admin). */
    evaluateLifecycle(integrationId: string): Promise<
      ApiResult<{
        back_in_stock_eligible: number;
        price_drop_eligible: number;
        evaluated_at: string;
      }>
    > {
      return request<{
        back_in_stock_eligible: number;
        price_drop_eligible: number;
        evaluated_at: string;
      }>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/lifecycle/evaluate`,
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 30_000, maxAttempts: 1 },
      );
    },
    /** GET /api/v1/commerce/integrations/{id}/lifecycle/report. */
    lifecycleReport(
      integrationId: string,
    ): Promise<ApiResult<CommerceLifecycleReport>> {
      return request<CommerceLifecycleReport>(
        `/api/v1/commerce/integrations/${encodeURIComponent(integrationId)}/lifecycle/report`,
      );
    },
    ...createCommerceDataMethods(request),
  };
}
