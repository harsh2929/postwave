// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce workspace — /app/commerce.
 *
 * Catalogs, product feeds, store data, recovery & alerts, and lifecycle
 * health; the tab registry in `_components/commerce-tabs.tsx` is where each
 * one plugs in. Reachable by URL and linked from the Integrations page's native
 * commerce panel and from Source quality; the sidebar entry lives in
 * `src/lib/dashboard-routes.ts`, which another session is mid-edit on.
 *
 * `?tab=`, `?catalog=` and `?store=` initialise the view and are kept in sync
 * as the reader moves, so a feeds view for one catalog, or the store data of
 * one connected store, is a shareable URL. Local state is the source of truth
 * after mount; the URL is a mirror.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Store } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canAdminCommerce,
  COMMERCE_ADMIN_ONLY_MESSAGE,
  confirmFreshCommerceAdmin,
} from "@/lib/commerce-authority";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { newUUIDv7 } from "@/lib/http-fetch";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import {
  isCommerceTabId,
  type CommerceTabId,
  type CommerceAdminOperation,
  type CommerceWorkspaceContext,
} from "./_components/commerce-context";
import { COMMERCE_TABS } from "./_components/commerce-tabs";

// The connect dialog only mounts once an admin opens it, so its module loads
// on demand instead of riding in the route's initial graph.
const ShopifyConnectDialog = dynamic(
  () =>
    import("./_components/shopify-connect-dialog").then(
      (module) => module.ShopifyConnectDialog,
    ),
  {
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading Shopify connection…
      </span>
    ),
  },
);

const ENTITY_ID_MAX_LENGTH = 128;

/** A catalog or store id from the URL: bounded, and only characters an id
 *  can hold. */
function sanitizeEntityId(value: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length <= ENTITY_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_.:-]*$/u.test(trimmed)
    ? trimmed
    : "";
}

interface CommerceView {
  tab: CommerceTabId;
  catalogId: string;
  storeId: string;
}

export default function CommercePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [view, setView] = useState<CommerceView>(() => {
    const requested = searchParams.get("tab");
    return {
      tab: isCommerceTabId(requested) ? requested : "catalogs",
      catalogId: sanitizeEntityId(searchParams.get("catalog")),
      storeId: sanitizeEntityId(searchParams.get("store")),
    };
  });
  const [connectOpen, setConnectOpen] = useState(false);

  const navigate = (patch: Partial<CommerceView>) => {
    const next: CommerceView = {
      tab: patch.tab ?? view.tab,
      catalogId:
        patch.catalogId !== undefined
          ? sanitizeEntityId(patch.catalogId)
          : view.catalogId,
      storeId:
        patch.storeId !== undefined
          ? sanitizeEntityId(patch.storeId)
          : view.storeId,
    };
    setView(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next.tab === "catalogs") params.delete("tab");
    else params.set("tab", next.tab);
    if (next.catalogId) params.set("catalog", next.catalogId);
    else params.delete("catalog");
    if (next.storeId) params.set("store", next.storeId);
    else params.delete("store");
    const query = params.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  };

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = canAdminCommerce(identity);
  const principalKey = exactPrincipalKey(identity);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<CommerceAdminOperation | null>(null);
  const scopeKey = useMemo(
    () => [...base("commerce", tenantId, role), principalKey] as const,
    [principalKey, role, tenantId],
  );
  const integrationsScopeKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const refreshing = useIsFetching({ queryKey: scopeKey }) > 0;

  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      const operation = operationRef.current;
      if (operation?.principalKey === scopedPrincipal) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [principalKey]);

  const beginAdminOperation = (): CommerceAdminOperation | null => {
    if (operationRef.current || !identity || !canAdmin) return null;
    const operation: CommerceAdminOperation = {
      controller: new AbortController(),
      idempotencyKey: newUUIDv7(),
      openedIdentity: identity,
      principalKey,
    };
    operationRef.current = operation;
    return operation;
  };

  const authorizeAdminOperation = async (
    operation: CommerceAdminOperation,
  ): Promise<void> => {
    if (operationRef.current !== operation) {
      throw new Error("Another commerce action already owns this operation.");
    }
    await confirmFreshCommerceAdmin(
      operation.openedIdentity,
      operation.controller.signal,
    );
    if (principalKeyRef.current !== operation.principalKey) {
      throw new Error(
        "Workspace identity changed while this commerce action was in flight. Refresh before trying again.",
      );
    }
  };

  const finishAdminOperation = (operation: CommerceAdminOperation): void => {
    if (operationRef.current === operation) operationRef.current = null;
  };

  const ctx: CommerceWorkspaceContext = {
    identity,
    ready: meQuery.isSuccess && identity !== null,
    canAdmin,
    beginAdminOperation,
    authorizeAdminOperation,
    finishAdminOperation,
    scopeKey,
    integrationsScopeKey,
    selectedCatalogId: view.catalogId,
    selectCatalog: (catalogId) => navigate({ catalogId }),
    openTab: (tab) => navigate({ tab }),
    openFeedsFor: (catalogId) => navigate({ tab: "feeds", catalogId }),
    selectedStoreId: view.storeId,
    selectStore: (storeId) => navigate({ storeId }),
    openStoreDataFor: (storeId) => navigate({ tab: "stores", storeId }),
  };

  return (
    <PageShell className="max-w-6xl">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Commerce
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Commerce workspace
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Product catalogs, the feeds that select from them, and the store
            connections that own them. Everything here is configuration and
            review evidence; nothing on this page sends a message.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: scopeKey })
            }
            loading={refreshing}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
          {canAdmin ? (
            <Button type="button" onClick={() => setConnectOpen(true)}>
              <Store aria-hidden="true" />
              Connect Shopify
            </Button>
          ) : null}
        </div>
      </header>

      {meQuery.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(
              meQuery.error,
              "Your session could not be confirmed, so no commerce data was requested.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {identity && !canAdmin ? (
        <p
          role="note"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {COMMERCE_ADMIN_ONLY_MESSAGE}
        </p>
      ) : null}

      <Tabs
        value={view.tab}
        onValueChange={(value) => {
          if (isCommerceTabId(value) && value !== view.tab)
            navigate({ tab: value });
        }}
      >
        <TabsList aria-label="Commerce workspace section">
          {COMMERCE_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {COMMERCE_TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="mt-4">
            <tab.Component ctx={ctx} />
          </TabsContent>
        ))}
      </Tabs>

      {connectOpen ? (
        <ShopifyConnectDialog ctx={ctx} onClose={() => setConnectOpen(false)} />
      ) : null}
    </PageShell>
  );
}
