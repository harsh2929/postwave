// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration catalog — a browsable, filterable view of the full backend
// integrations catalog (GET /api/v1/integrations/catalog). The catalog was
// previously only consumed by the SDK / MCP / CLI surfaces; this page surfaces
// it to humans so every native integration is discoverable in-product.
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plug } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DocsLink } from "@/components/integrations/docs-link";
import { DataSurfaceShell } from "@/components/integrations/data-surface";
import { IntegrationsPageHeader } from "@/components/integrations/integrations-page-header";
import { RequestIntegrationButton } from "@/components/integrations/request-integration-button";
import { ApiError, apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  isConnectableCatalogItem,
  normalizeProvider,
} from "@/lib/catalog-connect-map";
import { useConnectedIntegrations } from "@/lib/connected-integrations";
import {
  CATALOG_PAGE_SIZE,
  CATALOG_SORTS,
  capabilityFacets,
  categoryFacets,
  filterSortCatalog,
  isCatalogFiltered,
  providerMonogram,
  type CatalogFilterState,
  type CatalogSort,
  type CatalogStatusFilter,
} from "@/lib/catalog-filter";
import {
  badgeLabel,
  integrationsCatalogApi,
  runtimeStatusLabel,
  runtimeStatusTone,
  type CatalogItem,
} from "@/lib/integrations-catalog-api";
import type {
  CatalogPostureFilter,
  WorkspaceStateFilter,
} from "@/lib/integrations-lifecycle-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, stringParam, type Schema } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";

const STATUS_VALUES = [
  "all",
  "available",
  "partial",
  "delegated",
  "planned",
] as const;

// URL-persisted list state so filters/sort survive refresh, deep-links, and the
// Back button (INTG-007/008/032/035).
const CATALOG_SCHEMA = {
  q: stringParam(""),
  category: stringParam(""),
  status: enumParam(STATUS_VALUES, "all"),
  capability: stringParam(""),
  native: enumParam(["0", "1"] as const, "0"),
  // INTG-029: "Connected only" facet (0/1), mirrors the native facet.
  connected: enumParam(["0", "1"] as const, "0"),
  sort: enumParam(CATALOG_SORTS, "featured"),
} satisfies Schema;

// Workspace posture (connections + customer stacks) rides the lifecycle
// client, so its panels, controls and grid narrowing load after first paint;
// splitting them keeps the page under the dashboard bundle budget without
// changing what admins see. Those are admin reads: the page renders these only
// after it has resolved an owner/admin principal — never for a viewer.
const CatalogPosturePanels = dynamic(
  () =>
    import("./catalog-posture").then((module) => module.CatalogPosturePanels),
  { loading: () => <CatalogPosturePanelsSkeleton /> },
);

const CatalogPostureFilters = dynamic(
  () =>
    import("./catalog-posture").then((module) => module.CatalogPostureFilters),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading posture filters"
        className="h-28 animate-pulse rounded-lg border bg-muted/40 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading posture filters…</span>
      </div>
    ),
  },
);

const CatalogPostureResults = dynamic(
  () =>
    import("./catalog-posture").then((module) => module.CatalogPostureResults),
  { loading: () => <CatalogGridSkeleton /> },
);

const SORT_LABELS: Record<CatalogSort, string> = {
  featured: "Featured first",
  name: "Name (A–Z)",
  native: "Native first",
  status: "Status",
};

