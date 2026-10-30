// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Deliveries panel for one outbound destination (platform-117…121) — the web
 * rendering of desktop's OutboundWebhookDeliveriesSlideover.
 *
 * It reads `/api/v1/outbound-webhooks/{id}/deliveries` (the
 * outbound_webhook_deliveries table). That is NOT settings/webhooks'
 * `/api/v1/webhooks/{id}/deliveries`, a different entity with its own table.
 *
 * Every state shown comes from the server: the panel never guesses whether a
 * delivery is still retrying or exhausted. Replay is a live verb — it clones a
 * completed delivery into a new pending row and may repeat receiver side
 * effects — so it goes through a confirm that names that consequence, carries
 * one Idempotency-Key per logical replay (reused if the operator retries after
 * an ambiguous failure), re-checks admin authority first, and is disabled
 * while in flight.
 *
 * Mounted through the destinations page's `rowActionSlot`, so the host page
 * file stays untouched.
 */

import { useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { apiErrorMessage, isApiError } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  canAdminOutboundWebhooks,
  confirmFreshOutboundWebhookAdmin,
} from "@/lib/outbound-webhook-authority";
import {
  listOutboundWebhookDeliveries,
  outboundWebhookKeys,
  outboundWebhookReplayBlock,
  replayOutboundWebhookDelivery,
  type OutboundWebhookDelivery,
  type OutboundWebhookDeliveryPage,
  type OutboundWebhookDeliveryStatus,
  type OutboundWebhookRecord,
  type OutboundWebhookReplayResult,
} from "@/lib/outbound-webhooks-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { OutboundWebhookHealthCard } from "./outbound-webhook-health-card";
import { OutboundWebhooksClient } from "./outbound-webhooks-client";
import { VerificationSnippetDialog } from "./verification-snippet-dialog";

const STATUS_COPY: Record<
  OutboundWebhookDeliveryStatus,
  {
    label: string;
    variant: "warning" | "success" | "destructive" | "secondary";
  }
> = {
  pending: { label: "Pending", variant: "warning" },
  delivered: { label: "Delivered", variant: "success" },
  exhausted: { label: "Retries exhausted", variant: "destructive" },
  skipped: { label: "Cancelled by deletion", variant: "secondary" },
};

function when(value: string | undefined): string {
  return formatWireTimestamp(value, "—");
}

/** Terminal failures among the LOADED rows in the trailing 24 hours. */
function failureRollup(rows: OutboundWebhookDelivery[]): string | null {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const failures = rows.filter((delivery) => {
    const created = Date.parse(delivery.created_at);
    return (
      Number.isFinite(created) &&
      created >= cutoff &&
      delivery.status === "exhausted"
    );
  }).length;
  return failures > 0
    ? `${failures} terminal failure${failures === 1 ? "" : "s"} in the loaded trailing 24-hour window.`
    : null;
}

export function replaySentence(
  delivery: OutboundWebhookDelivery,
  webhook: OutboundWebhookRecord,
): string {
  return `This queues ${delivery.event_type} to ${webhook.url} with a new delivery ID and the same event identity metadata. The signature authenticates the body only: receivers may safely deduplicate only an identity retained inside that signed body. Otherwise side effects may repeat.`;
}

interface ReplayOperation {
  delivery: OutboundWebhookDelivery;
  idempotencyKey: string;
  openedIdentity: MeResponse;
  principalKey: string;
}

