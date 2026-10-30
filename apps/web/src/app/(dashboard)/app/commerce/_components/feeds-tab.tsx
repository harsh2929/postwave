// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Feeds.
 *
 * Per-catalog draft product feeds: cursor-paged list, create, and a resolver
 * preview. The preview is the resolver's answer rendered verbatim — review
 * evidence, not a campaign render and not a delivery.
 */

import { useId, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ListFilter, Plus } from "lucide-react";
import { toast } from "sonner";

import { humanizeStatus } from "@/components/mailchimp-parity/product-panel-primitives";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
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
import {
  commerceApi,
  type CommerceProductFeed,
  type CommerceProductFeedInput,
} from "@/lib/commerce-api";
import {
  configuredFieldsLabel,
  fmtCents,
  formatCommerceTime,
  MAX_FEED_ITEMS,
} from "@/lib/commerce-catalog-helpers";
import { STALE } from "@/lib/query-keys";

import {
  COMMERCE_PAGE_SIZE,
  commerceKeys,
  type CommerceAdminOperation,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import {
  CommerceErrorNotice,
  commerceFailureMessage,
  CursorPagerControls,
  DiscardDraftDialog,
  FieldError,
  FieldHint,
  useDraftCloseGuard,
} from "./commerce-primitives";
import { useCursorPager } from "./use-cursor-pager";

const FEED_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "recent", label: "Recent catalog products" },
  { value: "behavioral_recommendation", label: "Behavioral recommendation" },
  { value: "dynamic", label: "Dynamic selection with subscriber context" },
];