export default function IntegrationCatalogPage() {
  const queryClient = useQueryClient();
  const { state, setState, reset } = useTableUrlState(CATALOG_SCHEMA);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.isSuccess ? meQuery.data : null;
  const canAdmin = canReadAdminData(identity);
  const [tenantId, userId, role, viewerMode] = adminReadIdentityParts(identity);
  const authorityKey = identity
    ? [tenantId, userId, role, viewerMode].join("\u001f")
    : "unverified";
  const integrationsBaseKey = useMemo(
    () =>
      [...base("integrations", tenantId, role), userId, viewerMode] as const,
    [role, tenantId, userId, viewerMode],
  );
  const previousAdminScopeRef = useRef<{
    fingerprint: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousAdminScopeRef.current;
    const current = canAdmin
      ? { fingerprint: authorityKey, queryKey: integrationsBaseKey }
      : null;
    if (
      previous &&
      (!current || previous.fingerprint !== current.fingerprint)
    ) {
      void queryClient.cancelQueries({
        queryKey: previous.queryKey,
        exact: false,
      });
      queryClient.removeQueries({ queryKey: previous.queryKey, exact: false });
    }
    if (!current) {
      // All catalog caches contain admin-only data. Purge them when the
      // identity check fails or resolves to viewer/editor authority.
      void queryClient.cancelQueries({
        queryKey: ["integrations"],
        exact: false,
      });
      queryClient.removeQueries({ queryKey: ["integrations"], exact: false });
    }
    previousAdminScopeRef.current = current;
  }, [
    authorityKey,
    canAdmin,
    integrationsBaseKey,
    meQuery.isPending,
    queryClient,
  ]);

  // INTG-029: fan out only after this page has resolved an exact admin
  // principal. The hook receives that same principal so every cache dimension
  // and abort signal is shared with the catalog request.
  const connected = useConnectedIntegrations({ identity, enabled: canAdmin });

  // Local, immediate search input; debounced into the URL state so keystrokes
  // don't router.replace (or re-filter the whole grid) on every character
  // (INTG-035).
  const [searchInput, setSearchInput] = useState(state.q);
  // Workspace-state and customer-stack narrowing (desktop parity). Search and
  // category stay the page's URL state; the posture filter mirrors them.
  const [postureState, setPostureState] = useState<WorkspaceStateFilter>("all");
  const [postureStack, setPostureStack] = useState("");
  const postureFilter: CatalogPostureFilter = {
    query: searchInput,
    category: state.category,
    state: postureState,
    stack: postureStack,
  };
  function changePostureFilter(next: CatalogPostureFilter): void {
    if (next.query !== searchInput) setSearchInput(next.query);
    if (next.category !== state.category) {
      setState({ category: next.category });
    }
    setPostureState(next.state);
    setPostureStack(next.stack);
  }
  function clearAllFilters(): void {
    setSearchInput("");
    reset();
    setPostureState("all");
    setPostureStack("");
  }
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() !== state.q) setState({ q: searchInput.trim() });
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);
  // Keep the input in sync when state.q changes externally (Back button / reset).
  useEffect(() => {
    setSearchInput(state.q);
  }, [state.q]);

  const filterState: CatalogFilterState = useMemo(
    () => ({
      search: state.q,
      category: state.category || null,
      status: state.status as CatalogStatusFilter,
      capability: state.capability || null,
      nativeOnly: state.native === "1",
      // Only narrow once the fan-out has resolved, so a deep-linked ?connected=1
      // shows everything until connections load rather than a misleading empty grid.
      connectedOnly:
        connected.isFetched && !connected.isPartial && state.connected === "1",
      sort: state.sort as CatalogSort,
    }),
    [state, connected.isFetched, connected.isPartial],
  );

  const catalogKey = useMemo(
    () => [...integrationsBaseKey, "catalog"] as const,
    [integrationsBaseKey],
  );
  const catalogQuery = useQuery({
    queryKey: catalogKey,
    queryFn: ({ signal }) => integrationsCatalogApi.get({ signal }),
    enabled: canAdmin,
    staleTime: STALE.list,
    retry: false,
  });
  // Never keep rendering a cached admin catalog after the server rejects the
  // current request. The error branch explains that it is unavailable.
  const catalog = catalogQuery.isError ? null : (catalogQuery.data ?? null);
  // INTG-029: catalog slugs whose provider has a connection. Keyed by the raw
  // item.slug (normalization applied when building) so the badge + filter both
  // join on item.slug and the pure filter core stays connection-agnostic.
  const connectedSlugs = useMemo(() => {
    if (connected.isAuthError) return new Set<string>();
    return new Set(
      (Array.isArray(catalog?.items) ? catalog?.items : [])
        .filter((i) => connected.byProvider.has(normalizeProvider(i.slug)))
        .map((i) => i.slug),
    );
  }, [catalog, connected.byProvider, connected.isAuthError]);
  const connectedItems = useMemo(
    () =>
      (Array.isArray(catalog?.items) ? catalog.items : []).filter((item) =>
        connectedSlugs.has(item.slug),
      ),
    [catalog, connectedSlugs],
  );
  const loading = catalogQuery.isPending && !catalogQuery.data;
  const error = catalogQuery.isError
    ? catalogQuery.error instanceof ApiError &&
      (catalogQuery.error.status === 401 || catalogQuery.error.status === 403)
      ? "The integration catalog is unavailable because the server did not accept owner/admin authority. No denied result is being shown as an empty catalog."
      : apiErrorMessage(
          catalogQuery.error,
          "Could not load the integrations catalog — this is a failed request, not an empty catalog",
        )
    : null;

  const categoryLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of catalog?.categories ?? []) map.set(c.key, c.label);
    return map;
  }, [catalog]);

  const categories = useMemo(
    () =>
      categoryFacets(
        catalog?.items ?? [],
        (key) => categoryLabels.get(key) ?? key,
      ),
    [catalog, categoryLabels],
  );
  const capabilities = useMemo(
    () => capabilityFacets(catalog?.items ?? []),
    [catalog],
  );

  const pageFiltered = useMemo(
    () =>
      filterSortCatalog(
        Array.isArray(catalog?.items) ? catalog.items : [],
        filterState,
        connectedSlugs,
      ),
    [catalog, filterState, connectedSlugs],
  );

  // Bounded render: only mount CATALOG_PAGE_SIZE cards at a time, "Load more"
  // reveals the next page (INTG-007). Resets whenever the result set changes.
  const [visible, setVisible] = useState(CATALOG_PAGE_SIZE);
  const filterSignature = `${state.q}|${state.category}|${state.status}|${state.capability}|${state.native}|${state.connected}|${state.sort}|${postureState}|${postureStack}`;
  useEffect(() => {
    setVisible(CATALOG_PAGE_SIZE);
  }, [filterSignature]);

  const nativeCount = catalog?.counts?.native ?? 0;
  const totalCount = catalog?.items?.length ?? 0;
  const filtersActive =
    isCatalogFiltered(filterState) ||
    postureState !== "all" ||
    postureStack !== "";

  if (meQuery.isPending) {
    return <CatalogAccessState kind="loading" />;
  }
  if (meQuery.isError || !identity) {
    return (
      <CatalogAccessState
        kind="error"
        message={apiErrorMessage(
          meQuery.error,
          "Moosewave could not verify the current workspace identity.",
        )}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!canAdmin) {
    return <CatalogAccessState kind="read-only" />;
  }

  return (
    <DataSurfaceShell className="max-w-6xl">
      <IntegrationsPageHeader
        icon={Plug}
        title="Integration catalog"
        description="Browse every integration Moosewave supports — native pullers, partner connectors, webhooks, and more. Native integrations are built and run by Moosewave; their runtime status reflects how far each is certified against a live account."
        actions={<RequestIntegrationButton key={authorityKey} />}
      />
      {catalog && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border px-2.5 py-0.5">
            {totalCount} integrations
          </span>
          <span className="rounded-full border px-2.5 py-0.5">
            {nativeCount} native
          </span>
          {typeof catalog.counts?.available === "number" && (
            <span className="rounded-full border px-2.5 py-0.5">
              {catalog.counts.available} available
            </span>
          )}
        </div>
      )}

      {!error && connected.isFetched && connected.isAuthError ? (
        <div
          className="rounded-lg border border-destructive/35 bg-destructive/5 p-3 text-sm leading-6 text-destructive-emphasis"
          role="alert"
        >
          Admin authorization was rejected while checking connection status.
          Connected badges and the “Connected only” filter are unavailable; no
          denied surface was treated as empty.
        </div>
      ) : !error && connected.isFetched && connected.isPartial ? (
        <div
          className="rounded-lg border border-warning/35 bg-warning-subtle/60 p-3 text-sm leading-6 text-muted-foreground"
          role="status"
        >
          Some connection surfaces could not be checked. Known connected badges
          remain visible, but the “Connected only” filter is paused so an
          incomplete result is not presented as complete.
        </div>
      ) : null}

      {/* INTG-029: at-a-glance shortcut to already-connected integrations.
          Rendered only once the fan-out resolves and there's ≥1 connection, so
          it never flashes an empty state. Connected items also remain in the
          main grid + counts below (this is a shortcut, not a filter). */}
      {connected.isFetched && connectedItems.length > 0 ? (
        <section
          aria-labelledby="your-integrations-heading"
          className="space-y-3"
        >
          <h2 id="your-integrations-heading" className="text-sm font-semibold">
            Your integrations
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {connectedItems.map((item) => (
              <CatalogCard key={item.slug} item={item} connected />
            ))}
          </div>
        </section>
      ) : null}

      {/* Workspace readiness, coverage, customer stacks and setup recipes. */}
      <CatalogPosturePanels />

      {/* Controls */}
      <section className="space-y-3" aria-labelledby="catalog-filters-heading">
        <h2 id="catalog-filters-heading" className="sr-only">
          Filter integration catalog
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Input
            type="search"
            placeholder="Search integrations…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search integrations"
            className="w-full max-w-md text-base sm:text-sm"
          />
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label
              htmlFor="catalog-sort"
              className="text-xs text-muted-foreground"
            >
              Sort
            </label>
            <Select
              id="catalog-sort"
              value={state.sort}
              onChange={(e) =>
                setState({ sort: e.target.value as CatalogSort })
              }
              className="min-w-0 flex-1 sm:w-44 sm:flex-none"
            >
              {CATALOG_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Runtime status filters"
        >
          <FilterChip
            active={state.status === "all"}
            onClick={() => setState({ status: "all" })}
          >
            All statuses
          </FilterChip>
          {(["available", "partial", "delegated", "planned"] as const).map(
            (s) => (
              <FilterChip
                key={s}
                active={state.status === s}
                onClick={() => setState({ status: s })}
              >
                {runtimeStatusLabel(s)}
              </FilterChip>
            ),
          )}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <FilterChip
            active={state.native === "1"}
            onClick={() =>
              setState({ native: state.native === "1" ? "0" : "1" })
            }
          >
            Native only
          </FilterChip>
          {/* INTG-029: gated on the fan-out so it can't produce a misleading
              zero-result state before connections load. */}
          {connected.isFetched && !connected.isPartial && (
            <FilterChip
              active={state.connected === "1"}
              onClick={() =>
                setState({ connected: state.connected === "1" ? "0" : "1" })
              }
            >
              Connected only
            </FilterChip>
          )}
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={clearAllFilters}
            >
              Clear filters
            </Button>
          )}
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <FilterChip
              active={!state.category}
              onClick={() => setState({ category: "" })}
            >
              All categories
            </FilterChip>
            {categories.map((c) => (
              <FilterChip
                key={c.key}
                active={state.category === c.key}
                onClick={() =>
                  setState({ category: state.category === c.key ? "" : c.key })
                }
              >
                {c.label}{" "}
                <span className="text-muted-foreground">({c.count})</span>
              </FilterChip>
            ))}
          </div>
        )}
        {capabilities.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Capability</span>
            <FilterChip
              active={!state.capability}
              onClick={() => setState({ capability: "" })}
            >
              Any
            </FilterChip>
            {capabilities.map((c) => (
              <FilterChip
                key={c.key}
                active={state.capability === c.key}
                onClick={() =>
                  setState({
                    capability: state.capability === c.key ? "" : c.key,
                  })
                }
              >
                {c.key}{" "}
                <span className="text-muted-foreground">({c.count})</span>
              </FilterChip>
            ))}
          </div>
        )}
        <CatalogPostureFilters
          value={postureFilter}
          onChange={changePostureFilter}
          categories={
            Array.isArray(catalog?.categories) ? catalog.categories : []
          }
        />
      </section>

      {/* Body */}
      {loading && <CatalogGridSkeleton />}

      {!loading && error && (
        <Card role="alert" className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void catalogQuery.refetch();
              }}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && (
        <CatalogPostureResults
          // Search and category were applied above with the page's own
          // semantics; posture adds only workspace state and stack.
          items={pageFiltered}
          state={postureState}
          stack={postureStack}
        >
          {(filtered) => {
            const shown = filtered.slice(0, visible);
            return (
              <>
                <p
                  className="text-xs text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  Showing {shown.length} of {filtered.length}
                  {filtered.length !== totalCount
                    ? ` (filtered from ${totalCount})`
                    : ""}
                </p>
                {filtered.length === 0 ? (
                  <Card>
                    <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                      <p className="text-sm text-muted-foreground">
                        No integrations match your filters.
                      </p>
                      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={clearAllFilters}
                        >
                          Clear filters
                        </Button>
                        <RequestIntegrationButton
                          key={authorityKey}
                          defaultProvider={state.q}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {shown.map((item) => (
                        <CatalogCard
                          key={item.slug}
                          item={item}
                          connected={connectedSlugs.has(item.slug)}
                        />
                      ))}
                    </div>
                    {visible < filtered.length && (
                      <div className="flex justify-center pt-2">
                        <Button
                          variant="outline"
                          onClick={() =>
                            setVisible((v) => v + CATALOG_PAGE_SIZE)
                          }
                        >
                          Load more ({filtered.length - visible} remaining)
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            );
          }}
        </CatalogPostureResults>
      )}
    </DataSurfaceShell>
  );
}

function CatalogAccessState({
  kind,
  message,
  retrying = false,
  onRetry,
}: {
  kind: "loading" | "error" | "read-only";
  message?: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <DataSurfaceShell className="max-w-6xl">
      <IntegrationsPageHeader
        icon={Plug}
        title="Integration catalog"
        description="Browse and manage the workspace integration catalog."
      />
      <Card role={kind === "loading" ? "status" : "alert"}>
        <CardHeader>
          <CardTitle>
            {kind === "loading"
              ? "Checking catalog access…"
              : kind === "error"
                ? "Couldn’t verify catalog access"
                : "Owner or admin access required"}
          </CardTitle>
          <CardDescription>
            {kind === "loading"
              ? "Moosewave is confirming the current workspace and effective role before requesting protected catalog data."
              : kind === "error"
                ? `${message ?? "The identity check failed."} No integration catalog request was made.`
                : `${ADMIN_READ_ONLY_MESSAGE} No integration catalog or connection request was made.`}
          </CardDescription>
        </CardHeader>
        {kind === "error" && onRetry ? (
          <CardContent>
            <Button type="button" onClick={onRetry} loading={retrying}>
              {retrying ? "Retrying…" : "Retry access check"}
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </DataSurfaceShell>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "min-h-11 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "bg-background text-foreground hover:border-primary/50",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CatalogCard({
  item,
  connected,
}: {
  item: CatalogItem;
  connected?: boolean;
}) {
  // Every card links its title to the in-app detail route — including
  // non-connectable/browse-only providers, whose detail page still renders
  // status, capabilities, and (when present) a setup_path handoff (INTG-010).
  // Only the "Connect" CTA is gated on connectability.
  const connectable = isConnectableCatalogItem(item);
  const detailHref = `/app/integrations/catalog/${item.slug}`;
  const extraCaps = item.capabilities.length - 3;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="space-y-2 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {/* Monogram avatar as a lightweight visual scan aid — no real brand
                logo asset exists for the ~630-item catalog (INTG-031). */}
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-semibold text-primary ring-1 ring-primary/10"
            >
              {providerMonogram(item.name)}
            </span>
            <CardTitle className="text-base">
              <Link
                href={detailHref as never}
                className="inline-flex min-h-11 items-center break-words rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
              >
                {item.name}
              </Link>
            </CardTitle>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {/* INTG-029: this workspace has a live connection to this provider. */}
            {connected && <Badge variant="success">Connected</Badge>}
            <Badge variant={item.native ? "default" : "secondary"}>
              {badgeLabel(item.badge)}
            </Badge>
            {item.featured && (
              <Badge variant="warning" className="text-[10px]">
                Featured
              </Badge>
            )}
          </div>
        </div>
        <CardDescription className="line-clamp-3">
          {item.summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3 p-5 pt-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={runtimeStatusTone(item.runtime_status)}>
            {runtimeStatusLabel(item.runtime_status)}
          </Badge>
          {item.capabilities.slice(0, 3).map((cap) => (
            <span
              key={cap}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {cap}
            </span>
          ))}
          {extraCaps > 0 && (
            <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              +{extraCaps} more
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={detailHref as never}
            className="inline-flex min-h-11 items-center rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          >
            {connectable ? "Connect →" : "Details →"}
          </Link>
          {item.docs_url && <DocsLink href={item.docs_url} />}
        </div>
      </CardContent>
    </Card>
  );
}

function CatalogGridSkeleton() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="status"
      aria-label="Loading integrations"
    >
      <span className="sr-only">Loading integrations…</span>
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border bg-muted/40 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

/** Matches the four posture cards (readiness, coverage, stacks, recipes). */
function CatalogPosturePanelsSkeleton() {
  return (
    <div
      className="grid gap-4 lg:grid-cols-2"
      role="status"
      aria-label="Loading workspace posture"
    >
      <span className="sr-only">Loading workspace posture…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border bg-muted/40 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
