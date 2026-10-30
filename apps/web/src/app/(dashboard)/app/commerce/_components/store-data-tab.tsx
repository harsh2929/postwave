// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Store data.
 *
 * The records Moosewave has synced from one connected store: an imported-record
 * analytics strip, then Customers / Products / Orders / Events as cursor-paged
 * tables, with per-product drill-downs (variants, inventory snapshots, price
 * history) in a dialog. Every route here is read:reports and nothing on the
 * tab changes store state, so there is no admin verb to withhold; the page's
 * view-only note covers the verbs elsewhere in the workspace.
 *
 * Desktop reference: apps/desktop/src/components/commerce/IntegrationBrowsePanel.tsx
 * (same views, same columns, same 25-row keyset pages).
 */

import { useId, useState, type ReactNode } from "react";
import {
  keepPreviousData,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Activity, Package, Receipt, Store, Users } from "lucide-react";

import { humanizeStatus } from "@/components/mailchimp-parity/product-panel-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import {
  commerceApi,
  commerceEventError,
  type CommerceCursorPage,
  type CommerceCustomer,
  type CommerceEventRow,
  type CommerceIntegration,
  type CommerceInventorySnapshot,
  type CommerceOrder,
  type CommercePriceHistoryPoint,
  type CommerceProduct,
  type CommerceProductVariant,
} from "@/lib/commerce-api";
import {
  analyticsTiles,
  fmtCents,
  formatCommerceRecord,
  formatCommerceTime,
  maskedEmail,
} from "@/lib/commerce-catalog-helpers";
import { STALE } from "@/lib/query-keys";