export function FeedsTab({ ctx }: { ctx: CommerceWorkspaceContext }) {
  const id = useId();
  const queryClient = useQueryClient();
  const catalogsQuery = useQuery({
    queryKey: commerceKeys.catalogList(ctx.scopeKey, undefined),
    queryFn: () => commerceApi.listCatalogs({ limit: COMMERCE_PAGE_SIZE }),
    enabled: ctx.ready,
    staleTime: STALE.list,
  });
  const catalogOptions = Array.isArray(catalogsQuery.data?.items)
    ? catalogsQuery.data.items
    : [];
  const moreCatalogsExist =
    typeof catalogsQuery.data?.next_cursor === "string" &&
    catalogsQuery.data.next_cursor !== "";
  const catalogId = ctx.selectedCatalogId;
  const selectedCatalog =
    catalogOptions.find((catalog) => catalog.id === catalogId) ?? null;
  const catalogLabel = selectedCatalog?.name ?? `catalog ${catalogId}`;

  const pager = useCursorPager(
    `feeds:${catalogId}:${JSON.stringify(ctx.scopeKey)}`,
  );
  const feedsQuery = useQuery({
    queryKey: commerceKeys.feedList(ctx.scopeKey, catalogId, pager.cursor),
    queryFn: () =>
      commerceApi.listProductFeeds(catalogId, {
        limit: COMMERCE_PAGE_SIZE,
        cursor: pager.cursor,
      }),
    enabled: ctx.ready && catalogId !== "",
    staleTime: STALE.list,
    // Keep the last successful page on screen while a cursor change is IN
    // FLIGHT: without it `page` goes undefined between cursors, the pager
    // unmounts, and the reader loses the controls mid-navigation.
    //
    // It does NOT cover a failed cursor change. query-core gates placeholder
    // data on `status === "pending"`, so once the new page errors the query
    // leaves pending and `data` is undefined again. Claiming otherwise here
    // would describe a safety net that is not there; the failed-"Next" case is
    // handled by the error branch below, not by this option.
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [resolveTarget, setResolveTarget] =
    useState<CommerceProductFeed | null>(null);

  const page = feedsQuery.data;
  const feeds = Array.isArray(page?.items) ? page.items : [];
  const nextCursor =
    typeof page?.next_cursor === "string" && page.next_cursor
      ? page.next_cursor
      : null;
  const loadingFeeds =
    catalogId !== "" && (!ctx.ready || (feedsQuery.isPending && !page));
  const invalidateFeeds = () =>
    queryClient.invalidateQueries({
      queryKey: commerceKeys.feedListRoot(ctx.scopeKey, catalogId),
    });

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            Product feeds
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Draft and active product selections returned by the feed resolver. A
            resolve preview is review evidence, not a send or delivery event.
          </p>
        </div>
        {catalogId ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void feedsQuery.refetch()}
              loading={Boolean(page) && feedsQuery.isFetching}
            >
              Refresh feeds
            </Button>
            {ctx.canAdmin ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" />
                New feed
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="max-w-md space-y-1.5">
        <Label htmlFor={`${id}-catalog`}>Catalog</Label>
        <Select
          id={`${id}-catalog`}
          value={catalogId}
          onChange={(event) => ctx.selectCatalog(event.target.value)}
          disabled={!ctx.ready}
        >
          <option value="">
            {catalogsQuery.isPending
              ? "Loading catalogs…"
              : catalogOptions.length === 0
                ? "No catalogs on the first page"
                : "Choose a catalog"}
          </option>
          {catalogOptions.map((catalog) => (
            <option key={catalog.id} value={catalog.id}>
              {catalog.name} · {catalog.default_currency || "currency not set"}
            </option>
          ))}
          {catalogId && !selectedCatalog ? (
            <option value={catalogId}>Catalog {catalogId}</option>
          ) : null}
          {/* The picker reads one un-cursored page, so a workspace with more
              catalogs than COMMERCE_PAGE_SIZE silently hides the rest. Say so,
              or a missing catalog reads as deleted or feed-less. */}
          {moreCatalogsExist ? (
            <option value="" disabled>
              More catalogs exist — open one from the Catalogs tab
            </option>
          ) : null}
        </Select>
        {catalogsQuery.isError ? (
          <p className="text-xs text-destructive-emphasis" role="alert">
            {commerceFailureMessage(catalogsQuery.error)}
          </p>
        ) : null}
      </div>

      {catalogId === "" ? (
        catalogsQuery.isSuccess && catalogOptions.length === 0 ? (
          <EmptyState
            icon={ListFilter}
            title="No catalogs to build feeds from"
            description="Feeds select products out of a catalog. Create a catalog first, then come back here."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => ctx.openTab("catalogs")}
              >
                Go to Catalogs
              </Button>
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose a catalog to list its feeds.
          </p>
        )
      ) : (
        <>
          {feedsQuery.isError ? (
            <CommerceErrorNotice
              error={feedsQuery.error}
              label="product feeds"
              stale={Boolean(page)}
              retrying={feedsQuery.isFetching}
              onRetry={() => void feedsQuery.refetch()}
            />
          ) : null}
          {loadingFeeds ? (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label="Loading product feeds"
            >
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : page ? (
            feeds.length === 0 ? (
              <EmptyState
                icon={ListFilter}
                title="No feeds for this catalog yet"
                description={
                  ctx.canAdmin
                    ? "Create a feed to define which products a campaign block shows, then resolve it here to preview the selection."
                    : "An administrator can create feeds for this catalog."
                }
              />
            ) : (
              <TableContainer aria-label={`Product feeds for ${catalogLabel}`}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Feed</TableHead>
                      <TableHead>Type and rules</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Limits</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {feeds.map((feed) => (
                      <TableRow key={feed.id}>
                        <TableCell className="align-top">
                          <div className="font-medium">{feed.name}</div>
                          <div className="break-all font-mono text-[11px] text-muted-foreground">
                            {feed.id}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Created {formatCommerceTime(feed.created_at)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          <div className="text-foreground">
                            {feed.feed_type || "Unknown type"}
                          </div>
                          <div>
                            Criteria: {configuredFieldsLabel(feed.criteria)}
                          </div>
                          <div>
                            Fallback: {configuredFieldsLabel(feed.fallback)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant={
                              feed.status === "active" ? "success" : "secondary"
                            }
                          >
                            {feed.status
                              ? humanizeStatus(feed.status)
                              : "Unknown"}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                          <div className="text-foreground">
                            Maximum{" "}
                            {Number(feed.max_items ?? 0).toLocaleString()} items
                          </div>
                          <div>
                            {feed.exclude_out_of_stock
                              ? "Out-of-stock products excluded"
                              : "Out-of-stock products may be included"}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Resolve a preview of ${feed.name}`}
                              onClick={() => setResolveTarget(feed)}
                            >
                              Resolve preview
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          ) : null}
          {page ? (
            <CursorPagerControls
              pager={pager}
              itemCount={feeds.length}
              nextCursor={nextCursor}
              busy={feedsQuery.isFetching}
              label="Product feeds"
            />
          ) : null}
        </>
      )}

      {createOpen && catalogId ? (
        <FeedCreateDialog
          ctx={ctx}
          catalogId={catalogId}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            pager.reset();
            void invalidateFeeds();
          }}
        />
      ) : null}

      {resolveTarget && catalogId ? (
        <ResolvePreviewDialog
          ctx={ctx}
          catalogId={catalogId}
          feed={resolveTarget}
          onClose={() => setResolveTarget(null)}
        />
      ) : null}
    </section>
  );
}

/* ---------- create feed ---------- */

type FeedField = "name" | "max";

function FeedCreateDialog({
  ctx,
  catalogId,
  onClose,
  onCreated,
}: {
  ctx: CommerceWorkspaceContext;
  catalogId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [feedType, setFeedType] = useState("recent");
  const [maxItems, setMaxItems] = useState("6");
  const [excludeOutOfStock, setExcludeOutOfStock] = useState(true);
  const [fieldError, setFieldError] = useState<{
    field: FeedField;
    message: string;
  } | null>(null);

  const create = useMutation({
    mutationFn: async ({
      input,
      operation,
    }: {
      input: CommerceProductFeedInput;
      operation: CommerceAdminOperation;
    }) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        return await commerceApi.createProductFeed(catalogId, input, {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
    onSuccess: (created, { input }) => {
      toast.success(`Draft feed "${created?.name || input.name}" created`);
      onCreated();
      onClose();
    },
  });
  const pending = create.isPending;
  const dirty = Boolean(
    name || feedType !== "recent" || maxItems !== "6" || !excludeOutOfStock,
  );
  const guard = useDraftCloseGuard({
    dirty,
    pending,
    onDiscard: () => {
      setName("");
      setFeedType("recent");
      setMaxItems("6");
      setExcludeOutOfStock(true);
      setFieldError(null);
      create.reset();
    },
    onClose,
  });
  const errorFor = (field: FeedField) =>
    fieldError?.field === field ? fieldError.message : null;

  const submit = () => {
    if (pending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldError({ field: "name", message: "Feed name is required." });
      return;
    }
    const max = Number(maxItems);
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_FEED_ITEMS) {
      setFieldError({
        field: "max",
        message: `Maximum items must be a whole number from 1 through ${MAX_FEED_ITEMS}.`,
      });
      return;
    }
    setFieldError(null);
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    create.mutate({
      operation,
      input: {
        name: trimmed,
        feed_type: feedType,
        max_items: max,
        exclude_out_of_stock: excludeOutOfStock,
      },
    });
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
        }}
      >
        <DialogContent
          closeDisabled={pending}
          aria-busy={pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>New product feed</DialogTitle>
            <DialogDescription>
              Choose a server-backed selection strategy and a bounded result
              limit. New feeds are saved as drafts; this workspace does not
              claim they are published.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {create.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {commerceFailureMessage(create.error)}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldError?.field === "name") setFieldError(null);
                }}
                placeholder="e.g. Best sellers"
                maxLength={160}
                required
                disabled={pending}
                aria-invalid={errorFor("name") ? true : undefined}
                aria-describedby={
                  errorFor("name") ? `${id}-name-error` : undefined
                }
              />
              <FieldError id={`${id}-name-error`} message={errorFor("name")} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-type`}>Feed type</Label>
                <Select
                  id={`${id}-type`}
                  value={feedType}
                  onChange={(event) => setFeedType(event.target.value)}
                  disabled={pending}
                  aria-describedby={`${id}-type-hint`}
                >
                  {FEED_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <FieldHint id={`${id}-type-hint`}>
                  Only strategies with defined resolver behavior are available.
                </FieldHint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-max`}>Maximum items</Label>
                <Input
                  id={`${id}-max`}
                  type="number"
                  min={1}
                  max={MAX_FEED_ITEMS}
                  step={1}
                  inputMode="numeric"
                  value={maxItems}
                  onChange={(event) => {
                    setMaxItems(event.target.value);
                    if (fieldError?.field === "max") setFieldError(null);
                  }}
                  disabled={pending}
                  aria-invalid={errorFor("max") ? true : undefined}
                  aria-describedby={
                    errorFor("max") ? `${id}-max-error` : `${id}-max-hint`
                  }
                />
                <FieldError id={`${id}-max-error`} message={errorFor("max")} />
                <FieldHint id={`${id}-max-hint`}>
                  Whole number from 1 through {MAX_FEED_ITEMS}. Campaign layouts
                  may render fewer.
                </FieldHint>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={excludeOutOfStock}
                onChange={(event) => setExcludeOutOfStock(event.target.checked)}
                disabled={pending}
                className="mt-0.5"
              />
              <span>Exclude out-of-stock products from resolved output</span>
            </label>
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {pending
                ? "Creating the feed. Fields and dismissal stay locked until the request finishes."
                : "Nothing is created until you choose Create draft feed. Publication is a separate step."}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={guard.requestClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                {pending ? "Creating…" : "Create draft feed"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDraftDialog
        open={guard.discardOpen}
        title="Discard product feed draft?"
        description="The feed name, selection type, limit, and stock policy will be cleared. Nothing has been created."
        onConfirm={guard.discardAndClose}
        onKeepEditing={guard.keepEditing}
      />
    </>
  );
}

/* ---------- resolve preview ---------- */

function ResolvePreviewDialog({
  ctx,
  catalogId,
  feed,
  onClose,
}: {
  ctx: CommerceWorkspaceContext;
  catalogId: string;
  feed: CommerceProductFeed;
  onClose: () => void;
}) {
  const id = useId();
  const [emailDraft, setEmailDraft] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const resolveQuery = useQuery({
    queryKey: commerceKeys.feedResolve(
      ctx.scopeKey,
      catalogId,
      feed.id,
      submittedEmail,
    ),
    queryFn: () =>
      commerceApi.resolveProductFeed(
        catalogId,
        feed.id,
        submittedEmail ? { subscriber_email: submittedEmail } : {},
      ),
    enabled: ctx.ready,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const resolved = resolveQuery.data ?? null;
  const items = Array.isArray(resolved?.items) ? resolved.items : [];
  const resolving = resolveQuery.isFetching;
  const draftDiffers = emailDraft.trim().toLowerCase() !== submittedEmail;

  const resolveDraft = () => {
    if (resolving) return;
    const normalized = emailDraft.trim().toLowerCase();
    if (normalized && !/^[^\s@]+@[^\s@]+$/u.test(normalized)) {
      setEmailError(
        "Enter a valid subscriber email address or leave it empty.",
      );
      return;
    }
    setEmailError(null);
    if (normalized === submittedEmail) void resolveQuery.refetch();
    else setSubmittedEmail(normalized);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Resolve preview — {feed.name}</DialogTitle>
          <DialogDescription>
            A review-only snapshot of the resolver response. It does not send a
            message or prove final campaign rendering, enrollment, or delivery.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            resolveDraft();
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${id}-email`}>Subscriber email (optional)</Label>
            <Input
              id={`${id}-email`}
              type="email"
              placeholder="customer@example.com"
              value={emailDraft}
              onChange={(event) => {
                setEmailDraft(event.target.value);
                setEmailError(null);
              }}
              maxLength={320}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={
                emailError ? `${id}-email-error` : `${id}-email-hint`
              }
            />
            <FieldError id={`${id}-email-error`} message={emailError} />
            <FieldHint id={`${id}-email-hint`}>
              Leave empty for the non-personalized resolver result. The preview
              never sends a message.
            </FieldHint>
          </div>
          <Button type="submit" variant="outline" loading={resolving}>
            {resolving ? "Resolving…" : "Resolve preview"}
          </Button>
        </form>
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {resolving
            ? `Resolving ${submittedEmail ? "with supplied subscriber context" : "without subscriber personalization"}.`
            : draftDiffers
              ? "The email draft has changed. Choose Resolve preview to apply it; the table still represents the previous request."
              : `Preview represents ${submittedEmail ? `the submitted subscriber context (${submittedEmail})` : "the non-personalized resolver"}. No message was sent.`}
        </p>

        {resolveQuery.isError ? (
          <CommerceErrorNotice
            error={resolveQuery.error}
            label="feed preview"
            stale={Boolean(resolved)}
            retrying={resolving}
            onRetry={() => void resolveQuery.refetch()}
          />
        ) : null}

        {resolved === null ? (
          resolving ? (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label="Resolving feed preview"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : null
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The resolver returned no items — the catalog may be empty, or every
            candidate was filtered (for example, out of stock with in-stock-only
            set).
          </p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex gap-1">
                <dt>Feed ID:</dt>
                <dd className="break-all font-mono">{resolved.feed_id}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Catalog ID:</dt>
                <dd className="break-all font-mono">
                  {resolved.catalog_id || catalogId}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>Feed type:</dt>
                <dd>{resolved.feed_type}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Stock policy:</dt>
                <dd>
                  {resolved.exclude_out_of_stock
                    ? "out-of-stock excluded"
                    : "out-of-stock allowed"}
                </dd>
              </div>
            </dl>
            <TableContainer aria-label={`Resolved products for ${feed.name}`}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rank</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Availability</TableHead>
                    <TableHead>Resolver reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow
                      key={`${item.product_id}-${item.variant_id ?? ""}`}
                    >
                      <TableCell className="align-top tabular-nums text-muted-foreground">
                        {item.rank}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="font-medium">
                          {item.title || "Untitled product"}
                        </div>
                        <div className="break-all font-mono text-[11px] text-muted-foreground">
                          Product {item.product_id} · Source {item.source_id}
                        </div>
                        <div className="break-all font-mono text-[11px] text-muted-foreground">
                          Variant {item.variant_id || "product level"} · Variant
                          source {item.variant_source_id || "not recorded"}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-xs tabular-nums">
                        <div>{fmtCents(item.price_cents, item.currency)}</div>
                        <div className="text-muted-foreground">
                          Compare at:{" "}
                          {item.compare_at_price_cents != null
                            ? fmtCents(
                                item.compare_at_price_cents,
                                item.currency,
                              )
                            : "not recorded"}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={item.available ? "success" : "secondary"}
                        >
                          {item.available ? "Available" : "Unavailable"}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground">
                        {item.reason || "No reason returned"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
