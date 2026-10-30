/**
 * Commerce integration browse surfaces.
 *
 * Keeps the paged customer, product, order, event, variant, inventory, and
 * price-history views isolated from store connection administration.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Named, bounded table regions must be keyboard-focusable so keyboard users can pan overflow locally. */

import { prefersReducedMotionNow } from "../../hooks/usePrefersReducedMotion";
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { Modal, ModalFooter } from "../Modal";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  type CommerceAnalytics,
  type CommerceCustomer,
  type CommerceEventRow,
  type CommerceIntegration,
  type CommerceInventorySnapshot,
  type CommerceOrder,
  type CommercePage,
  type CommercePriceHistoryPoint,
  type CommerceProduct,
  type CommerceProductVariant,
  commerceApi,
} from "../../lib/api-client";
import {
  type RemoteApiError,
  type RemoteFailure,
  type RemoteTransport,
} from "../../lib/remote-resource";

import { analyticsTiles, fmtCents, fmtCommerceDate } from "./commerce-helpers";
import { Pager } from "./Pager";

const PER_PAGE = 25;

type CommercePageLoader<T> = (
  cursor: string | undefined,
) => Promise<{ data?: CommercePage<T>; error?: RemoteApiError }>;

interface CommercePageController<T> {
  data: CommercePage<T> | null;
  transport: RemoteTransport;
  failure: RemoteFailure | null;
  stale: boolean;
  retry: () => void;
  pageNumber: number;
  hasPrevious: boolean;
  nextCursor: string | null;
  previousPage: () => void;
  nextPage: (cursor: string) => void;
}

function useCommercePage<T>(
  identity: string,
  loader: CommercePageLoader<T>,
): CommercePageController<T> {
  const [cursorState, setCursorState] = useState<{
    identity: string;
    trail: string[];
  }>({ identity, trail: [] });
  const cursorTrail =
    cursorState.identity === identity ? cursorState.trail : [];
  const cursor = cursorTrail.at(-1);
  const pageNumber = cursorTrail.length + 1;
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const resource = useRemoteResource<CommercePage<T>>(
    async () => {
      const result = await loader(cursor);
      if (result.error) return { error: result.error };
      if (!result.data || !Array.isArray(result.data.items)) {
        return {
          error: {
            message: "Invalid commerce page",
            kind: "parse",
          },
        };
      }
      return { data: result.data };
    },
    { identity: JSON.stringify([identity, cursor ?? null]) },
  );

  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = resource.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };
  const rawNextCursor = resource.data?.next_cursor;
  const nextCursor =
    typeof rawNextCursor === "string" &&
    rawNextCursor.length > 0 &&
    !cursorTrail.includes(rawNextCursor)
      ? rawNextCursor
      : null;

  return {
    data: resource.data,
    transport: resource.transport,
    failure: resource.failure,
    stale: resource.stale,
    retry,
    pageNumber,
    hasPrevious: cursorTrail.length > 0,
    nextCursor,
    previousPage: () => {
      if (resource.transport === "loading" || cursorTrail.length === 0) return;
      setCursorState({
        identity,
        trail: cursorTrail.slice(0, -1),
      });
    },
    nextPage: (requestedCursor) => {
      if (resource.transport === "loading" || requestedCursor !== nextCursor) {
        return;
      }
      setCursorState({
        identity,
        trail: [...cursorTrail, requestedCursor],
      });
    },
  };
}

function formatCommerceRecord(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return "none";
  const visible = entries.slice(0, 4).map(([key, option]) => {
    const rendered =
      typeof option === "string" ||
      typeof option === "number" ||
      typeof option === "boolean"
        ? String(option).slice(0, 48)
        : "configured";
    return `${key.slice(0, 32)}: ${rendered}`;
  });
  return `${visible.join(" · ")}${entries.length > visible.length ? ` · +${entries.length - visible.length} more` : ""}`;
}

function maskedEmail(value?: string | null): string {
  if (!value) return "Email not recorded";
  const [local, domain, ...rest] = value.trim().split("@");
  if (!local || !domain || rest.length > 0) return "Email recorded · masked";
  return `${local.slice(0, 1) || "•"}•••@${domain}`;
}

