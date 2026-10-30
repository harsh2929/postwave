// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Recovery & alerts.
 *
 * Three record kinds against one selected store, each a cursor-paged list
 * with a status filter and an admin-only create:
 *   - Cart-recovery links (list + upsert)
 *   - Back-in-stock subscriptions (list + create, nested under the product)
 *   - Price-drop watchers (list + create, same nesting)
 *
 * The lists are review evidence: a record here is what an automation may
 * later act on, not proof that any message was queued, sent, or delivered.
 */

import { useId, useState, type ReactNode } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Bell, LifeBuoy, Plus, ShoppingCart, TrendingDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { humanizeStatus } from "@/components/mailchimp-parity/product-panel-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
import {
  commerceApi,
  type CommerceBackInStockSubscription,
  type CommerceCartRecoveryLink,
  type CommerceCursorPage,
  type CommercePriceDropWatcher,
  type CommerceStatusQuery,
} from "@/lib/commerce-api";
import { fmtCents, formatCommerceTime } from "@/lib/commerce-catalog-helpers";
import {
  BACK_IN_STOCK_STATUSES,
  CART_RECOVERY_STATUSES,
  maskedEmail,
  PRICE_DROP_STATUSES,
  recoveryStatusVariant,
  recoveryUrlOrigin,
} from "@/lib/commerce-lifecycle-helpers";
import { STALE } from "@/lib/query-keys";

