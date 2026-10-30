// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Layers3, ShoppingBag } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { humanizeStatus } from "@/components/mailchimp-parity/product-panel-primitives";
import { whoami } from "@/lib/auth-api";
import { asRoute } from "@/lib/typed-routes";
import {
  commerceApi,
  commerceEventError,
  commerceSyncStateLabel,
  commerceSyncStateTone,
  type CommerceEventRow,
  type CommerceIntegration,
  type CommerceSyncTone,
} from "@/lib/commerce-api";
import { base, qk, STALE } from "@/lib/query-keys";

interface CommerceOverviewData {
  items: CommerceIntegration[];
  eventsByIntegration: Record<string, CommerceEventRow[]>;
  unavailableEventIntegrationIds: string[];
}

export function syncFailureEvents(
  events: CommerceEventRow[],
): CommerceEventRow[] {
  return events.filter((event) => event.event_type === "sync_failed");
}

async function loadCommerceOverview(): Promise<CommerceOverviewData> {
  const items = await commerceApi.integrations();
  const eventPairs = await Promise.all(
    items.map(async (item) => {
      try {
        const page = await commerceApi.events(item.id, { limit: 10 });
        return {
          id: item.id,
          failures: syncFailureEvents(page.items),
          unavailable: false,
        };
      } catch {
        return { id: item.id, failures: [], unavailable: true };
      }
    }),
  );
  return {
    items,
    eventsByIntegration: Object.fromEntries(
      eventPairs.map((result) => [result.id, result.failures]),
    ),
    unavailableEventIntegrationIds: eventPairs
      .filter((result) => result.unavailable)
      .map((result) => result.id),
  };
}

export function commerceStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "connected") {
    return "bg-accent/15 text-accent";
  }
  if (normalized === "error") return "bg-destructive/15 text-destructive-emphasis";
  return "bg-muted text-muted-foreground";
}

export function commerceSyncClass(tone: CommerceSyncTone): string {
  if (tone === "success") return "bg-accent/15 text-accent";
  if (tone === "danger") return "bg-destructive/15 text-destructive-emphasis";
  if (tone === "warning") return "bg-warning/15 text-warning-emphasis";
  return "bg-muted text-muted-foreground";
}

export function formatCommerceDate(value?: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CommerceIntegrationsPanel() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const commerceKey = useMemo(
    () => [...integrationsBaseKey, "commerce"] as const,
    [integrationsBaseKey],
  );
  const commerceQuery = useQuery({
    queryKey: commerceKey,
    queryFn: loadCommerceOverview,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const items = Array.isArray(commerceQuery.data?.items)
    ? commerceQuery.data?.items
    : [];
  const eventsByIntegration = commerceQuery.data?.eventsByIntegration ?? {};
  const unavailableEvents = new Set(
    commerceQuery.data?.unavailableEventIntegrationIds ?? [],
  );
  const loading =
    meQuery.isLoading || (commerceQuery.isPending && !commerceQuery.data);
  const error =
    commerceQuery.error instanceof Error
      ? commerceQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : null;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Native commerce</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Shopify runtime state and recent sync failures.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
            <Link href={asRoute("/app/commerce")}>
              <Layers3 aria-hidden="true" />
              Open commerce workspace
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => {
              void meQuery.refetch();
              void commerceQuery.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {/* A failed overview read leaves `items` empty too. Without the error
          guard, a store owner whose Shopify connection exists but whose read
          failed is told they have none and invited to connect a second one. */}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={ShoppingBag}
          title="No native commerce integrations"
          description="Connect Shopify to sync store data and surface runtime sync state and recent failures here."
          action={
            <Button asChild variant="outline">
              <Link href={asRoute("/app/commerce")}>Connect in the commerce workspace</Link>
            </Button>
          }
        />
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const syncLabel = commerceSyncStateLabel(item);
          const syncTone = commerceSyncStateTone(item);
          const failures = eventsByIntegration[item.id] ?? [];
          return (
            <div
              key={item.id}
              className="border border-border rounded-md bg-card p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="break-all text-sm font-medium">
                      {item.shop_domain || item.id}
                    </div>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full ${commerceStatusClass(
                        item.status,
                      )}`}
                    >
                      {item.status ? humanizeStatus(item.status) : "Unknown"}
                    </span>
                    {syncLabel ? (
                      <span
                        title={item.sync_state?.last_error || syncLabel}
                        className={`max-w-full truncate text-[11px] px-2 py-0.5 rounded-full ${commerceSyncClass(
                          syncTone,
                        )}`}
                      >
                        {syncLabel}
                      </span>
                    ) : null}
                  </div>
                  {item.error_message ? (
                    <div
                      className="mt-2 break-words text-xs text-destructive"
                      title={item.error_message}
                    >
                      {item.error_message}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground mt-2">
                    {item.provider} · last sync{" "}
                    {formatCommerceDate(item.last_sync_at)}
                  </div>
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <div className="break-all font-mono text-xs text-muted-foreground tabular-nums">
                    {item.sync_state?.operation_id
                      ? item.sync_state.operation_id
                      : "no operation"}
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      href={asRoute(
                        `/app/commerce?tab=stores&store=${encodeURIComponent(item.id)}`,
                      )}
                      aria-label={`Browse data for ${item.shop_domain || item.provider}`}
                    >
                      Browse data
                    </Link>
                  </Button>
                </div>
              </div>

              {unavailableEvents.has(item.id) ? (
                <div
                  className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive-emphasis"
                  role="alert"
                >
                  Recent event history could not be loaded. No absence of sync
                  failures is being claimed.
                </div>
              ) : failures.length > 0 ? (
                <div className="mt-4 border-t border-border pt-3">
                  <div className="text-xs font-medium mb-2">
                    Recent sync failures
                  </div>
                  <div className="space-y-2">
                    {failures.slice(0, 3).map((event) => (
                      <div
                        key={event.id}
                        className="grid gap-1 md:grid-cols-[150px_1fr] text-xs"
                      >
                        <div className="text-muted-foreground tabular-nums">
                          {formatCommerceDate(event.at)}
                        </div>
                        <div className="min-w-0">
                          <div className="break-words text-destructive">
                            {commerceEventError(event) || "sync failed"}
                          </div>
                          {typeof event.metadata?.cursor === "string" ? (
                            <div
                              className="break-all font-mono text-[11px] text-muted-foreground"
                              title={event.metadata.cursor}
                            >
                              {event.metadata.cursor}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