function CommerceTime({ value }: { value?: string | null }): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return <span className="commerce-value">{value}</span>;
  }
  return (
    <time dateTime={parsed.toISOString()} className="commerce-time">
      <span>{fmtCommerceDate(value)}</span>
      <span className="commerce-detail">{parsed.toISOString()}</span>
    </time>
  );
}

function CommerceLoadState({
  label,
  dataPresent,
  transport,
  failure,
  stale,
  onRetry,
}: {
  label: string;
  dataPresent: boolean;
  transport: RemoteTransport;
  failure: RemoteFailure | null;
  stale: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (transport === "loading") {
    return (
      <p className="muted" role="status" aria-live="polite">
        {dataPresent ? `Refreshing ${label}…` : `Loading ${label}…`}
      </p>
    );
  }
  if (!failure) return null;
  return (
    <div className="notice commerce-resource-notice" role="alert">
      <span>
        {failure.message}
        {stale ? ` Showing the last successfully loaded ${label}.` : ""}
        {failure.requestId ? ` Request ID: ${failure.requestId}.` : ""}
      </span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry {label}
      </button>
    </div>
  );
}

function CommerceRefreshAction({
  label,
  transport,
  onRefresh,
}: {
  label: string;
  transport: RemoteTransport;
  onRefresh: () => void;
}): ReactElement {
  const loading = transport === "loading";
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={() => {
        if (!loading) onRefresh();
      }}
    >
      {loading ? `Refreshing ${label}…` : `Refresh ${label}`}
    </button>
  );
}

const CUSTOMER_COLS = "1.6fr 1fr 130px 170px";
const PRODUCT_COLS = "2fr 110px 150px 260px";
const ORDER_COLS = "1fr 1.4fr 110px 110px 170px";
const EVENT_COLS = "1.2fr 1.4fr 1fr 170px";

const BROWSE_VIEWS = [
  { id: "customers", label: "Customers" },
  { id: "products", label: "Products" },
  { id: "orders", label: "Orders" },
  { id: "events", label: "Events" },
] as const;
type BrowseView = (typeof BROWSE_VIEWS)[number]["id"];
const BROWSE_TAB_ITEMS = BROWSE_VIEWS.map((item) => ({ value: item.id }));

type ProductDrill = {
  product: CommerceProduct;
  kind: "variants" | "inventory" | "price-history";
};