import {
  COMMERCE_PAGE_SIZE,
  commerceKeys,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import { CommerceErrorNotice, CursorPagerControls } from "./commerce-primitives";
import { useCursorPager, type CursorPager } from "./use-cursor-pager";

const STORE_VIEWS = [
  { id: "customers", label: "Customers" },
  { id: "products", label: "Products" },
  { id: "orders", label: "Orders" },
  { id: "events", label: "Events" },
] as const;
type StoreViewId = (typeof STORE_VIEWS)[number]["id"];

function isStoreViewId(value: string): value is StoreViewId {
  return STORE_VIEWS.some((view) => view.id === value);
}

/** The server's sentence, verbatim. A 404 on these routes is "integration
 *  not found" / "product not found", which is exactly what the reader needs. */
function storeDataFailureMessage(error: unknown): string {
  return apiErrorMessage(error, "The request could not be completed.");
}

function storeName(store: CommerceIntegration): string {
  return store.shop_domain || store.provider || store.id;
}

export function StoreDataTab({ ctx }: { ctx: CommerceWorkspaceContext }) {
  const id = useId();
  const storesQuery = useQuery({
    queryKey: commerceKeys.integrations(ctx.scopeKey),
    queryFn: commerceApi.integrations,
    enabled: ctx.ready,
    staleTime: STALE.list,
  });
  const stores = Array.isArray(storesQuery.data) ? storesQuery.data : [];
  const storeId = ctx.selectedStoreId;
  const selectedStore = stores.find((store) => store.id === storeId) ?? null;
  const storeLabel = selectedStore ? storeName(selectedStore) : `store ${storeId}`;
  const [view, setView] = useState<StoreViewId>("customers");

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <div className="min-w-0">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          Store data
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The customers, products, orders, and events Moosewave has synced from
          a connected store, as imported. Reading here changes nothing in the
          store.
        </p>
      </div>

      <div className="max-w-md space-y-1.5">
        <Label htmlFor={`${id}-store`}>Connected store</Label>
        <Select
          id={`${id}-store`}
          value={storeId}
          onChange={(event) => ctx.selectStore(event.target.value)}
          disabled={!ctx.ready}
        >
          <option value="">
            {storesQuery.isPending
              ? "Loading connected stores…"
              : stores.length === 0
                ? "No connected store is available"
                : "Choose a store"}
          </option>
          {stores.map((store) => (
            <option key={store.id} value={store.id}>
              {storeName(store)} · {store.provider}
            </option>
          ))}
          {storeId && !selectedStore ? (
            <option value={storeId}>Store {storeId}</option>
          ) : null}
        </Select>
        {storesQuery.isError ? (
          <p className="text-xs text-destructive-emphasis" role="alert">
            {storeDataFailureMessage(storesQuery.error)}
          </p>
        ) : null}
      </div>

      {storeId === "" ? (
        storesQuery.isSuccess && stores.length === 0 ? (
          <EmptyState
            icon={Store}
            title="No connected stores"
            description="Store data is what Moosewave has synced from a connected store. Connect Shopify above, or connect a store from the Integrations page, then come back here."
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose a store to browse its synced customers, products, orders,
            and events.
          </p>
        )
      ) : (
        <>
          <AnalyticsStrip ctx={ctx} storeId={storeId} storeLabel={storeLabel} />
          <Tabs
            value={view}
            onValueChange={(value) => {
              if (isStoreViewId(value)) setView(value);
            }}
          >
            <TabsList aria-label="Store data view">
              {STORE_VIEWS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="customers" className="mt-4">
              <CustomersView ctx={ctx} storeId={storeId} storeLabel={storeLabel} />
            </TabsContent>
            <TabsContent value="products" className="mt-4">
              <ProductsView ctx={ctx} storeId={storeId} storeLabel={storeLabel} />
            </TabsContent>
            <TabsContent value="orders" className="mt-4">
              <OrdersView ctx={ctx} storeId={storeId} storeLabel={storeLabel} />
            </TabsContent>
            <TabsContent value="events" className="mt-4">
              <EventsView ctx={ctx} storeId={storeId} storeLabel={storeLabel} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}

/* ---------- analytics strip (commerce-8) ---------- */

interface StoreProps {
  ctx: CommerceWorkspaceContext;
  storeId: string;
  storeLabel: string;
}

function AnalyticsStrip({ ctx, storeId, storeLabel }: StoreProps) {
  const id = useId();
  const query = useQuery({
    queryKey: commerceKeys.storeAnalytics(ctx.scopeKey, storeId),
    queryFn: () => commerceApi.analytics(storeId),
    enabled: ctx.ready && storeId !== "",
    staleTime: STALE.detail,
  });
  const analytics = query.data ?? null;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="space-y-3 rounded-md border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={`${id}-heading`} className="text-sm font-semibold">
            Store analytics — {storeLabel}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Imported-record aggregate. Reporting window, generation time, and
            currency-mix provenance are unavailable from this response.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          loading={Boolean(analytics) && query.isFetching}
        >
          Refresh analytics
        </Button>
      </div>

      {query.isError ? (
        <CommerceErrorNotice
          error={query.error}
          label="store analytics"
          stale={Boolean(analytics)}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
          describe={storeDataFailureMessage}
        />
      ) : null}

      {analytics ? (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {analyticsTiles(analytics).map((tile) => (
            <div
              key={tile.key}
              className="rounded-md border border-border bg-background p-3"
            >
              <dt className="text-xs text-muted-foreground">{tile.label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {tile.value}
              </dd>
              {tile.hint ? (
                <dd className="mt-0.5 text-xs text-muted-foreground">
                  {tile.hint}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : query.isPending ? (
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          aria-busy="true"
          aria-label="Loading store analytics"
        >
          {[0, 1, 2, 3, 4].map((slot) => (
            <Skeleton key={slot} className="h-16 w-full" />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* ---------- cursor-paged records (commerce-7) ---------- */

interface PagedRecords<T> {
  pager: CursorPager;
  query: UseQueryResult<CommerceCursorPage<T>>;
}

function usePagedRecords<T>({
  identity,
  queryKey,
  enabled,
  load,
}: {
  identity: string;
  queryKey: (cursor: string | undefined) => readonly unknown[];
  enabled: boolean;
  load: (cursor: string | undefined) => Promise<CommerceCursorPage<T>>;
}): PagedRecords<T> {
  const pager = useCursorPager(identity);
  const query = useQuery({
    queryKey: queryKey(pager.cursor),
    queryFn: () => load(pager.cursor),
    enabled,
    staleTime: STALE.list,
    placeholderData: keepPreviousData,
  });
  return { pager, query };
}

function useStoreRecords<T>(
  ctx: CommerceWorkspaceContext,
  storeId: string,
  view: StoreViewId,
  load: (cursor: string | undefined) => Promise<CommerceCursorPage<T>>,
): PagedRecords<T> {
  return usePagedRecords<T>({
    identity: `store:${storeId}:${view}:${JSON.stringify(ctx.scopeKey)}`,
    queryKey: (cursor) =>
      commerceKeys.storeRecords(ctx.scopeKey, storeId, view, cursor),
    enabled: ctx.ready && storeId !== "",
    load,
  });
}

/**
 * One paged table: refresh, the server's failure sentence, skeleton, empty
 * state, rows, and the Prev/Next pager. Callers supply the columns.
 */
function RecordsShell<T>({
  label,
  tableLabel,
  empty,
  records,
  head,
  keyOf,
  renderRow,
}: {
  /** Title-case noun for the pager ("Customers" → "Next page of customers"). */
  label: string;
  tableLabel: string;
  empty: ReactNode;
  records: PagedRecords<T>;
  head: ReactNode;
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  const { pager, query } = records;
  const page = query.data;
  const items = Array.isArray(page?.items) ? page.items : [];
  const nextCursor =
    typeof page?.next_cursor === "string" && page.next_cursor
      ? page.next_cursor
      : null;
  const loading = query.isPending && !page;
  const noun = label.toLowerCase();

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          loading={Boolean(page) && query.isFetching}
        >
          Refresh {noun}
        </Button>
      </div>

      {query.isError ? (
        <CommerceErrorNotice
          error={query.error}
          label={noun}
          stale={Boolean(page)}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
          describe={storeDataFailureMessage}
        />
      ) : null}

      {loading ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${noun}`}
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : page ? (
        items.length === 0 ? (
          empty
        ) : (
          <TableContainer aria-label={tableLabel}>
            <Table>
              <TableHeader>
                <TableRow>{head}</TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={keyOf(item)}>{renderRow(item)}</TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )
      ) : null}

      {page ? (
        <CursorPagerControls
          pager={pager}
          itemCount={items.length}
          nextCursor={nextCursor}
          busy={query.isFetching}
          label={label}
        />
      ) : null}
    </div>
  );
}

function Identifiers({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}

function CustomersView({ ctx, storeId, storeLabel }: StoreProps) {
  const records = useStoreRecords<CommerceCustomer>(
    ctx,
    storeId,
    "customers",
    (cursor) =>
      commerceApi.listCustomers(storeId, { limit: COMMERCE_PAGE_SIZE, cursor }),
  );
  return (
    <RecordsShell
      label="Customers"
      tableLabel={`Synced customers for ${storeLabel}`}
      records={records}
      keyOf={(customer) => customer.id}
      empty={
        <EmptyState
          icon={Users}
          title="No customers synced yet"
          description="Run a sync to pull store customers into Moosewave."
        />
      }
      head={
        <>
          <TableHead>Email and identifiers</TableHead>
          <TableHead>Name and tags</TableHead>
          <TableHead>Marketing</TableHead>
          <TableHead>Updated</TableHead>
        </>
      }
      renderRow={(customer) => (
        <>
          <TableCell className="align-top">
            <div className="font-mono text-xs">{maskedEmail(customer.email)}</div>
            <Identifiers>
              Customer ID: {customer.id} · Source ID: {customer.source_id}
            </Identifiers>
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground">
            <div className="text-foreground">
              {[customer.first_name, customer.last_name]
                .filter(Boolean)
                .join(" ") || "Name not recorded"}
            </div>
            <div>
              Tags:{" "}
              {Array.isArray(customer.tags) && customer.tags.length > 0
                ? customer.tags.join(", ")
                : "none"}
            </div>
          </TableCell>
          <TableCell className="align-top">
            <Badge variant={customer.accepts_marketing ? "success" : "secondary"}>
              Store flag:{" "}
              {customer.accepts_marketing ? "accepts" : "does not accept"}
            </Badge>
            <div className="mt-1 text-xs text-muted-foreground">
              Moosewave consent is not verified by this provider record.
            </div>
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            {formatCommerceTime(customer.updated_at)}
          </TableCell>
        </>
      )}
    />
  );
}

type DrillKind = "variants" | "inventory" | "price-history";

function ProductsView({ ctx, storeId, storeLabel }: StoreProps) {
  const records = useStoreRecords<CommerceProduct>(
    ctx,
    storeId,
    "products",
    (cursor) =>
      commerceApi.listProducts(storeId, { limit: COMMERCE_PAGE_SIZE, cursor }),
  );
  const [drill, setDrill] = useState<{
    product: CommerceProduct;
    kind: DrillKind;
  } | null>(null);

  return (
    <>
      <RecordsShell
        label="Products"
        tableLabel={`Synced products for ${storeLabel}`}
        records={records}
        keyOf={(product) => product.id}
        empty={
          <EmptyState
            icon={Package}
            title="No products synced yet"
            description="Run a sync to pull the store's products into Moosewave."
          />
        }
        head={
          <>
            <TableHead>Product and identifiers</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>
              <span className="sr-only">Drill-downs</span>
            </TableHead>
          </>
        }
        renderRow={(product) => {
          const title = product.title || "Untitled product";
          return (
            <>
              <TableCell className="align-top">
                <div className="font-medium">{title}</div>
                <Identifiers>
                  Product ID: {product.id} · Source ID: {product.source_id}
                </Identifiers>
              </TableCell>
              <TableCell className="align-top text-xs tabular-nums">
                {fmtCents(product.price_cents, product.currency)}
              </TableCell>
              <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                {formatCommerceTime(product.updated_at)}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`View variants for ${title}`}
                    onClick={() => setDrill({ product, kind: "variants" })}
                  >
                    Variants
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`View inventory for ${title}`}
                    onClick={() => setDrill({ product, kind: "inventory" })}
                  >
                    Inventory
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`View price history for ${title}`}
                    onClick={() => setDrill({ product, kind: "price-history" })}
                  >
                    Prices
                  </Button>
                </div>
              </TableCell>
            </>
          );
        }}
      />
      {drill ? (
        <ProductDrilldownDialog
          ctx={ctx}
          storeId={storeId}
          product={drill.product}
          kind={drill.kind}
          onClose={() => setDrill(null)}
        />
      ) : null}
    </>
  );
}

function OrdersView({ ctx, storeId, storeLabel }: StoreProps) {
  const records = useStoreRecords<CommerceOrder>(
    ctx,
    storeId,
    "orders",
    (cursor) =>
      commerceApi.listOrders(storeId, { limit: COMMERCE_PAGE_SIZE, cursor }),
  );
  return (
    <RecordsShell
      label="Orders"
      tableLabel={`Synced orders for ${storeLabel}`}
      records={records}
      keyOf={(order) => order.id}
      empty={
        <EmptyState
          icon={Receipt}
          title="No orders synced yet"
          description="Run a sync to pull the store's orders into Moosewave."
        />
      }
      head={
        <>
          <TableHead>Order identifiers</TableHead>
          <TableHead>Customer and campaign</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Money</TableHead>
          <TableHead>Ordered</TableHead>
        </>
      }
      renderRow={(order) => (
        <>
          <TableCell className="align-top">
            <div className="break-all font-mono text-xs">
              Source ID: {order.source_id}
            </div>
            <Identifiers>Order ID: {order.id}</Identifiers>
          </TableCell>
          <TableCell className="align-top text-xs">
            <div className="break-all font-mono">
              {order.customer_email || "Customer not recorded"}
            </div>
            <Identifiers>
              Campaign ID: {order.campaign_id || "not attributed"}
            </Identifiers>
          </TableCell>
          <TableCell className="align-top">
            <Badge variant="secondary">
              {order.status ? humanizeStatus(order.status) : "Unknown"}
            </Badge>
          </TableCell>
          <TableCell className="align-top text-xs tabular-nums">
            <div>Total: {fmtCents(order.total_cents, order.currency)}</div>
            <div className="mt-1 text-muted-foreground">
              Subtotal {fmtCents(order.subtotal_cents, order.currency)} ·
              Discount {fmtCents(order.discount_cents, order.currency)} ·
              Shipping {fmtCents(order.shipping_cents, order.currency)} · Tax{" "}
              {fmtCents(order.tax_cents, order.currency)}
            </div>
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            {formatCommerceTime(order.ordered_at)}
          </TableCell>
        </>
      )}
    />
  );
}

function EventsView({ ctx, storeId, storeLabel }: StoreProps) {
  const records = useStoreRecords<CommerceEventRow>(
    ctx,
    storeId,
    "events",
    (cursor) =>
      commerceApi.events(storeId, { limit: COMMERCE_PAGE_SIZE, cursor }),
  );
  return (
    <RecordsShell
      label="Events"
      tableLabel={`Commerce event stream for ${storeLabel}`}
      records={records}
      keyOf={(event) => String(event.id)}
      empty={
        <EmptyState
          icon={Activity}
          title="No events recorded yet"
          description="Store webhooks and syncs append to this stream as they land."
        />
      }
      head={
        <>
          <TableHead>Event and provider identifiers</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>When</TableHead>
        </>
      }
      renderRow={(event) => {
        const failure = commerceEventError(event);
        return (
          <>
            <TableCell className="align-top">
              <div className="font-mono text-xs">
                {event.event_type || "Unknown event"}
              </div>
              <Identifiers>
                Event ID: {event.id} · Provider topic:{" "}
                {event.provider_topic || "not recorded"} · Provider event ID:{" "}
                {event.provider_event_id || "not recorded"}
              </Identifiers>
              {failure ? (
                <p className="mt-1 break-words text-xs text-destructive-emphasis">
                  {failure}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="align-top break-all font-mono text-xs text-muted-foreground">
              {event.customer_email || "Customer not recorded"}
            </TableCell>
            <TableCell className="align-top break-all font-mono text-xs text-muted-foreground">
              {event.order_id || "Order not recorded"}
            </TableCell>
            <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
              {formatCommerceTime(event.at)}
            </TableCell>
          </>
        );
      }}
    />
  );
}

/* ---------- per-product drill-downs (commerce-9/10/11) ---------- */

const DRILLS: Record<
  DrillKind,
  { title: string; label: string; description: string; empty: string }
> = {
  variants: {
    title: "Variants",
    label: "Variants",
    description:
      "Every variant Moosewave has synced for this product, with price and stock state.",
    empty: "No variants synced for this product.",
  },
  inventory: {
    title: "Inventory",
    label: "Inventory snapshots",
    description:
      "Stock snapshots Moosewave has observed for this product, newest first. Back-in-stock alerts key off these.",
    empty: "No inventory snapshots recorded for this product.",
  },
  "price-history": {
    title: "Price history",
    label: "Price history",
    description:
      "Price points Moosewave has observed for this product, newest first. Price-drop watchers key off these.",
    empty: "No price history recorded for this product.",
  },
};

interface DrillProps {
  ctx: CommerceWorkspaceContext;
  storeId: string;
  product: CommerceProduct;
}

function useProductDrill<T>(
  { ctx, storeId, product }: DrillProps,
  kind: DrillKind,
  load: (cursor: string | undefined) => Promise<CommerceCursorPage<T>>,
): PagedRecords<T> {
  return usePagedRecords<T>({
    identity: `drill:${storeId}:${product.id}:${kind}:${JSON.stringify(ctx.scopeKey)}`,
    queryKey: (cursor) =>
      commerceKeys.productDrill(ctx.scopeKey, storeId, product.id, kind, cursor),
    enabled: ctx.ready,
    load,
  });
}

function DrillEmpty({ kind }: { kind: DrillKind }) {
  return <p className="text-sm text-muted-foreground">{DRILLS[kind].empty}</p>;
}

function ProductDrilldownDialog({
  kind,
  onClose,
  ...drill
}: DrillProps & { kind: DrillKind; onClose: () => void }) {
  const meta = DRILLS[kind];
  const title = drill.product.title || "Untitled product";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {meta.title} — {title}
          </DialogTitle>
          <DialogDescription>{meta.description}</DialogDescription>
        </DialogHeader>
        {kind === "variants" ? (
          <VariantsDrill {...drill} />
        ) : kind === "inventory" ? (
          <InventoryDrill {...drill} />
        ) : (
          <PriceHistoryDrill {...drill} />
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AvailabilityBadge({ available }: { available: boolean }) {
  return (
    <Badge variant={available ? "success" : "secondary"}>
      {available ? "In stock" : "Out of stock"}
    </Badge>
  );
}

function VariantsDrill(props: DrillProps) {
  const { storeId, product } = props;
  const records = useProductDrill<CommerceProductVariant>(
    props,
    "variants",
    (cursor) =>
      commerceApi.listProductVariants(storeId, product.id, {
        limit: COMMERCE_PAGE_SIZE,
        cursor,
      }),
  );
  return (
    <RecordsShell
      label={DRILLS.variants.label}
      tableLabel={`Variants for ${product.title}`}
      records={records}
      keyOf={(variant) => variant.id}
      empty={<DrillEmpty kind="variants" />}
      head={
        <>
          <TableHead>Variant and identifiers</TableHead>
          <TableHead>SKU and options</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Stock</TableHead>
          <TableHead>Availability</TableHead>
        </>
      }
      renderRow={(variant) => (
        <>
          <TableCell className="align-top">
            <div className="font-medium">{variant.title || "Untitled variant"}</div>
            <Identifiers>
              Variant ID: {variant.id} · Source ID: {variant.source_id}
            </Identifiers>
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground">
            <div className="font-mono text-foreground">
              {variant.sku || "SKU not recorded"}
            </div>
            <div>Options: {formatCommerceRecord(variant.option_values)}</div>
          </TableCell>
          <TableCell className="align-top text-xs tabular-nums">
            <div>{fmtCents(variant.price_cents, variant.currency)}</div>
            <div className="text-muted-foreground">
              Compare at:{" "}
              {variant.compare_at_price_cents == null
                ? "not recorded"
                : fmtCents(variant.compare_at_price_cents, variant.currency)}
            </div>
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            <div className="text-foreground">
              {variant.inventory_quantity ?? "Not recorded"}
            </div>
            <div>Policy: {variant.inventory_policy || "not recorded"}</div>
          </TableCell>
          <TableCell className="align-top">
            <AvailabilityBadge available={variant.available} />
          </TableCell>
        </>
      )}
    />
  );
}

function InventoryDrill(props: DrillProps) {
  const { storeId, product } = props;
  const records = useProductDrill<CommerceInventorySnapshot>(
    props,
    "inventory",
    (cursor) =>
      commerceApi.listInventorySnapshots(storeId, product.id, {
        limit: COMMERCE_PAGE_SIZE,
        cursor,
      }),
  );
  return (
    <RecordsShell
      label={DRILLS.inventory.label}
      tableLabel={`Inventory history for ${product.title}`}
      records={records}
      keyOf={(snapshot) => snapshot.id}
      empty={<DrillEmpty kind="inventory" />}
      head={
        <>
          <TableHead>Observed</TableHead>
          <TableHead>Snapshot and variant IDs</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead>Availability</TableHead>
          <TableHead>Policy and source</TableHead>
        </>
      }
      renderRow={(snapshot) => (
        <>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            {formatCommerceTime(snapshot.observed_at)}
          </TableCell>
          <TableCell className="align-top">
            <div className="break-all font-mono text-xs">
              Snapshot ID: {snapshot.id}
            </div>
            <Identifiers>
              Variant ID: {snapshot.variant_id || "product level"}
            </Identifiers>
          </TableCell>
          <TableCell className="align-top text-xs tabular-nums">
            {snapshot.quantity ?? "Not recorded"}
          </TableCell>
          <TableCell className="align-top">
            <AvailabilityBadge available={snapshot.available} />
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground">
            <div className="text-foreground">
              {snapshot.inventory_policy || "Policy not recorded"}
            </div>
            <Identifiers>
              Source event ID: {snapshot.source_event_id || "not recorded"}
            </Identifiers>
          </TableCell>
        </>
      )}
    />
  );
}

function PriceHistoryDrill(props: DrillProps) {
  const { storeId, product } = props;
  const records = useProductDrill<CommercePriceHistoryPoint>(
    props,
    "price-history",
    (cursor) =>
      commerceApi.listPriceHistory(storeId, product.id, {
        limit: COMMERCE_PAGE_SIZE,
        cursor,
      }),
  );
  return (
    <RecordsShell
      label={DRILLS["price-history"].label}
      tableLabel={`Price history for ${product.title}`}
      records={records}
      keyOf={(point) => point.id}
      empty={<DrillEmpty kind="price-history" />}
      head={
        <>
          <TableHead>Observed</TableHead>
          <TableHead>Price point and variant IDs</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Compare at and source</TableHead>
        </>
      }
      renderRow={(point) => (
        <>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            {formatCommerceTime(point.observed_at)}
          </TableCell>
          <TableCell className="align-top">
            <div className="break-all font-mono text-xs">
              Price point ID: {point.id}
            </div>
            <Identifiers>
              Variant ID: {point.variant_id || "product level"}
            </Identifiers>
          </TableCell>
          <TableCell className="align-top text-xs tabular-nums">
            {fmtCents(point.price_cents, point.currency)}
          </TableCell>
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            <div className="text-foreground">
              {point.compare_at_price_cents != null
                ? fmtCents(point.compare_at_price_cents, point.currency)
                : "Compare-at price not recorded"}
            </div>
            <Identifiers>
              Source event ID: {point.source_event_id || "not recorded"}
            </Identifiers>
          </TableCell>
        </>
      )}
    />
  );
}
