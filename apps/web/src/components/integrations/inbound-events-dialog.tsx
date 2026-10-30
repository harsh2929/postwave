// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-endpoint received-events view + replay (INTG-003, INTG-024). Surfaces the
// backend GET /inbound-webhooks/{id}/events log so an operator can see whether
// events arrived, what the payload was, and whether the signature validated.
// Each verified row can be submitted to the durable replay planner via
// POST …/events/{event_id}/replay. That can enqueue subscriber-affecting
// actions, so a retryable confirmation holds one stable idempotency key.
// Payloads render as escaped text in <pre>.
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

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
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  listInboundWebhookEvents,
  replayInboundEvent,
  type InboundEvent,
} from "@/lib/inbound-webhooks-api";
import {
  canAdminInboundWebhooks,
  INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE,
  verifyFreshInboundWebhookAdmin,
} from "@/lib/inbound-webhook-authority";
import { boundPreview, prettyJson } from "@/lib/json-preview";
import { Inbox } from "lucide-react";

export function InboundEventsDialog({
  endpointId,
  endpointName,
  identity,
  baseKey,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  endpointId: string;
  endpointName: string;
  identity: MeResponse;
  /** Tenant/role-scoped base query key for this endpoint's data. */
  baseKey: readonly unknown[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exact row action that opened this programmatically controlled dialog. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const [replayAttempt, setReplayAttempt] = useState<{
    eventId: number;
    idempotencyKey: string;
  } | null>(null);
  const [replayPending, setReplayPending] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayGuard = useRef(false);
  const canAdmin = canAdminInboundWebhooks(identity);

  const eventsKey = useMemo(
    () => [...baseKey, "events", endpointId] as const,
    [baseKey, endpointId],
  );
  const eventsQuery = useQuery({
    queryKey: eventsKey,
    queryFn: ({ signal }) =>
      listInboundWebhookEvents(endpointId, 50, { signal }),
    enabled: open && canAdmin,
    // The request layer already performs bounded transport/status retries.
    // Avoid multiplying those attempts here; the dialog keeps a visible,
    // operator-controlled Retry path when the bounded request still fails.
    retry: false,
  });
  const items = Array.isArray(eventsQuery.data?.items)
    ? eventsQuery.data.items
    : [];
  const error =
    eventsQuery.error instanceof Error
      ? eventsQuery.error.message
      : eventsQuery.isError
        ? "Could not load inbound events."
        : null;

  useEffect(() => {
    if (canAdmin) return;
    const filter = { queryKey: eventsKey, exact: true } as const;
    void queryClient.cancelQueries(filter).finally(() => {
      queryClient.removeQueries(filter);
    });
    setReplayAttempt(null);
    setReplayError(null);
  }, [canAdmin, eventsKey, queryClient]);

  function beginReplay(eventId: number): void {
    if (!canAdmin) {
      setReplayError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    setReplayError(null);
    setReplayAttempt({ eventId, idempotencyKey: newUUIDv7() });
  }

  async function onReplay() {
    if (!replayAttempt || replayGuard.current) return;
    if (!canAdmin) {
      setReplayError(INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE);
      return;
    }
    replayGuard.current = true;
    setReplayPending(true);
    setReplayError(null);
    try {
      await verifyFreshInboundWebhookAdmin(identity);
      const res = await replayInboundEvent(
        endpointId,
        replayAttempt.eventId,
        replayAttempt.idempotencyKey,
      );
      const matched = res.matches.length;
      const executed = res.matches.filter((match) => match.executed).length;
      const queued = res.matches.filter(
        (match) => match.queued && !match.executed,
      ).length;
      const failed = res.matches.filter(
        (match) => !match.queued && !match.executed,
      ).length;
      if (matched === 0) {
        toast.info("Replay completed — no active triggers matched this event.");
      } else if (failed > 0) {
        toast.warning(
          `Replay accepted — ${matched} trigger${matched === 1 ? "" : "s"} matched; ${queued} action${queued === 1 ? "" : "s"} queued, ${executed} already executed, ${failed} could not be queued.`,
        );
      } else {
        toast.success(
          `Replay accepted — ${matched} trigger${matched === 1 ? "" : "s"} matched; ${queued} action${queued === 1 ? "" : "s"} queued${executed > 0 ? `, ${executed} already executed` : ""}.`,
        );
      }
      void queryClient.invalidateQueries({
        queryKey: eventsKey,
        exact: false,
      });
      setReplayAttempt(null);
    } catch (e) {
      setReplayError(apiErrorMessage(e, "Replay failed"));
    } finally {
      replayGuard.current = false;
      setReplayPending(false);
    }
  }

  const closeReplay = (): void => {
    if (replayGuard.current) return;
    setReplayAttempt(null);
    setReplayError(null);
  };

  const handleOuterOpenChange = (next: boolean): void => {
    if (!next && replayGuard.current) return;
    if (!next) closeReplay();
    onOpenChange(next);
    if (!next && returnFocusRef) {
      window.requestAnimationFrame(() => {
        const trigger = returnFocusRef.current;
        if (trigger?.isConnected) trigger.focus();
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOuterOpenChange}>
      <DialogContent
        className="max-w-2xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          const trigger = returnFocusRef?.current;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-words">
            Recent events · {endpointName}
          </DialogTitle>
          <DialogDescription>
            The 50 most recent events received at this endpoint, newest first.
          </DialogDescription>
        </DialogHeader>

        <div
          className="max-h-[60vh] space-y-3 overflow-y-auto rounded-sm pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role={items.length > 0 ? "region" : undefined}
          aria-label={items.length > 0 ? "Recent inbound events" : undefined}
          tabIndex={items.length > 0 ? 0 : undefined}
        >
          {!canAdmin ? (
            <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE} No event payload was
              requested.
            </p>
          ) : eventsQuery.isPending ? (
            <div
              className="space-y-2"
              role="status"
              aria-label="Loading recent inbound events"
            >
              <span className="sr-only">Loading recent inbound events…</span>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : error ? (
            <div
              className="flex flex-col items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
              role="alert"
            >
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={eventsQuery.isFetching}
                onClick={() => void eventsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No events yet"
              description="Once an external system POSTs to this endpoint's ingest URL, received events appear here with their payload and signature status."
            />
          ) : (
            items.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                canReplay={canAdmin}
                onReplay={() => beginReplay(event.id)}
              />
            ))
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOuterOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>

        <Dialog
          open={replayAttempt !== null}
          onOpenChange={(next) => {
            if (!next) closeReplay();
          }}
        >
          <DialogContent
            aria-busy={replayPending}
            onEscapeKeyDown={(event) => {
              if (replayGuard.current) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (replayGuard.current) event.preventDefault();
            }}
            className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
          >
            <DialogHeader>
              <DialogTitle>Replay this event?</DialogTitle>
              <DialogDescription>
                This queues a new durable attempt for every active trigger that
                matches the stored payload. Those actions can enroll
                subscribers, change tags, or start automations. Use it after
                fixing a trigger that should have fired.
              </DialogDescription>
            </DialogHeader>
            {replayError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p className="font-medium">Replay was not accepted.</p>
                <p className="mt-1 break-words">{replayError}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Retry reuses this attempt&apos;s idempotency key, so it cannot
                  create a second semantic replay.
                </p>
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={replayPending}
                onClick={closeReplay}
              >
                Cancel
              </Button>
              <Button
                type="button"
                loading={replayPending}
                onClick={() => void onReplay()}
              >
                {replayError ? "Retry replay" : "Replay event"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function EventRow({
  event,
  canReplay,
  onReplay,
}: {
  event: InboundEvent;
  canReplay: boolean;
  onReplay: () => void;
}) {
  const [showBody, setShowBody] = useState(false);
  const payloadId = useId();
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <RelativeTime
            iso={event.received_at}
            className="text-muted-foreground"
          />
          <Badge variant={event.signature_valid ? "success" : "destructive"}>
            {event.signature_valid
              ? "signature valid"
              : "signature invalid or missing"}
          </Badge>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowBody((v) => !v)}
            aria-expanded={showBody}
            aria-controls={payloadId}
            className="min-h-11 sm:min-h-8"
          >
            {showBody ? "Hide payload" : "View payload"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={!event.signature_valid || !canReplay}
            title={
              !canReplay
                ? INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE
                : event.signature_valid
                  ? undefined
                  : "Only signature-verified events can be replayed"
            }
            onClick={onReplay}
          >
            {event.signature_valid ? "Replay" : "Replay unavailable"}
          </Button>
        </div>
      </div>
      {showBody ? (
        <pre
          id={payloadId}
          tabIndex={0}
          aria-label="Inbound event payload"
          className="mt-2 max-h-56 max-w-full overflow-auto rounded bg-muted p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {boundPreview(prettyJson(event.body)) || "(empty or non-text body)"}
        </pre>
      ) : null}
    </div>
  );
}