export function IntegrationBrowsePanel({
  id,
  integration,
  onClose,
}: {
  id: string;
  integration: CommerceIntegration;
  onClose: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const drillReturnFocusRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<BrowseView>("customers");
  const [drill, setDrill] = useState<ProductDrill | null>(null);
  const tabs = useTabsInteraction<BrowseView>({
    value: view,
    items: BROWSE_TAB_ITEMS,
    onChange: (nextView) => {
      setDrill(null);
      setView(nextView);
    },
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotionNow() ? "auto" : "smooth",
    });
  }, []);

  return (
    <div
      ref={panelRef}
      id={id}
      className="card commerce-browse-panel"
      role="region"
      aria-label={`${integration.shop_domain || integration.provider} commerce data`}
      tabIndex={-1}
      style={{ marginTop: 16, padding: 16 }}
    >
      <div
        className="commerce-panel-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div className="section-title" style={{ marginBottom: 0 }}>
          {integration.shop_domain || integration.provider} data
        </div>
        <div
          ref={tabs.listRef}
          {...tabs.listProps}
          className="tabs commerce-tabs"
          aria-label="Commerce data view"
          style={{ width: "auto" }}
        >
          {BROWSE_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`tab${view === v.id ? " is-active" : ""}`}
              {...tabs.getTabProps(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onClose}
        >
          Close store data
        </button>
      </div>

      <AnalyticsStrip integrationId={integration.id} />

      <div {...tabs.getPanelProps(view)}>
        {view === "customers" ? (
          <CustomersTable integrationId={integration.id} />
        ) : view === "products" ? (
          <ProductsTable
            integrationId={integration.id}
            onDrill={(product, kind) => {
              drillReturnFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
              setDrill({ product, kind });
            }}
          />
        ) : view === "orders" ? (
          <OrdersTable integrationId={integration.id} />
        ) : (
          <EventsTable integrationId={integration.id} />
        )}
      </div>

      {drill?.kind === "variants" ? (
        <VariantsModal
          integrationId={integration.id}
          product={drill.product}
          returnFocusRef={drillReturnFocusRef}
          onClose={() => setDrill(null)}
        />
      ) : null}
      {drill?.kind === "inventory" ? (
        <InventoryModal
          integrationId={integration.id}
          product={drill.product}
          returnFocusRef={drillReturnFocusRef}
          onClose={() => setDrill(null)}
        />
      ) : null}
      {drill?.kind === "price-history" ? (
        <PriceHistoryModal
          integrationId={integration.id}
          product={drill.product}
          returnFocusRef={drillReturnFocusRef}
          onClose={() => setDrill(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * #33b — per-integration analytics strip (GET /integrations/{id}/analytics).
 * Money renders in the wire's currency; a load failure shows the error
 * inline without blocking the browse tables below.
 */
function AnalyticsStrip({
  integrationId,
}: {
  integrationId: string;
}): ReactElement {
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const source = useRemoteResource<CommerceAnalytics>(
    async () => {
      const result = await commerceApi.analytics(integrationId);
      if (result.error) return { error: result.error };
      if (!result.data) {
        return {
          error: { message: "Invalid analytics response", kind: "parse" },
        };
      }
      return { data: result.data };
    },
    { identity: `commerce-analytics:${integrationId}` },
  );
  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = source.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };

  if (source.data === null) {
    return (
      <CommerceLoadState
        label="store analytics"
        dataPresent={false}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={retry}
      />
    );
  }
  return (
    <section aria-label="Store analytics" className="commerce-analytics">
      <div className="commerce-subsection-toolbar">
        <p className="muted">
          Imported-record aggregate. Reporting window, generation time, and
          currency-mix provenance are unavailable from this response.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={source.transport === "loading" || undefined}
          aria-busy={source.transport === "loading" || undefined}
          onClick={() => {
            if (source.transport !== "loading") retry();
          }}
        >
          {source.transport === "loading" ? "Refreshing…" : "Refresh analytics"}
        </button>
      </div>
      <CommerceLoadState
        label="store analytics"
        dataPresent
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={retry}
      />
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        {analyticsTiles(source.data).map((tile) => (
          <div key={tile.key} className="stat-card">
            <div className="stat-label">{tile.label}</div>
            <div className="stat-value">{tile.value}</div>
            {tile.hint ? (
              <div className="muted" style={{ fontSize: 11 }}>
                {tile.hint}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function CustomersTable({
  integrationId,
}: {
  integrationId: string;
}): ReactElement {
  const source = useCommercePage<CommerceCustomer>(
    `commerce-customers:${integrationId}`,
    (cursor) =>
      commerceApi.listCustomers(integrationId, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  if (source.data === null) {
    return (
      <CommerceLoadState
        label="customers"
        dataPresent={false}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
    );
  }
  const data = source.data;
  return (
    <section aria-label="Customers">
      <div className="commerce-subsection-toolbar">
        <p className="muted">
          {data.items.length.toLocaleString()} customer record
          {data.items.length === 1 ? "" : "s"} on this page
          {source.nextCursor ? "; more are available." : "."}
        </p>
        <CommerceRefreshAction
          label="customers"
          transport={source.transport}
          onRefresh={source.retry}
        />
      </div>
      <CommerceLoadState
        label="customers"
        dataPresent
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      <div
        className="list commerce-list commerce-customers-list"
        role="table"
        aria-label="Synced commerce customers"
        aria-rowcount={data.items.length + 1}
        tabIndex={0}
      >
        <div role="rowgroup">
          <div
            className="list-header"
            role="row"
            style={{ gridTemplateColumns: CUSTOMER_COLS }}
          >
            <div role="columnheader">Email and identifiers</div>
            <div role="columnheader">Name and tags</div>
            <div role="columnheader">Marketing</div>
            <div role="columnheader">Updated</div>
          </div>
        </div>
        <div role="rowgroup">
          {data.items.length === 0 ? (
            <div className="list-empty" role="row">
              <div className="empty-state" role="cell" aria-colspan={4}>
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>No customers synced yet</h3>
                <p>Run a sync to pull store customers into Moosewave.</p>
              </div>
            </div>
          ) : (
            data.items.map((customer) => (
              <div
                key={customer.id}
                className="list-row"
                role="row"
                style={{
                  gridTemplateColumns: CUSTOMER_COLS,
                  cursor: "default",
                }}
              >
                <div
                  role="cell"
                  className="mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>{maskedEmail(customer.email)}</span>
                  <span className="commerce-detail">
                    Customer ID: {customer.id} · Source ID: {customer.source_id}
                  </span>
                </div>
                <div
                  role="cell"
                  className="muted commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>
                    {[customer.first_name, customer.last_name]
                      .filter(Boolean)
                      .join(" ") || "Name not recorded"}
                  </span>
                  <span className="commerce-detail">
                    Tags:{" "}
                    {customer.tags.length > 0
                      ? customer.tags.join(", ")
                      : "none"}
                  </span>
                </div>
                <div role="cell" className="commerce-value">
                  <span
                    className={`badge${customer.accepts_marketing ? " success" : ""}`}
                  >
                    Store flag:{" "}
                    {customer.accepts_marketing ? "accepts" : "does not accept"}
                  </span>
                  <span className="commerce-detail">
                    Moosewave consent is not verified by this provider record.
                  </span>
                </div>
                <div
                  role="cell"
                  className="muted tabular"
                  style={{ fontSize: 12 }}
                >
                  <CommerceTime value={customer.updated_at} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <Pager
        itemCount={data.items.length}
        pageNumber={source.pageNumber}
        hasPrevious={source.hasPrevious}
        nextCursor={source.nextCursor}
        busy={source.transport === "loading"}
        onPrevious={source.previousPage}
        onNext={source.nextPage}
        label="Customers"
      />
    </section>
  );
}

function ProductsTable({
  integrationId,
  onDrill,
}: {
  integrationId: string;
  onDrill: (p: CommerceProduct, kind: ProductDrill["kind"]) => void;
}): ReactElement {
  const source = useCommercePage<CommerceProduct>(
    `commerce-products:${integrationId}`,
    (cursor) =>
      commerceApi.listProducts(integrationId, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  if (source.data === null) {
    return (
      <CommerceLoadState
        label="products"
        dataPresent={false}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
    );
  }
  const data = source.data;
  return (
    <section aria-label="Products">
      <div className="commerce-subsection-toolbar">
        <p className="muted">
          {data.items.length.toLocaleString()} product
          {data.items.length === 1 ? "" : "s"} on this page
          {source.nextCursor ? "; more are available." : "."}
        </p>
        <CommerceRefreshAction
          label="products"
          transport={source.transport}
          onRefresh={source.retry}
        />
      </div>
      <CommerceLoadState
        label="products"
        dataPresent
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      <div
        className="list commerce-list commerce-products-list"
        role="table"
        aria-label="Synced commerce products"
        aria-rowcount={data.items.length + 1}
        tabIndex={0}
      >
        <div role="rowgroup">
          <div
            className="list-header"
            role="row"
            style={{ gridTemplateColumns: PRODUCT_COLS }}
          >
            <div role="columnheader">Product and identifiers</div>
            <div role="columnheader">Price</div>
            <div role="columnheader">Updated</div>
            <div role="columnheader">Drill-downs</div>
          </div>
        </div>
        <div role="rowgroup">
          {data.items.length === 0 ? (
            <div className="list-empty" role="row">
              <div className="empty-state" role="cell" aria-colspan={4}>
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>No products synced yet</h3>
                <p>
                  Run a sync to pull the store&apos;s products into Moosewave.
                </p>
              </div>
            </div>
          ) : (
            data.items.map((product) => (
              <div
                key={product.id}
                className="list-row"
                role="row"
                style={{ gridTemplateColumns: PRODUCT_COLS, cursor: "default" }}
              >
                <div
                  role="cell"
                  className="commerce-value"
                  style={{ fontWeight: 500 }}
                >
                  <span>{product.title}</span>
                  <span className="commerce-detail mono">
                    Product ID: {product.id} · Source ID: {product.source_id}
                  </span>
                </div>
                <div role="cell" className="tabular" style={{ fontSize: 12 }}>
                  {fmtCents(product.price_cents, product.currency)}
                </div>
                <div
                  role="cell"
                  className="muted tabular"
                  style={{ fontSize: 12 }}
                >
                  <CommerceTime value={product.updated_at} />
                </div>
                <div role="cell" className="commerce-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label={`View variants for ${product.title}`}
                    onClick={() => onDrill(product, "variants")}
                  >
                    Variants
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label={`View inventory for ${product.title}`}
                    onClick={() => onDrill(product, "inventory")}
                  >
                    Inventory
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label={`View price history for ${product.title}`}
                    onClick={() => onDrill(product, "price-history")}
                  >
                    Prices
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <Pager
        itemCount={data.items.length}
        pageNumber={source.pageNumber}
        hasPrevious={source.hasPrevious}
        nextCursor={source.nextCursor}
        busy={source.transport === "loading"}
        onPrevious={source.previousPage}
        onNext={source.nextPage}
        label="Products"
      />
    </section>
  );
}

const VARIANT_COLS = "1.6fr 1fr 110px 110px 110px";

function VariantsModal({
  integrationId,
  product,
  returnFocusRef,
  onClose,
}: {
  integrationId: string;
  product: CommerceProduct;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): ReactElement {
  const source = useCommercePage<CommerceProductVariant>(
    `commerce-variants:${integrationId}:${product.id}`,
    (cursor) =>
      commerceApi.listProductVariants(integrationId, product.id, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
      title={`Variants — ${product.title}`}
      description="Every variant Moosewave has synced for this product, with price and stock state."
    >
      <CommerceLoadState
        label="variants"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data === null ? null : data.items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No variants synced for this product.
        </p>
      ) : (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} variant
              {data.items.length === 1 ? "" : "s"} on this page
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <CommerceRefreshAction
              label="variants"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-variants-list"
            role="table"
            aria-label={`Variants for ${product.title}`}
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: VARIANT_COLS }}
              >
                <div role="columnheader">Variant and identifiers</div>
                <div role="columnheader">SKU and options</div>
                <div role="columnheader">Price</div>
                <div role="columnheader">Stock</div>
                <div role="columnheader">Availability</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.map((variant) => (
                <div
                  key={variant.id}
                  className="list-row"
                  role="row"
                  style={{
                    gridTemplateColumns: VARIANT_COLS,
                    cursor: "default",
                  }}
                >
                  <div role="cell" className="commerce-value">
                    <span>{variant.title || "Untitled variant"}</span>
                    <span className="commerce-detail mono">
                      Variant ID: {variant.id} · Source ID: {variant.source_id}
                    </span>
                  </div>
                  <div
                    role="cell"
                    className="mono muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>{variant.sku || "SKU not recorded"}</span>
                    <span className="commerce-detail">
                      Options: {formatCommerceRecord(variant.option_values)}
                    </span>
                  </div>
                  <div
                    role="cell"
                    className="tabular commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>
                      {fmtCents(variant.price_cents, variant.currency)}
                    </span>
                    <span className="commerce-detail">
                      Compare at:{" "}
                      {variant.compare_at_price_cents == null
                        ? "not recorded"
                        : fmtCents(
                            variant.compare_at_price_cents,
                            variant.currency,
                          )}
                    </span>
                  </div>
                  <div
                    role="cell"
                    className="tabular muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>{variant.inventory_quantity ?? "Not recorded"}</span>
                    <span className="commerce-detail">
                      Policy: {variant.inventory_policy || "not recorded"}
                    </span>
                  </div>
                  <div role="cell">
                    {variant.available ? (
                      <span className="badge success">In stock</span>
                    ) : (
                      <span className="badge">Out of stock</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Variants"
          />
        </>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- orders + events (per-integration, #33b) ---------- */

function OrdersTable({
  integrationId,
}: {
  integrationId: string;
}): ReactElement {
  const source = useCommercePage<CommerceOrder>(
    `commerce-orders:${integrationId}`,
    (cursor) =>
      commerceApi.listOrders(integrationId, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  if (source.data === null) {
    return (
      <CommerceLoadState
        label="orders"
        dataPresent={false}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
    );
  }
  const data = source.data;
  return (
    <section aria-label="Orders">
      <div className="commerce-subsection-toolbar">
        <p className="muted">
          {data.items.length.toLocaleString()} order
          {data.items.length === 1 ? "" : "s"} on this page
          {source.nextCursor ? "; more are available." : "."}
        </p>
        <CommerceRefreshAction
          label="orders"
          transport={source.transport}
          onRefresh={source.retry}
        />
      </div>
      <CommerceLoadState
        label="orders"
        dataPresent
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      <div
        className="list commerce-list commerce-orders-list"
        role="table"
        aria-label="Synced commerce orders"
        aria-rowcount={data.items.length + 1}
        tabIndex={0}
      >
        <div role="rowgroup">
          <div
            className="list-header"
            role="row"
            style={{ gridTemplateColumns: ORDER_COLS }}
          >
            <div role="columnheader">Order identifiers</div>
            <div role="columnheader">Customer and campaign</div>
            <div role="columnheader">Status</div>
            <div role="columnheader">Money</div>
            <div role="columnheader">Ordered</div>
          </div>
        </div>
        <div role="rowgroup">
          {data.items.length === 0 ? (
            <div className="list-empty" role="row">
              <div className="empty-state" role="cell" aria-colspan={5}>
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>No orders synced yet</h3>
                <p>Run a sync to pull the store&apos;s orders into Moosewave.</p>
              </div>
            </div>
          ) : (
            data.items.map((order) => (
              <div
                key={order.id}
                className="list-row"
                role="row"
                style={{ gridTemplateColumns: ORDER_COLS, cursor: "default" }}
              >
                <div
                  role="cell"
                  className="mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>Source ID: {order.source_id}</span>
                  <span className="commerce-detail">Order ID: {order.id}</span>
                </div>
                <div
                  role="cell"
                  className="muted mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>{order.customer_email || "Customer not recorded"}</span>
                  <span className="commerce-detail">
                    Campaign ID: {order.campaign_id || "not attributed"}
                  </span>
                </div>
                <div role="cell">
                  <span className="badge">{order.status || "Unknown"}</span>
                </div>
                <div
                  role="cell"
                  className="tabular commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>
                    Total: {fmtCents(order.total_cents, order.currency)}
                  </span>
                  <span className="commerce-detail">
                    Subtotal {fmtCents(order.subtotal_cents, order.currency)} ·
                    Discount {fmtCents(order.discount_cents, order.currency)} ·
                    Shipping {fmtCents(order.shipping_cents, order.currency)} ·
                    Tax {fmtCents(order.tax_cents, order.currency)}
                  </span>
                </div>
                <div
                  role="cell"
                  className="muted tabular"
                  style={{ fontSize: 12 }}
                >
                  <CommerceTime value={order.ordered_at} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <Pager
        itemCount={data.items.length}
        pageNumber={source.pageNumber}
        hasPrevious={source.hasPrevious}
        nextCursor={source.nextCursor}
        busy={source.transport === "loading"}
        onPrevious={source.previousPage}
        onNext={source.nextPage}
        label="Orders"
      />
    </section>
  );
}

function EventsTable({
  integrationId,
}: {
  integrationId: string;
}): ReactElement {
  const source = useCommercePage<CommerceEventRow>(
    `commerce-events:${integrationId}`,
    (cursor) =>
      commerceApi.listEvents(integrationId, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  if (source.data === null) {
    return (
      <CommerceLoadState
        label="events"
        dataPresent={false}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
    );
  }
  const data = source.data;
  return (
    <section aria-label="Events">
      <div className="commerce-subsection-toolbar">
        <p className="muted">
          {data.items.length.toLocaleString()} commerce event
          {data.items.length === 1 ? "" : "s"} on this page
          {source.nextCursor ? "; more are available." : "."}
        </p>
        <CommerceRefreshAction
          label="events"
          transport={source.transport}
          onRefresh={source.retry}
        />
      </div>
      <CommerceLoadState
        label="events"
        dataPresent
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      <div
        className="list commerce-list commerce-events-list"
        role="table"
        aria-label="Commerce event stream"
        aria-rowcount={data.items.length + 1}
        tabIndex={0}
      >
        <div role="rowgroup">
          <div
            className="list-header"
            role="row"
            style={{ gridTemplateColumns: EVENT_COLS }}
          >
            <div role="columnheader">Event and provider identifiers</div>
            <div role="columnheader">Customer</div>
            <div role="columnheader">Order</div>
            <div role="columnheader">When</div>
          </div>
        </div>
        <div role="rowgroup">
          {data.items.length === 0 ? (
            <div className="list-empty" role="row">
              <div className="empty-state" role="cell" aria-colspan={4}>
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>No events recorded yet</h3>
                <p>
                  Store webhooks and syncs append to this stream as they land.
                </p>
              </div>
            </div>
          ) : (
            data.items.map((event) => (
              <div
                key={event.id}
                className="list-row"
                role="row"
                style={{ gridTemplateColumns: EVENT_COLS, cursor: "default" }}
              >
                <div
                  role="cell"
                  className="mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  <span>{event.event_type || "Unknown event"}</span>
                  <span className="commerce-detail">
                    Event ID: {event.id} · Provider topic:{" "}
                    {event.provider_topic || "not recorded"} · Provider event
                    ID: {event.provider_event_id || "not recorded"}
                  </span>
                </div>
                <div
                  role="cell"
                  className="muted mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  {event.customer_email || "Customer not recorded"}
                </div>
                <div
                  role="cell"
                  className="muted mono commerce-value"
                  style={{ fontSize: 12 }}
                >
                  {event.order_id || "Order not recorded"}
                </div>
                <div
                  role="cell"
                  className="muted tabular"
                  style={{ fontSize: 12 }}
                >
                  <CommerceTime value={event.at} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <Pager
        itemCount={data.items.length}
        pageNumber={source.pageNumber}
        hasPrevious={source.hasPrevious}
        nextCursor={source.nextCursor}
        busy={source.transport === "loading"}
        onPrevious={source.previousPage}
        onNext={source.nextPage}
        label="Events"
      />
    </section>
  );
}

/* ---------- per-product drilldowns: inventory + price history (#33c) ---------- */

const INVENTORY_COLS = "170px 1fr 90px 110px 120px";

function InventoryModal({
  integrationId,
  product,
  returnFocusRef,
  onClose,
}: {
  integrationId: string;
  product: CommerceProduct;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): ReactElement {
  const source = useCommercePage<CommerceInventorySnapshot>(
    `commerce-inventory:${integrationId}:${product.id}`,
    (cursor) =>
      commerceApi.listInventorySnapshots(integrationId, product.id, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="xl"
      title={`Inventory — ${product.title}`}
      description="Stock snapshots Moosewave has observed for this product, newest first. Back-in-stock alerts key off these."
    >
      <CommerceLoadState
        label="inventory snapshots"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data === null ? null : data.items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No inventory snapshots recorded for this product.
        </p>
      ) : (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} inventory snapshot
              {data.items.length === 1 ? "" : "s"} on this page
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <CommerceRefreshAction
              label="inventory"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-inventory-list"
            role="table"
            aria-label={`Inventory history for ${product.title}`}
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: INVENTORY_COLS }}
              >
                <div role="columnheader">Observed</div>
                <div role="columnheader">Snapshot and variant IDs</div>
                <div role="columnheader" style={{ textAlign: "right" }}>
                  Quantity
                </div>
                <div role="columnheader">Availability</div>
                <div role="columnheader">Policy and source</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.map((snapshot) => (
                <div
                  key={snapshot.id}
                  className="list-row"
                  role="row"
                  style={{
                    gridTemplateColumns: INVENTORY_COLS,
                    cursor: "default",
                  }}
                >
                  <div
                    role="cell"
                    className="muted tabular"
                    style={{ fontSize: 12 }}
                  >
                    <CommerceTime value={snapshot.observed_at} />
                  </div>
                  <div
                    role="cell"
                    className="mono muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>Snapshot ID: {snapshot.id}</span>
                    <span className="commerce-detail">
                      Variant ID: {snapshot.variant_id || "product level"}
                    </span>
                  </div>
                  <div
                    role="cell"
                    className="tabular"
                    style={{ fontSize: 12, textAlign: "right" }}
                  >
                    {snapshot.quantity ?? "Not recorded"}
                  </div>
                  <div role="cell">
                    {snapshot.available ? (
                      <span className="badge success">In stock</span>
                    ) : (
                      <span className="badge">Out of stock</span>
                    )}
                  </div>
                  <div
                    role="cell"
                    className="muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>
                      {snapshot.inventory_policy || "Policy not recorded"}
                    </span>
                    <span className="commerce-detail mono">
                      Source event ID:{" "}
                      {snapshot.source_event_id || "not recorded"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Inventory snapshots"
          />
        </>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

const PRICE_COLS = "170px 1fr 120px 130px";

function PriceHistoryModal({
  integrationId,
  product,
  returnFocusRef,
  onClose,
}: {
  integrationId: string;
  product: CommerceProduct;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): ReactElement {
  const source = useCommercePage<CommercePriceHistoryPoint>(
    `commerce-price-history:${integrationId}:${product.id}`,
    (cursor) =>
      commerceApi.listPriceHistory(integrationId, product.id, {
        cursor,
        limit: PER_PAGE,
      }),
  );
  const data = source.data;

  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
      title={`Price history — ${product.title}`}
      description="Price points Moosewave has observed for this product, newest first. Price-drop watchers key off these."
    >
      <CommerceLoadState
        label="price history"
        dataPresent={data !== null}
        transport={source.transport}
        failure={source.failure}
        stale={source.stale}
        onRetry={source.retry}
      />
      {data === null ? null : data.items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No price history recorded for this product.
        </p>
      ) : (
        <>
          <div className="commerce-subsection-toolbar">
            <p className="muted">
              {data.items.length.toLocaleString()} price point
              {data.items.length === 1 ? "" : "s"} on this page
              {source.nextCursor ? "; more are available." : "."}
            </p>
            <CommerceRefreshAction
              label="price history"
              transport={source.transport}
              onRefresh={source.retry}
            />
          </div>
          <div
            className="list commerce-list commerce-price-list"
            role="table"
            aria-label={`Price history for ${product.title}`}
            aria-rowcount={data.items.length + 1}
            tabIndex={0}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: PRICE_COLS }}
              >
                <div role="columnheader">Observed</div>
                <div role="columnheader">Price point and variant IDs</div>
                <div role="columnheader">Price</div>
                <div role="columnheader">Compare at and source</div>
              </div>
            </div>
            <div role="rowgroup">
              {data.items.map((point) => (
                <div
                  key={point.id}
                  className="list-row"
                  role="row"
                  style={{ gridTemplateColumns: PRICE_COLS, cursor: "default" }}
                >
                  <div
                    role="cell"
                    className="muted tabular"
                    style={{ fontSize: 12 }}
                  >
                    <CommerceTime value={point.observed_at} />
                  </div>
                  <div
                    role="cell"
                    className="mono muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>Price point ID: {point.id}</span>
                    <span className="commerce-detail">
                      Variant ID: {point.variant_id || "product level"}
                    </span>
                  </div>
                  <div role="cell" className="tabular" style={{ fontSize: 12 }}>
                    {fmtCents(point.price_cents, point.currency)}
                  </div>
                  <div
                    role="cell"
                    className="tabular muted commerce-value"
                    style={{ fontSize: 12 }}
                  >
                    <span>
                      {point.compare_at_price_cents != null
                        ? fmtCents(point.compare_at_price_cents, point.currency)
                        : "Compare-at price not recorded"}
                    </span>
                    <span className="commerce-detail mono">
                      Source event ID: {point.source_event_id || "not recorded"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Pager
            itemCount={data.items.length}
            pageNumber={source.pageNumber}
            hasPrevious={source.hasPrevious}
            nextCursor={source.nextCursor}
            busy={source.transport === "loading"}
            onPrevious={source.previousPage}
            onNext={source.nextPage}
            label="Price history"
          />
        </>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
