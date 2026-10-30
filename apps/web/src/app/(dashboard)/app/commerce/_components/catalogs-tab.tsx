// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Catalogs.
 *
 * Cursor-paged catalog list, connected-store catalog create, and a bounded
 * synchronous JSON product import whose 202 summary is rendered verbatim.
 * "Feeds" on a row hands the catalog to the Feeds tab.
 */

import { useId, useState } from "react";
import dynamic from "next/dynamic";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Layers3, Plus } from "lucide-react";

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
import type { CommerceCatalog } from "@/lib/commerce-api";
import {
  formatCommerceTime,
  safeHttpsOrigin,
} from "@/lib/commerce-catalog-helpers";
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
import { useCursorPager } from "./use-cursor-pager";

// Both dialogs only mount once an admin opens them, so their modules load on
// demand instead of riding in the route's initial graph.
const CatalogCreateDialog = dynamic(
  () =>
    import("./catalog-create-dialog").then(
      (module) => module.CatalogCreateDialog,
    ),
  {
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading catalog form…
      </span>
    ),
  },
);
const ImportProductsDialog = dynamic(
  () =>
    import("./import-products-dialog").then(
      (module) => module.ImportProductsDialog,
    ),
  {
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading product import…
      </span>
    ),
  },
);

export function CatalogsTab({ ctx }: { ctx: CommerceWorkspaceContext }) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const pager = useCursorPager(`catalogs:${JSON.stringify(ctx.scopeKey)}`);
  const listQuery = useQuery({
    queryKey: commerceKeys.catalogList(ctx.scopeKey, pager.cursor),
    queryFn: async () => {
      // The commerce API client is shared by every tab but only runs from
      // query and mutation functions, so it loads at the call site rather
      // than in the route's initial graph.
      const { commerceApi } = await import("@/lib/commerce-api");
      return commerceApi.listCatalogs({
        limit: COMMERCE_PAGE_SIZE,
        cursor: pager.cursor,
      });
    },
    enabled: ctx.ready,
    staleTime: STALE.list,
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<CommerceCatalog | null>(
    null,
  );

  const page = listQuery.data;
  const items = Array.isArray(page?.items) ? page.items : [];
  const nextCursor =
    typeof page?.next_cursor === "string" && page.next_cursor
      ? page.next_cursor
      : null;
  const loading = !ctx.ready || (listQuery.isPending && !page);
  const invalidateLists = () =>
    queryClient.invalidateQueries({
      queryKey: commerceKeys.catalogListRoot(ctx.scopeKey),
    });

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold">
            Product catalogs
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Store-owned product collections. Import bounded product batches
            here; feeds and campaign product blocks resolve from them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
            loading={Boolean(page) && listQuery.isFetching}
          >
            Refresh catalogs
          </Button>
          {ctx.canAdmin ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              New catalog
            </Button>
          ) : null}
        </div>
      </div>

      {listQuery.isError ? (
        <CommerceErrorNotice
          error={listQuery.error}
          label="catalogs"
          stale={Boolean(page)}
          retrying={listQuery.isFetching}
          onRetry={() => void listQuery.refetch()}
        />
      ) : null}

      {loading ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading catalogs"
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : page ? (
        items.length === 0 ? (
          <EmptyState
            icon={Layers3}
            title="No catalogs yet"
            description={
              ctx.canAdmin
                ? "Create a catalog owned by a connected store, then import products as JSON. Feeds and campaign product blocks resolve from here."
                : "An administrator can create the first product catalog."
            }
          />
        ) : (
          <TableContainer aria-label="Product catalogs">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Catalog</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((catalog) => (
                  <CatalogRow
                    key={catalog.id}
                    catalog={catalog}
                    canAdmin={ctx.canAdmin}
                    onShowFeeds={() => ctx.openFeedsFor(catalog.id)}
                    onImport={() => setImportTarget(catalog)}
                  />
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
          label="Catalogs"
        />
      ) : null}

      {createOpen ? (
        <CatalogCreateDialog
          ctx={ctx}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            pager.reset();
            void invalidateLists();
          }}
        />
      ) : null}

      {importTarget ? (
        <ImportProductsDialog
          ctx={ctx}
          catalog={importTarget}
          onClose={() => setImportTarget(null)}
          onImported={() => void invalidateLists()}
        />
      ) : null}
    </section>
  );
}

function CatalogRow({
  catalog,
  canAdmin,
  onShowFeeds,
  onImport,
}: {
  catalog: CommerceCatalog;
  canAdmin: boolean;
  onShowFeeds: () => void;
  onImport: () => void;
}) {
  const status = catalog.status || "";
  const feedOrigin = catalog.feed_url
    ? safeHttpsOrigin(catalog.feed_url)
    : null;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{catalog.name}</span>
          <Badge
            variant={
              status.toLowerCase() === "active" ? "success" : "secondary"
            }
          >
            {status ? humanizeStatus(status) : "Unknown"}
          </Badge>
        </div>
        <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
          {catalog.id}
        </div>
        {catalog.error_message ? (
          <p
            className="mt-1 text-xs text-destructive-emphasis"
            title={catalog.error_message}
          >
            The catalog source reported a sync error. Review its source
            configuration before the next import or sync.
          </p>
        ) : null}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        <div className="text-foreground">
          {catalog.source_type || "Unknown source"}
        </div>
        <div className="break-all font-mono text-[11px]">
          Integration: {catalog.integration_id || "not linked"}
        </div>
        {catalog.feed_url ? (
          <div>Feed origin: {feedOrigin || "unverified source"}</div>
        ) : null}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
        <div className="text-foreground">
          {catalog.default_currency || "Not recorded"}
        </div>
        <div>Locale: {catalog.locale || "not recorded"}</div>
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
        <div>Last sync {formatCommerceTime(catalog.last_sync_at)}</div>
        <div>Created {formatCommerceTime(catalog.created_at)}</div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Show product feeds for ${catalog.name}`}
            onClick={onShowFeeds}
          >
            Feeds
          </Button>
          {canAdmin ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Import products into ${catalog.name}`}
              onClick={onImport}
            >
              Import products
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
