// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared contract between the Commerce workspace page and its tabs.
 *
 * TAB REGISTRY. `COMMERCE_TAB_IDS` is the single list of tab ids; the page
 * validates `?tab=` against it and `commerce-tabs.tsx` maps each id to a
 * label and component. To add a tab: add its id here, then its entry in
 * `COMMERCE_TABS`. The `Record<CommerceTabId, …>` type on the registry fails
 * typecheck if an id has no entry, so a new tab cannot be half-registered.
 */

import type { MeResponse } from "@/lib/auth-api";

export interface CommerceAdminOperation {
  controller: AbortController;
  idempotencyKey: string;
  openedIdentity: MeResponse;
  principalKey: string;
}

export const COMMERCE_TAB_IDS = [
  "catalogs",
  "feeds",
  "stores",
  "recovery",
  "lifecycle",
] as const;
export type CommerceTabId = (typeof COMMERCE_TAB_IDS)[number];

export function isCommerceTabId(value: unknown): value is CommerceTabId {
  return (
    typeof value === "string" &&
    (COMMERCE_TAB_IDS as readonly string[]).includes(value)
  );
}

export interface CommerceWorkspaceContext {
  /** Server-resolved identity; null until `whoami` settles. */
  identity: MeResponse | null;
  /** True once identity has settled, so tenant-scoped queries may run. */
  ready: boolean;
  /** Owner/admin outside viewer mode — the only callers the admin routes accept. */
  canAdmin: boolean;
  /** Acquire the page-wide same-tick lock for one admin effect. */
  beginAdminOperation: () => CommerceAdminOperation | null;
  /** Re-read and compare exact authority immediately before the effect. */
  authorizeAdminOperation: (operation: CommerceAdminOperation) => Promise<void>;
  /** Release only the operation that currently owns the page-wide lock. */
  finishAdminOperation: (operation: CommerceAdminOperation) => void;
  /** `base("commerce", tenantId, role)` — every workspace key hangs off it. */
  scopeKey: readonly unknown[];
  /** `base("integrations", tenantId, role)` — the Integrations page's prefix,
   *  invalidated after a store connects so its commerce panel refreshes too. */
  integrationsScopeKey: readonly unknown[];
  /** The catalog whose feeds the Feeds tab shows (mirrored to `?catalog=`). */
  selectedCatalogId: string;
  selectCatalog: (catalogId: string) => void;
  openTab: (tab: CommerceTabId) => void;
  /** Select a catalog AND switch to the Feeds tab in one navigation, so the
   *  URL ends up carrying both (`?tab=feeds&catalog=…`). */
  openFeedsFor: (catalogId: string) => void;
  /** The connected store (commerce integration) whose per-store records a tab
   *  shows — Store data today; mirrored to `?store=` so any per-store view is
   *  a shareable URL. */
  selectedStoreId: string;
  selectStore: (storeId: string) => void;
  /** Select a store AND switch to the Store data tab in one navigation
   *  (`?tab=stores&store=…`) — the target of "Browse data" links elsewhere. */
  openStoreDataFor: (storeId: string) => void;
}

/** Query keys composed on the workspace scope. Lists carry the cursor so each
 *  page is its own cache entry; the `*Root` keys invalidate every page. */
export const commerceKeys = {
  catalogListRoot: (scope: readonly unknown[]) =>
    [...scope, "catalog-list"] as const,
  catalogList: (scope: readonly unknown[], cursor: string | undefined) =>
    [...scope, "catalog-list", cursor ?? null] as const,
  feedListRoot: (scope: readonly unknown[], catalogId: string) =>
    [...scope, "catalog", catalogId, "feeds"] as const,
  feedList: (
    scope: readonly unknown[],
    catalogId: string,
    cursor: string | undefined,
  ) => [...scope, "catalog", catalogId, "feeds", cursor ?? null] as const,
  feedResolve: (
    scope: readonly unknown[],
    catalogId: string,
    feedId: string,
    subscriberEmail: string,
  ) =>
    [
      ...scope,
      "catalog",
      catalogId,
      "feed",
      feedId,
      "resolve",
      subscriberEmail,
    ] as const,
  integrations: (scope: readonly unknown[]) =>
    [...scope, "integrations"] as const,
  /** GET /integrations/{id}/analytics — one entry per store. */
  storeAnalytics: (scope: readonly unknown[], storeId: string) =>
    [...scope, "store", storeId, "analytics"] as const,
  /** One synced-record list (customers / products / orders / events) of one
   *  store, one page per cursor. */
  storeRecords: (
    scope: readonly unknown[],
    storeId: string,
    view: string,
    cursor: string | undefined,
  ) => [...scope, "store", storeId, "records", view, cursor ?? null] as const,
  /** One recovery record kind of one store — `kind` is the route segment
   *  ("cart-recovery-links" / "back-in-stock-subscriptions" /
   *  "price-drop-watchers"). The status filter is part of the key because it
   *  is part of the request, so switching filters is a different cache entry
   *  rather than a silent overwrite of the unfiltered page. */
  recoveryRecordsRoot: (
    scope: readonly unknown[],
    storeId: string,
    kind: string,
  ) => [...scope, "store", storeId, "recovery", kind] as const,
  recoveryRecords: (
    scope: readonly unknown[],
    storeId: string,
    kind: string,
    status: string,
    cursor: string | undefined,
  ) =>
    [
      ...scope,
      "store",
      storeId,
      "recovery",
      kind,
      status || "all",
      cursor ?? null,
    ] as const,
  /** GET …/lifecycle/report — one entry per store. */
  lifecycleReport: (scope: readonly unknown[], storeId: string) =>
    [...scope, "store", storeId, "lifecycle-report"] as const,
  /** A per-product drill-down (variants / inventory / price-history). */
  productDrill: (
    scope: readonly unknown[],
    storeId: string,
    productId: string,
    kind: string,
    cursor: string | undefined,
  ) =>
    [
      ...scope,
      "store",
      storeId,
      "product",
      productId,
      kind,
      cursor ?? null,
    ] as const,
};

export const COMMERCE_PAGE_SIZE = 25;