import {
  COMMERCE_PAGE_SIZE,
  commerceKeys,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import {
  CommerceErrorNotice,
  CursorPagerControls,
} from "./commerce-primitives";
import {
  CartLinkCreateDialog,
  ProductSubscriptionDialog,
} from "./recovery-dialogs";
import {
  StoreScopeSelect,
  storeRouteFailureMessage,
  useStoreScope,
} from "./store-scope";
import { useCursorPager } from "./use-cursor-pager";

const RECOVERY_VIEWS = [
  { id: "carts", label: "Abandoned carts" },
  { id: "stock", label: "Back in stock" },
  { id: "price", label: "Price drops" },
] as const;
type RecoveryView = (typeof RECOVERY_VIEWS)[number]["id"];

function isRecoveryView(value: string): value is RecoveryView {
  return RECOVERY_VIEWS.some((view) => view.id === value);
}

export function RecoveryTab({ ctx }: { ctx: CommerceWorkspaceContext }) {
  const id = useId();
  const scope = useStoreScope(ctx);
  const [view, setView] = useState<RecoveryView>("carts");
  const stores = scope.integrations;

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <div className="min-w-0">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          Recovery &amp; alerts
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cart-recovery links, back-in-stock subscriptions, and price-drop
          watchers for one connected store. These are records an automation may
          act on; nothing here is evidence that a message was sent.
        </p>
      </div>

      <StoreScopeSelect
        id={`${id}-store`}
        scope={scope}
        disabled={!ctx.ready}
        help="Switching stores replaces the records in view; it never creates or updates a record."
      />

      {scope.query.isError ? (
        <CommerceErrorNotice
          error={scope.query.error}
          label="connected stores"
          stale={stores !== null}
          retrying={scope.query.isFetching}
          onRetry={() => void scope.query.refetch()}
          describe={storeRouteFailureMessage}
        />
      ) : null}

      {stores === null ? (
        scope.query.isError ? null : (
          <div
            className="space-y-3"
            aria-busy="true"
            aria-label="Loading connected stores"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )
      ) : stores.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title="Recovery & alerts need a store integration"
          description="Cart-recovery links, back-in-stock subscriptions, and price-drop watchers all hang off a connected store. Connect one first — Connect Shopify above, or the Integrations page."
        />
      ) : (
        <Tabs
          value={view}
          onValueChange={(value) => {
            if (isRecoveryView(value)) setView(value);
          }}
        >
          <TabsList aria-label="Recovery record type">
            {RECOVERY_VIEWS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="carts" className="mt-4">
            <CartRecoverySection ctx={ctx} integrationId={scope.selectedId} />
          </TabsContent>
          <TabsContent value="stock" className="mt-4">
            <BackInStockSection ctx={ctx} integrationId={scope.selectedId} />
          </TabsContent>
          <TabsContent value="price" className="mt-4">
            <PriceDropSection ctx={ctx} integrationId={scope.selectedId} />
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}

/* ---------- status filter ---------- */

function StatusFilter({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: string;
  options: readonly string[];
  onChange: (status: string) => void;
}) {
  return (
    <div role="group" aria-label={legend} className="flex flex-wrap gap-1">
      {["", ...options].map((status) => {
        const active = value === status;
        return (
          <Button
            key={status || "all"}
            type="button"
            size="sm"
            variant={active ? "secondary" : "ghost"}
            aria-pressed={active}
            onClick={() => onChange(status)}
          >
            {status ? humanizeStatus(status) : "All"}
          </Button>
        );
      })}
    </div>
  );
}

/* ---------- one record kind: filtered, cursor-paged list + admin create ---------- */

interface RecoverySectionProps<T extends { id: string }> {
  ctx: CommerceWorkspaceContext;
  integrationId: string;
  /** Route segment; also the query-key segment and the pager identity. */
  kind: string;
  icon: LucideIcon;
  title: string;
  description: string;
  /** Lower-case plural for notices, the filter legend, and the refresh verb. */
  label: string;
  /** Capitalized plural for the pager's accessible names. */
  pagerLabel: string;
  statuses: readonly string[];
  columns: readonly string[];
  list: (
    integrationId: string,
    query: CommerceStatusQuery,
  ) => Promise<CommerceCursorPage<T>>;
  renderRow: (item: T) => ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  createLabel: string;
  renderCreateDialog: (props: {
    integrationId: string;
    onClose: () => void;
    onCreated: () => void;
  }) => ReactNode;
}

function RecoverySection<T extends { id: string }>({
  ctx,
  integrationId,
  kind,
  icon,
  title,
  description,
  label,
  pagerLabel,
  statuses,
  columns,
  list,
  renderRow,
  emptyTitle,
  emptyDescription,
  createLabel,
  renderCreateDialog,
}: RecoverySectionProps<T>) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const pager = useCursorPager(
    `${kind}:${integrationId}:${status || "all"}:${JSON.stringify(ctx.scopeKey)}`,
  );
  const listQuery = useQuery({
    queryKey: commerceKeys.recoveryRecords(
      ctx.scopeKey,
      integrationId,
      kind,
      status,
      pager.cursor,
    ),
    queryFn: () =>
      list(integrationId, {
        status: status || undefined,
        limit: COMMERCE_PAGE_SIZE,
        cursor: pager.cursor,
      }),
    enabled: ctx.ready && integrationId !== "",
    staleTime: STALE.list,
    placeholderData: keepPreviousData,
  });

  const page = listQuery.data;
  const items = Array.isArray(page?.items) ? page.items : [];
  const nextCursor =
    typeof page?.next_cursor === "string" && page.next_cursor
      ? page.next_cursor
      : null;
  const loading = !ctx.ready || (listQuery.isPending && !page);
  const invalidateLists = () =>
    queryClient.invalidateQueries({
      queryKey: commerceKeys.recoveryRecordsRoot(
        ctx.scopeKey,
        integrationId,
        kind,
      ),
    });

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={headingId} className="text-base font-semibold">
            {title}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
            loading={Boolean(page) && listQuery.isFetching}
          >
            Refresh {label}
          </Button>
          {ctx.canAdmin ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              {createLabel}
            </Button>
          ) : null}
        </div>
      </div>

      <StatusFilter
        legend={`Filter ${label} by status`}
        value={status}
        options={statuses}
        onChange={(next) => {
          pager.reset();
          setStatus(next);
        }}
      />

      {listQuery.isError ? (
        <CommerceErrorNotice
          error={listQuery.error}
          label={label}
          stale={Boolean(page)}
          retrying={listQuery.isFetching}
          onRetry={() => void listQuery.refetch()}
          describe={storeRouteFailureMessage}
        />
      ) : null}

      {loading ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${label}`}
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : page ? (
        items.length === 0 ? (
          <EmptyState
            icon={icon}
            title={
              status
                ? `${emptyTitle} with status “${humanizeStatus(status)}”`
                : emptyTitle
            }
            description={emptyDescription}
          />
        ) : (
          <TableContainer aria-label={pagerLabel}>
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column}>{column}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>{renderRow(item)}</TableRow>
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
          busy={listQuery.isFetching}
          label={pagerLabel}
        />
      ) : null}

      {createOpen
        ? renderCreateDialog({
            integrationId,
            onClose: () => setCreateOpen(false),
            onCreated: () => {
              pager.reset();
              void invalidateLists();
            },
          })
        : null}
    </section>
  );
}

/* ---------- shared cells ---------- */

function IdentityCell({
  primary,
  detail,
}: {
  primary: string;
  detail: string;
}) {
  return (
    <TableCell className="align-top">
      <div className="font-medium">{primary}</div>
      <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
        {detail}
      </div>
    </TableCell>
  );
}

function ProductCell({
  productId,
  variantId,
}: {
  productId: string;
  variantId?: string;
}) {
  return (
    <TableCell className="align-top break-all font-mono text-[11px] text-muted-foreground">
      <div className="text-foreground">Product {productId}</div>
      <div>Variant {variantId || "product level"}</div>
    </TableCell>
  );
}

function StatusCell({ status }: { status: string }) {
  return (
    <TableCell className="align-top">
      <Badge variant={recoveryStatusVariant(status)}>
        {status ? humanizeStatus(status) : "Unknown"}
      </Badge>
    </TableCell>
  );
}

function TimesCell({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string | null | undefined]>;
}) {
  return (
    <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
      {entries.map(([name, value]) => (
        <div key={name}>
          {name} {formatCommerceTime(value)}
        </div>
      ))}
    </TableCell>
  );
}

/* ---------- cart-recovery links (commerce-19 / commerce-20) ---------- */

function CartRecoverySection({
  ctx,
  integrationId,
}: {
  ctx: CommerceWorkspaceContext;
  integrationId: string;
}) {
  return (
    <RecoverySection<CommerceCartRecoveryLink>
      ctx={ctx}
      integrationId={integrationId}
      kind="cart-recovery-links"
      icon={ShoppingCart}
      title="Cart-recovery links"
      description="Per-cart resume URLs for abandoned-cart emails. Automations insert them into recovery sends."
      label="cart-recovery links"
      pagerLabel="Cart-recovery links"
      statuses={CART_RECOVERY_STATUSES}
      columns={[
        "Customer and identifiers",
        "Recovery URL",
        "Status",
        "Lifecycle times",
      ]}
      list={commerceApi.listCartRecoveryLinks}
      renderRow={(link) => (
        <>
          <IdentityCell
            primary={maskedEmail(link.customer_email)}
            detail={`Link ${link.id} · Cart ${link.source_cart_id}`}
          />
          <TableCell className="align-top text-xs text-muted-foreground">
            <div className="break-all text-foreground">
              {recoveryUrlOrigin(link.recovery_url) ??
                "Unverified recovery URL"}
            </div>
            <div>Secure path and token hidden</div>
          </TableCell>
          <StatusCell status={link.status} />
          <TimesCell
            entries={[
              ["Expires", link.expires_at],
              ["Created", link.created_at],
              ["Updated", link.updated_at],
            ]}
          />
        </>
      )}
      emptyTitle="No cart-recovery links"
      emptyDescription={
        ctx.canAdmin
          ? "Links are usually created by the store webhook when a cart is abandoned; you can also register one manually."
          : "Links are usually created by the store webhook when a cart is abandoned."
      }
      createLabel="New link"
      renderCreateDialog={(props) => (
        <CartLinkCreateDialog ctx={ctx} {...props} />
      )}
    />
  );
}

/* ---------- back-in-stock subscriptions (commerce-21 / commerce-22) ---------- */

function BackInStockSection({
  ctx,
  integrationId,
}: {
  ctx: CommerceWorkspaceContext;
  integrationId: string;
}) {
  return (
    <RecoverySection<CommerceBackInStockSubscription>
      ctx={ctx}
      integrationId={integrationId}
      kind="back-in-stock-subscriptions"
      icon={Bell}
      title="Back-in-stock subscriptions"
      description="Subscribers waiting on a product to restock. The lifecycle evaluator flips them to eligible when inventory returns."
      label="back-in-stock subscriptions"
      pagerLabel="Back-in-stock subscriptions"
      statuses={BACK_IN_STOCK_STATUSES}
      columns={[
        "Subscriber and identifiers",
        "Product and variant",
        "Status",
        "Requested and eligible",
        "Notified and expiry",
      ]}
      list={commerceApi.listBackInStockSubscriptions}
      renderRow={(subscription) => (
        <>
          <IdentityCell
            primary={maskedEmail(subscription.subscriber_email)}
            detail={`Subscription ${subscription.id} · Subscriber ${subscription.subscriber_id || "not recorded"}`}
          />
          <ProductCell
            productId={subscription.product_id}
            variantId={subscription.variant_id}
          />
          <StatusCell status={subscription.status} />
          <TimesCell
            entries={[
              ["Requested", subscription.requested_at],
              ["Eligible", subscription.eligible_at],
            ]}
          />
          <TimesCell
            entries={[
              ["Notified", subscription.notified_at],
              ["Expires", subscription.expires_at],
            ]}
          />
        </>
      )}
      emptyTitle="No back-in-stock subscriptions"
      emptyDescription={
        ctx.canAdmin
          ? "These usually come from a storefront “notify me” form; you can also create one against a product ID."
          : "These usually come from a storefront “notify me” form."
      }
      createLabel="New subscription"
      renderCreateDialog={(props) => (
        <ProductSubscriptionDialog ctx={ctx} kind="back-in-stock" {...props} />
      )}
    />
  );
}

/* ---------- price-drop watchers (commerce-23 / commerce-24) ---------- */

function priceRuleLabel(watcher: CommercePriceDropWatcher): string {
  if (watcher.target_price_cents != null) {
    return `Target ${fmtCents(watcher.target_price_cents, watcher.currency)}`;
  }
  if (watcher.min_drop_percent != null) {
    return `Minimum drop ${watcher.min_drop_percent}%`;
  }
  return "No stored price rule";
}

function PriceDropSection({
  ctx,
  integrationId,
}: {
  ctx: CommerceWorkspaceContext;
  integrationId: string;
}) {
  return (
    <RecoverySection<CommercePriceDropWatcher>
      ctx={ctx}
      integrationId={integrationId}
      kind="price-drop-watchers"
      icon={TrendingDown}
      title="Price-drop watchers"
      description="Subscribers watching a product's price. The evaluator marks them eligible when the price falls to their target or by the minimum drop."
      label="price-drop watchers"
      pagerLabel="Price-drop watchers"
      statuses={PRICE_DROP_STATUSES}
      columns={[
        "Subscriber and identifiers",
        "Product and variant",
        "Price rule",
        "Status",
        "Lifecycle times",
      ]}
      list={commerceApi.listPriceDropWatchers}
      renderRow={(watcher) => (
        <>
          <IdentityCell
            primary={maskedEmail(watcher.subscriber_email)}
            detail={`Watcher ${watcher.id} · Subscriber ${watcher.subscriber_id || "not recorded"}`}
          />
          <ProductCell
            productId={watcher.product_id}
            variantId={watcher.variant_id}
          />
          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
            <div className="text-foreground">
              Original{" "}
              {fmtCents(watcher.original_price_cents, watcher.currency)}
            </div>
            <div>{priceRuleLabel(watcher)}</div>
          </TableCell>
          <StatusCell status={watcher.status} />
          <TimesCell
            entries={[
              ["Watching since", watcher.watched_at],
              ["Eligible", watcher.eligible_at],
              ["Notified", watcher.notified_at],
              ["Expires", watcher.expires_at],
            ]}
          />
        </>
      )}
      emptyTitle="No price-drop watchers"
      emptyDescription={
        ctx.canAdmin
          ? "Watchers track a product's price history; create one against a product ID to try it."
          : "Watchers track a product's price history."
      }
      createLabel="New watcher"
      renderCreateDialog={(props) => (
        <ProductSubscriptionDialog ctx={ctx} kind="price-drop" {...props} />
      )}
    />
  );
}
