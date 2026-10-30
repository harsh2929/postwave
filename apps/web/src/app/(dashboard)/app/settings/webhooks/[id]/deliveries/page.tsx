// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Eye, RefreshCcw, Send } from "lucide-react";
import { use, useEffect, useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { RelativeTime } from "@/components/relative-time";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  canAdminOutboundWebhooks,
  confirmFreshOutboundWebhookAdmin,
} from "@/lib/outbound-webhook-authority";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import {
  getDelivery,
  listDeliveries,
  listWebhooks,
  replayDelivery,
  type WebhookDelivery,
} from "@/lib/webhooks-api";
import { toast } from "sonner";

import { DeliveryInspectDialog } from "./delivery-inspect-dialog";

function isFailed(d: WebhookDelivery): boolean {
  return !(d.statusCode >= 200 && d.statusCode < 300);
}

function statusVariant(code: number): "default" | "destructive" | "secondary" {
  if (code >= 200 && code < 300) return "default";
  return "destructive";
}

function deliveryNoun(count: number): string {
  return `deliver${count === 1 ? "y" : "ies"}`;
}

export default function WebhookDeliveriesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [failedOnly, setFailedOnly] = useState(false);
  const [replayingId, setReplayingId] = useState<number | null>(null);
  const [replayUnavailable, setReplayUnavailable] = useState(false);
  // SETA-004: the delivery whose request payload is being inspected.
  const [inspectId, setInspectId] = useState<number | null>(null);
  const inspectReturnFocusRef = useRef<HTMLElement | null>(null);
  const refreshFallbackRef = useRef<HTMLButtonElement>(null);
  const replayLocksRef = useRef(new Set<number>());
  const replayControllersRef = useRef(new Set<AbortController>());

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = Boolean(identity?.viewer_mode);
  const canAdmin = canAdminOutboundWebhooks(identity);
  const webhooksScopeKey = useMemo(
    () => qk.settings(tenantId, role, "webhooks"),
    [role, tenantId],
  );
  const protectedBaseKey = useMemo(
    () =>
      [
        ...webhooksScopeKey,
        identity?.user_id ?? "anon",
        viewerMode ? "viewer-mode" : "durable-mode",
      ] as const,
    [identity?.user_id, viewerMode, webhooksScopeKey],
  );
  const identityStamp = `${identity?.user_id ?? "anon"}\u0000${tenantId}\u0000${role ?? "none"}\u0000${viewerMode ? "viewer" : "durable"}`;
  const identityStampRef = useRef(identityStamp);
  identityStampRef.current = identityStamp;
  const previousIdentityRef = useRef<{
    stamp: string;
    key: readonly unknown[];
  } | null>(null);

  // Reuse the webhooks list cache so the endpoint URL (the human-recognizable
  // identity) can head the page instead of a bare UUID (SETA-016).
  const webhooksQuery = useQuery({
    queryKey: protectedBaseKey,
    queryFn: ({ signal }) => listWebhooks({ signal }),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });
  const webhook = webhooksQuery.data?.find((h) => h.id === id) ?? null;

  const deliveriesKey = useMemo(
    () => [...protectedBaseKey, "deliveries", id] as const,
    [id, protectedBaseKey],
  );
  const DELIVERIES_PAGE = 50;
  const deliveriesQuery = useInfiniteQuery({
    queryKey: deliveriesKey,
    queryFn: ({ pageParam, signal }) =>
      listDeliveries(id, {
        before: pageParam,
        limit: DELIVERIES_PAGE,
        signal,
      }),
    initialPageParam: 0,
    // Keyset on the last row's id; a short page means we've reached the end.
    getNextPageParam: (lastPage) =>
      lastPage.length === DELIVERIES_PAGE
        ? lastPage[lastPage.length - 1]?.id
        : undefined,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });
  // SETA-004: fetch the selected delivery's retained request payload on demand.
  const inspectQuery = useQuery({
    queryKey: [...deliveriesKey, "detail", inspectId] as const,
    queryFn: ({ signal }) => getDelivery(id, inspectId as number, { signal }),
    enabled: inspectId != null && meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });

  const clearProtectedState = () => {
    replayControllersRef.current.forEach((controller) => controller.abort());
    replayControllersRef.current.clear();
    replayLocksRef.current.clear();
    inspectReturnFocusRef.current = null;
    setFailedOnly(false);
    setReplayingId(null);
    setReplayUnavailable(false);
    setInspectId(null);
  };

  useEffect(() => {
    const previous = previousIdentityRef.current;
    if (previous && previous.stamp !== identityStamp) {
      clearProtectedState();
      void queryClient.cancelQueries({ queryKey: previous.key });
      queryClient.removeQueries({ queryKey: previous.key });
    }
    previousIdentityRef.current = {
      stamp: identityStamp,
      key: protectedBaseKey,
    };
  }, [identityStamp, protectedBaseKey, queryClient]);

  useEffect(() => {
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    clearProtectedState();
    void queryClient.cancelQueries({ queryKey: webhooksScopeKey });
    queryClient.removeQueries({ queryKey: webhooksScopeKey });
  }, [
    canAdmin,
    meQuery.isPending,
    meQuery.isSuccess,
    queryClient,
    webhooksScopeKey,
  ]);

  useEffect(
    () => () => {
      replayControllersRef.current.forEach((controller) => controller.abort());
    },
    [],
  );

  // `.flat()` throws before the `?? []` is ever reached when `pages` is a
  // truthy non-array, so the guard has to sit on `pages` itself.
  const allRows = Array.isArray(deliveriesQuery.data?.pages)
    ? deliveriesQuery.data.pages.flat()
    : [];
  const rows = failedOnly ? allRows.filter(isFailed) : allRows;
  const failedCount = allRows.filter(isFailed).length;
  const loading =
    meQuery.isPending ||
    (canAdmin && deliveriesQuery.isPending && !deliveriesQuery.data);
  const error =
    deliveriesQuery.error instanceof Error
      ? deliveriesQuery.error.message
      : null;
  // "Failures only" filters the pages fetched so far, not the endpoint's whole
  // history, so an empty filtered view must never read as "this endpoint has
  // never failed" — the failures may simply be further down the log.
  const emptyMessage =
    !failedOnly || allRows.length === 0
      ? "No deliveries yet. Send a test event to populate this log."
      : deliveriesQuery.hasNextPage
        ? `No failures in the ${allRows.length} ${deliveryNoun(allRows.length)} loaded so far. Load more to keep looking.`
        : `No failures in ${allRows.length} ${deliveryNoun(allRows.length)}.`;

  const handleReplay = async (deliveryId: number) => {
    const intent = { webhookId: id, deliveryId };
    if (!meQuery.isSuccess || !identity || !canAdmin) {
      toast.error(OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (replayLocksRef.current.has(intent.deliveryId)) return;
    replayLocksRef.current.add(intent.deliveryId);
    const controller = new AbortController();
    replayControllersRef.current.add(controller);
    const openedIdentityStamp = identityStamp;
    setReplayingId(intent.deliveryId);
    try {
      await confirmFreshOutboundWebhookAdmin(identity, controller.signal);
      if (identityStampRef.current !== openedIdentityStamp) return;
      await replayDelivery(intent.webhookId, intent.deliveryId, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        identityStampRef.current !== openedIdentityStamp
      ) {
        return;
      }
      toast.success("Delivery re-queued.");
      void deliveriesQuery.refetch();
    } catch (err) {
      if (
        controller.signal.aborted ||
        identityStampRef.current !== openedIdentityStamp
      ) {
        return;
      }
      if (err instanceof ApiError && err.status === 503) {
        // Outbox dispatcher isn't wired in this deployment — disable further
        // attempts and explain why, rather than letting every click 503.
        setReplayUnavailable(true);
        toast.error(
          "Redelivery isn't available in this deployment (outbox dispatcher not wired).",
        );
      } else if (err instanceof ApiError && err.status === 422) {
        toast.error(
          "This delivery pre-dates payload retention, so it can't be replayed.",
        );
      } else {
        toast.error(
          err instanceof Error ? err.message : "Could not redeliver.",
        );
      }
    } finally {
      replayLocksRef.current.delete(intent.deliveryId);
      replayControllersRef.current.delete(controller);
      if (identityStampRef.current === openedIdentityStamp) {
        setReplayingId(null);
      }
    }
  };

  const breadcrumb = (
    <Breadcrumb
      items={[
        { label: "Settings", href: asRoute("/app/settings") },
        { label: "Webhooks", href: asRoute("/app/settings/webhooks") },
        { label: "Deliveries" },
      ]}
    />
  );

  if (meQuery.isPending) {
    return (
      <div className="space-y-4">
        {breadcrumb}
        <Card>
          <CardContent className="space-y-2 pt-6">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (meQuery.error) {
    return (
      <div className="space-y-4">
        {breadcrumb}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Webhook deliveries</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-destructive" role="alert">
              Workspace identity could not be verified. No webhook endpoint,
              delivery, or retained payload request was made.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void meQuery.refetch()}
            >
              Retry identity check
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canAdmin) {
    return (
      <div className="space-y-4">
        {breadcrumb}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Webhook deliveries</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">
              Owner or admin access required
            </p>
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              {OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No endpoint, delivery, or
              retained payload data was fetched.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {breadcrumb}
      <Card>
        <CardHeader className="items-start justify-between gap-3 sm:flex-row">
          <div className="min-w-0">
            <CardTitle as="h2">Webhook deliveries</CardTitle>
            <CardDescription className="break-all font-mono text-xs">
              {webhook?.url ?? id}
            </CardDescription>
            {webhook?.url ? (
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {id}
              </p>
            ) : null}
            {!webhook && webhooksQuery.isError ? (
              <p className="mt-0.5 text-[11px] text-destructive">
                Could not load this endpoint&apos;s URL — showing its ID
                instead.
              </p>
            ) : null}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
            <div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
              <Select
                aria-label="Filter deliveries"
                value={failedOnly ? "failed" : "all"}
                onChange={(e) => setFailedOnly(e.target.value === "failed")}
              >
                <option value="all">All deliveries</option>
                {/* Counted over the loaded pages only; "+" says more are
                    unexamined behind "Load more". */}
                <option value="failed">
                  Failures only ({failedCount}
                  {deliveriesQuery.hasNextPage ? "+" : ""})
                </option>
              </Select>
            </div>
            <Button
              ref={refreshFallbackRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isFetching}
              onClick={() => void deliveriesQuery.refetch()}
            >
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm text-destructive" role="alert">
                Could not load deliveries: {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void meQuery.refetch();
                  void deliveriesQuery.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              {/* A tooltip is unreachable on touch, so the reason every
                  Redeliver is dead is stated once, in text, for both layouts. */}
              {replayUnavailable ? (
                <p
                  role="status"
                  className="mb-3 rounded-md border p-3 text-xs text-muted-foreground"
                >
                  Redelivery isn&apos;t available in this deployment (outbox
                  dispatcher not wired), so every Redeliver button is disabled.
                  The delivery history below is unaffected.
                </p>
              ) : null}
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
              ) : (
                <>
                  {/* SETA-049: mobile reflows the delivery table to stacked cards. */}
                  <div className="space-y-2 sm:hidden">
                    {rows.map((d) => (
                      <div key={d.id} className="rounded-md border p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-xs break-all">
                            {d.event}
                          </span>
                          <Badge variant={statusVariant(d.statusCode)}>
                            {d.statusCode || "ERR"}
                          </Badge>
                        </div>
                        {d.error ? (
                          <p className="mt-1 break-all text-[11px] text-muted-foreground">
                            {d.error}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-col items-start justify-between gap-2 text-xs text-muted-foreground min-[360px]:flex-row min-[360px]:items-center">
                          <span>
                            #{d.attempt} · {d.responseMs} ms ·{" "}
                            <RelativeTime iso={d.at} />
                          </span>
                          <div className="flex w-full flex-wrap items-center gap-1 min-[360px]:w-auto">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={(event) => {
                                inspectReturnFocusRef.current =
                                  event.currentTarget;
                                setInspectId(d.id);
                              }}
                            >
                              <Eye className="h-4 w-4" />
                              Inspect
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={
                                replayingId === d.id || replayUnavailable
                              }
                              title={
                                replayUnavailable
                                  ? "Redelivery isn't available in this deployment."
                                  : "Re-queue this event for delivery"
                              }
                              onClick={() => void handleReplay(d.id)}
                            >
                              <Send className="h-4 w-4" />
                              {replayingId === d.id ? "Sending…" : "Redeliver"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <TableContainer
                    aria-label="Webhook delivery history"
                    className="hidden sm:block"
                  >
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Event</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Attempt</TableHead>
                          <TableHead>Latency</TableHead>
                          <TableHead>At</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((d) => (
                          <TableRow key={d.id} className="align-top">
                            <TableCell className="font-mono text-xs">
                              {d.event}
                            </TableCell>
                            <TableCell>
                              <Badge variant={statusVariant(d.statusCode)}>
                                {d.statusCode || "ERR"}
                              </Badge>
                              {d.error ? (
                                <div className="mt-1 break-all text-[11px] text-muted-foreground">
                                  {d.error}
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              #{d.attempt}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {d.responseMs} ms
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <RelativeTime iso={d.at} />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  title="Inspect the request payload sent for this delivery"
                                  onClick={(event) => {
                                    inspectReturnFocusRef.current =
                                      event.currentTarget;
                                    setInspectId(d.id);
                                  }}
                                >
                                  <Eye className="h-4 w-4" />
                                  Inspect
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={
                                    replayingId === d.id || replayUnavailable
                                  }
                                  title={
                                    replayUnavailable
                                      ? "Redelivery isn't available in this deployment."
                                      : "Re-queue this event for delivery"
                                  }
                                  onClick={() => void handleReplay(d.id)}
                                >
                                  <Send className="h-4 w-4" />
                                  {replayingId === d.id
                                    ? "Sending…"
                                    : "Redeliver"}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </>
              )}
              {deliveriesQuery.hasNextPage ? (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void loadNextQueryPage(
                        deliveriesQuery,
                        deliveriesQuery.isEnabled,
                      )
                    }
                    disabled={deliveriesQuery.isFetchingNextPage}
                  >
                    {deliveriesQuery.isFetchingNextPage
                      ? "Loading…"
                      : "Load more"}
                  </Button>
                </div>
              ) : (
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  {allRows.length} deliver
                  {allRows.length === 1 ? "y" : "ies"} · all loaded
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <DeliveryInspectDialog
        open={inspectId != null}
        returnFocusRef={inspectReturnFocusRef}
        fallbackFocusRef={refreshFallbackRef}
        onOpenChange={(next) => {
          if (!next) setInspectId(null);
        }}
        detail={inspectQuery.data ?? null}
        loading={inspectQuery.isPending}
        error={
          inspectQuery.error instanceof Error
            ? inspectQuery.error.message
            : inspectQuery.isError
              ? "Could not load this delivery — this is a failed request, not a delivery with no payload."
              : null
        }
      />
    </div>
  );
}