/** Row trigger rendered through the destinations page's `rowActionSlot`. */
export function OutboundWebhookDeliveriesAction({
  webhook,
}: {
  webhook: OutboundWebhookRecord;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Deliveries for ${webhook.url}`}
        onClick={() => setOpen(true)}
      >
        Deliveries
      </Button>
      {open ? (
        <OutboundWebhookDeliveriesPanel
          webhook={webhook}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function renderDeliveriesRowAction(webhook: OutboundWebhookRecord) {
  return <OutboundWebhookDeliveriesAction webhook={webhook} />;
}

/** The destinations page with the Deliveries row action wired in. */
export function OutboundWebhooksWithDeliveries() {
  return <OutboundWebhooksClient rowActionSlot={renderDeliveriesRowAction} />;
}

export function OutboundWebhookDeliveriesPanel({
  webhook,
  onClose,
}: {
  webhook: OutboundWebhookRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data;
  const canAdmin = canAdminOutboundWebhooks(me);
  const tenantId = me?.tenant_id ?? "pending";
  const role = me ? effectiveAuthRole(me) : null;
  const principalKey = exactPrincipalKey(me);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [replayTarget, setReplayTarget] =
    useState<OutboundWebhookDelivery | null>(null);
  const [replayReceipt, setReplayReceipt] =
    useState<OutboundWebhookReplayResult | null>(null);
  /** One key per logical replay: minted on open, kept across a retry. */
  const replayKeyRef = useRef<string | null>(null);

  const history = useInfiniteQuery({
    queryKey: outboundWebhookKeys.deliveries(
      tenantId,
      role,
      webhook.id,
      principalKey,
    ),
    queryFn: ({ pageParam, signal }) =>
      listOutboundWebhookDeliveries(webhook.id, {
        cursor: pageParam || undefined,
        signal,
      }),
    initialPageParam: "",
    // A cursor the server already handed out would re-append rows; stop
    // paging instead of looping.
    getNextPageParam: (lastPage, _pages, lastPageParam, allPageParams) => {
      const next = lastPage.next_cursor;
      if (!next || next === lastPageParam || allPageParams.includes(next)) {
        return undefined;
      }
      return next;
    },
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: 0,
  });

  const pages = history.data?.pages;
  const { rows, duplicates } = useMemo(() => {
    const seen = new Set<string>();
    const out: OutboundWebhookDelivery[] = [];
    let dropped = 0;
    for (const page of pages ?? []) {
      for (const delivery of page.deliveries) {
        if (seen.has(delivery.id)) {
          dropped += 1;
          continue;
        }
        seen.add(delivery.id);
        out.push(delivery);
      }
    }
    return { rows: out, duplicates: dropped };
  }, [pages]);
  const lastPage = pages?.at(-1);
  const repeatedCursor = Boolean(lastPage?.next_cursor && !history.hasNextPage);
  const staleRemoved =
    !pages &&
    history.isError &&
    isApiError(history.error) &&
    history.error.status === 404;
  const rollup = useMemo(() => failureRollup(rows), [rows]);
  const replayBlock = outboundWebhookReplayBlock(webhook);

  const replayMutation = useMutation({
    mutationFn: async (operation: ReplayOperation) => {
      await confirmFreshOutboundWebhookAdmin(operation.openedIdentity);
      if (principalKeyRef.current !== operation.principalKey) {
        throw new Error(
          "Workspace identity changed while this replay was open. Nothing was queued; refresh before trying again.",
        );
      }
      return replayOutboundWebhookDelivery(operation.delivery.id, {
        idempotencyKey: operation.idempotencyKey,
      });
    },
    onSuccess: async (receipt, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      replayKeyRef.current = null;
      setReplayReceipt(receipt);
      toast.success(`Delivery ${receipt.delivery_id} queued.`);
      // History, health, and the destination list all move after a replay.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: outboundWebhookKeys.all(tenantId, role, principalKey),
        }),
        queryClient.invalidateQueries({
          queryKey: base("routing", tenantId, role),
        }),
      ]);
    },
  });

  function beginReplay(delivery: OutboundWebhookDelivery) {
    replayKeyRef.current = newUUIDv7();
    setReplayTarget(delivery);
  }

  const replaying = replayMutation.isPending;

  let body;
  if (meQuery.isPending) {
    body = (
      <div aria-busy="true" aria-label="Loading identity" className="space-y-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (meQuery.isError || !me) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          {apiErrorMessage(
            meQuery.error,
            "Your role could not be confirmed, so no delivery history was requested.",
          )}
        </AlertDescription>
      </Alert>
    );
  } else if (!canAdmin) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>Administrator access required</AlertTitle>
        <AlertDescription>
          {OUTBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No delivery history was
          requested.
        </AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <>
        {staleRemoved ? (
          <Alert variant="warning">
            <AlertDescription>
              This destination was permanently removed after this view opened.
              Per-endpoint history is no longer available here; retained
              cancellation evidence remains in tenant-wide delivery diagnostics.
              Close this panel and refresh the destination list.
            </AlertDescription>
          </Alert>
        ) : null}

        {replayBlock ? (
          <Alert variant="warning">
            <AlertDescription id={`replay-block-${webhook.id}`}>
              Replay is unavailable: {replayBlock}
            </AlertDescription>
          </Alert>
        ) : null}

        {replayReceipt ? (
          <Alert role="status">
            <AlertDescription>
              Replay queued as delivery{" "}
              <span className="font-mono">{replayReceipt.delivery_id}</span>{" "}
              (from{" "}
              <span className="font-mono">{replayReceipt.replayed_from}</span>
              ). It is pending on the server and appears in the history below.
            </AlertDescription>
          </Alert>
        ) : null}

        {rollup ? (
          <p className="text-sm text-destructive-emphasis">{rollup}</p>
        ) : null}

        {!staleRemoved ? (
          <OutboundWebhookHealthCard
            webhookId={webhook.id}
            tenantId={tenantId}
            role={role}
            principalKey={principalKey}
          />
        ) : null}

        <section aria-label="Signing configuration" className="space-y-2">
          <h3 className="text-sm font-semibold">Signing</h3>
          <p className="text-xs text-muted-foreground">
            {webhook.signing_algorithm ?? "Signing algorithm not reported"}
            {webhook.secondary_expires_at
              ? ` · dual-signing during key rotation until ${when(
                  webhook.secondary_expires_at,
                )}`
              : ""}
          </p>
          {webhook.signing_public_key ? (
            <details className="text-xs">
              <summary className="cursor-pointer">
                Public verification key
              </summary>
              <pre
                tabIndex={0}
                aria-label="Public verification key"
                className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <code>{webhook.signing_public_key}</code>
              </pre>
            </details>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={replaying}
            onClick={() => setVerifyOpen(true)}
          >
            Show verification snippet
          </Button>
        </section>

        {!staleRemoved ? (
          <DeliveryHistory
            history={history}
            rows={rows}
            duplicates={duplicates}
            repeatedCursor={repeatedCursor}
            webhook={webhook}
            replaying={replaying}
            replayBlock={replayBlock}
            onReplay={beginReplay}
          />
        ) : null}

        <VerificationSnippetDialog
          open={verifyOpen}
          onOpenChange={setVerifyOpen}
          signingAlgorithm={webhook.signing_algorithm}
        />

        <ConfirmDialog
          open={replayTarget !== null && !replayBlock}
          onOpenChange={(open) => {
            if (open) return;
            setReplayTarget(null);
            replayKeyRef.current = null;
          }}
          title="Replay this live delivery?"
          description={
            replayTarget ? (
              <>
                {replaySentence(replayTarget, webhook)}
                <span className="mt-2 block font-mono text-xs">
                  Original delivery: {replayTarget.id}
                </span>
              </>
            ) : (
              ""
            )
          }
          confirmLabel="Replay delivery"
          confirmVariant="destructive"
          onConfirm={async () => {
            if (!replayTarget || !me) return;
            const idempotencyKey = replayKeyRef.current ?? newUUIDv7();
            replayKeyRef.current = idempotencyKey;
            try {
              await replayMutation.mutateAsync({
                delivery: replayTarget,
                idempotencyKey,
                openedIdentity: me,
                principalKey,
              });
            } catch (error) {
              // The key stays: a retry of an ambiguous failure is the same
              // logical replay, which the server deduplicates.
              throw new Error(
                apiErrorMessage(error, "The replay request failed."),
              );
            }
          }}
        />
      </>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !replaying) onClose();
      }}
    >
      <DialogContent className="max-w-4xl" closeDisabled={replaying}>
        <DialogHeader>
          <DialogTitle>Recent deliveries</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {webhook.url}
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

type HistoryQuery = UseInfiniteQueryResult<
  InfiniteData<OutboundWebhookDeliveryPage, unknown>,
  Error
>;

function DeliveryHistory({
  history,
  rows,
  duplicates,
  repeatedCursor,
  webhook,
  replaying,
  replayBlock,
  onReplay,
}: {
  history: Pick<
    HistoryQuery,
    | "data"
    | "error"
    | "isPending"
    | "isError"
    | "isFetching"
    | "isFetchingNextPage"
    | "isFetchNextPageError"
    | "isRefetchError"
    | "hasNextPage"
    | "isEnabled"
    | "fetchNextPage"
    | "refetch"
  >;
  rows: OutboundWebhookDelivery[];
  duplicates: number;
  repeatedCursor: boolean;
  webhook: OutboundWebhookRecord;
  replaying: boolean;
  replayBlock: string | null;
  onReplay: (delivery: OutboundWebhookDelivery) => void;
}) {
  let content;
  if (history.isPending) {
    content = (
      <div role="status" aria-live="polite" className="text-sm">
        Loading delivery history…
      </div>
    );
  } else if (history.isError && !history.data) {
    content = (
      <Alert variant="destructive">
        <AlertDescription>
          Couldn&apos;t load deliveries:{" "}
          {apiErrorMessage(
            history.error,
            "the history request failed; this is not an empty history.",
          )}{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            loading={history.isFetching}
            onClick={() => void history.refetch()}
          >
            Retry loading deliveries
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    content = (
      <p className="text-sm text-muted-foreground">
        No deliveries have been recorded for this destination.
      </p>
    );
  } else {
    content = (
      <>
        {history.isRefetchError ? (
          <Alert variant="destructive">
            <AlertDescription>
              Couldn&apos;t refresh deliveries:{" "}
              {apiErrorMessage(history.error, "the refresh failed.")} Previously
              verified deliveries remain visible and may be stale.
            </AlertDescription>
          </Alert>
        ) : null}
        {duplicates > 0 ? (
          <p className="text-xs text-muted-foreground">
            The server returned {duplicates} duplicate{" "}
            {duplicates === 1 ? "delivery" : "deliveries"}; each is shown once.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length.toLocaleString()}{" "}
          {rows.length === 1 ? "delivery" : "deliveries"} loaded newest first.
        </p>
        <TableContainer aria-label={`Delivery history for ${webhook.url}`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Outcome and schedule</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((delivery) => {
                const status = STATUS_COPY[delivery.status];
                const output =
                  delivery.last_error ||
                  delivery.last_response_body_truncated ||
                  "—";
                return (
                  <TableRow key={delivery.id}>
                    <TableCell className="align-top">
                      <div className="font-mono text-xs">
                        {delivery.event_type}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {delivery.id}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      <span className="tabular-nums">
                        {delivery.attempt_count}
                      </span>
                      <div className="text-muted-foreground">
                        Created {when(delivery.created_at)}
                      </div>
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      <div>
                        HTTP {delivery.last_status_code ?? "no response"}
                      </div>
                      <div className="line-clamp-3 break-words text-muted-foreground">
                        {output}
                      </div>
                      {delivery.delivered_at ? (
                        <div className="text-muted-foreground">
                          Delivered {when(delivery.delivered_at)}
                        </div>
                      ) : null}
                      {delivery.next_attempt_at ? (
                        <div className="text-muted-foreground">
                          Next retry {when(delivery.next_attempt_at)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      {delivery.status === "pending" ? (
                        <span className="text-xs text-muted-foreground">
                          Queued by server
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Replay delivery ${delivery.id}`}
                          aria-describedby={
                            replayBlock
                              ? `replay-block-${webhook.id}`
                              : undefined
                          }
                          disabled={
                            replaying ||
                            history.isFetchingNextPage ||
                            Boolean(replayBlock)
                          }
                          onClick={() => onReplay(delivery)}
                        >
                          Replay
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        {history.isFetchNextPageError ? (
          <Alert variant="destructive">
            <AlertDescription>
              Couldn&apos;t load older deliveries:{" "}
              {apiErrorMessage(history.error, "the request failed.")} The loaded
              rows are unchanged.
            </AlertDescription>
          </Alert>
        ) : null}
        {history.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={history.isFetchingNextPage}
            disabled={history.isFetchingNextPage || replaying}
            onClick={() => void loadNextQueryPage(history, history.isEnabled)}
          >
            {history.isFetchingNextPage
              ? "Loading older…"
              : "Load older deliveries"}
          </Button>
        ) : repeatedCursor ? (
          <p className="text-xs text-muted-foreground">
            The server repeated a delivery-history cursor. Paging stopped
            without adding duplicate rows.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            All available deliveries are loaded.
          </p>
        )}
      </>
    );
  }
  return (
    <section
      aria-label="Recent deliveries"
      aria-busy={history.isPending || history.isFetchingNextPage || undefined}
      className="space-y-2"
    >
      <h3 className="text-sm font-semibold">Delivery history</h3>
      {content}
    </section>
  );
}
