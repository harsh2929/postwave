// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, Radio, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { qk, STALE } from "@/lib/query-keys";
import { listSegments } from "@/lib/segments-api";
import {
  cancelSmsBroadcast,
  createSmsBroadcast,
  deleteSmsBroadcast,
  getSmsBroadcastProgress,
  listSmsBroadcasts,
  sendSmsBroadcast,
  updateSmsBroadcast,
  type SmsBroadcast,
  type SmsBroadcastUpsert,
  type SmsBroadcastsPage,
  type SmsList,
} from "@/lib/sms-api";
import { SmsBroadcastComposerDialog } from "./sms-broadcast-composer-dialog";
import {
  canCancelSmsBroadcast,
  canDeleteSmsBroadcast,
  canEditSmsBroadcast,
  canSendSmsBroadcast,
  smsBroadcastArmsLater,
  smsBroadcastAudienceSummary,
  smsBroadcastDispatchHoldCopy,
  smsBroadcastProgressPct,
  smsBroadcastStatusBadge,
  type SmsBroadcastAudienceLookup,
} from "./sms-broadcast-helpers";
import { CardLoadError } from "./sms-card-states";

const PAGE_SIZE = 50;
const PROGRESS_REFRESH_MS = 5_000;

type BroadcastsInfiniteData = {
  pages: SmsBroadcastsPage[];
  pageParams: unknown[];
};

interface SmsBroadcastsCardProps {
  baseKey: readonly unknown[];
  enabled: boolean;
  tenantId: string;
  userId: string;
  /** SMS lists already loaded by the workspace (audience names + picker). */
  lists: SmsList[];
}

/**
 * Broadcasts tab: list (refresh / load more / dispatch-readiness banner),
 * composer (create + edit), Send now / Schedule, cancel and delete behind
 * confirms, and a per-row delivery-progress drilldown that polls while the
 * broadcast is sending.
 *
 * Send now / Schedule (messaging-29) is the full verb — confirm quoting the
 * audience, then POST /api/v1/sms/broadcasts/{id}/send — but it is gated the
 * way desktop gates it: the list payload's `broadcastDispatchAvailable`
 * verdict. While the server holds dispatch (`sms_broadcast_dispatch_release_
 * held`) every Send/Schedule control is disabled with the hold sentence as
 * its description and no dispatch request is made.
 */
export function SmsBroadcastsCard({
  baseKey,
  enabled,
  tenantId,
  userId,
  lists,
}: SmsBroadcastsCardProps) {
  const queryClient = useQueryClient();
  const key = useMemo(() => [...baseKey, "broadcasts"] as const, [baseKey]);
  const segmentsKey = useMemo(
    () => [...baseKey, "broadcast-segments"] as const,
    [baseKey],
  );
  const writes = useRef(new Set<AbortController>());
  const writeBusyRef = useRef(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [composer, setComposer] = useState<{
    existing: SmsBroadcast | null;
  } | null>(null);
  const [sendTarget, setSendTarget] = useState<SmsBroadcast | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SmsBroadcast | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmsBroadcast | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const composerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sendTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const ownedWrites = writes.current;
    return () => {
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      writeBusyRef.current = false;
      void queryClient.cancelQueries({ queryKey: key, exact: false });
      queryClient.removeQueries({ queryKey: key, exact: false });
    };
  }, [enabled, key, queryClient, tenantId, userId]);

  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listSmsBroadcasts({
        tenantId,
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    staleTime: STALE.list,
  });
  const segmentsQuery = useQuery({
    queryKey: segmentsKey,
    queryFn: () => listSegments(),
    enabled,
    staleTime: STALE.list,
  });

  const pages = useMemo(
    () => (Array.isArray(query.data?.pages) ? query.data.pages : []),
    [query.data?.pages],
  );
  const firstPage = pages[0] ?? null;
  // Pages share one insertion cutoff; a later page from a different cutoff
  // cannot be merged honestly with the earlier ones.
  const snapshotDrift =
    pages.length > 1 &&
    pages.some((page) => page.snapshotAt !== firstPage?.snapshotAt);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: SmsBroadcast[] = [];
    for (const page of pages) {
      for (const row of page.items) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }
    }
    return out;
  }, [pages]);
  const lookup = useMemo<SmsBroadcastAudienceLookup>(
    () => ({
      lists,
      segments: Array.isArray(segmentsQuery.data) ? segmentsQuery.data : [],
    }),
    [lists, segmentsQuery.data],
  );
  const loaded = Boolean(enabled && query.isSuccess && !snapshotDrift);
  const refreshing = query.isFetching && !query.isFetchingNextPage;

  const refetch = () =>
    queryClient.resetQueries({ queryKey: key, exact: true });
  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: key, exact: true });

  const reauthorize = async () => {
    const current = await whoami();
    queryClient.setQueryData(qk.authMe(), current);
    const role = effectiveAuthRole(current);
    if (
      current.tenant_id !== tenantId ||
      current.user_id !== userId ||
      current.viewer_mode === true ||
      (role !== "owner" && role !== "admin")
    ) {
      throw new Error(
        "Owner or admin authority for this workspace could not be confirmed; no broadcast request was sent.",
      );
    }
  };

  const runWrite = async <T,>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (writeBusyRef.current) {
      throw new Error("Another broadcast request is still in progress.");
    }
    writeBusyRef.current = true;
    setWriteBusy(true);
    const controller = new AbortController();
    writes.current.add(controller);
    try {
      await reauthorize();
      return await run(controller.signal);
    } finally {
      writes.current.delete(controller);
      writeBusyRef.current = false;
      setWriteBusy(false);
    }
  };

  const saveBroadcast = async (input: SmsBroadcastUpsert) => {
    const existing = composer?.existing ?? null;
    await runWrite((signal) =>
      existing
        ? updateSmsBroadcast(existing.id, input, signal)
        : createSmsBroadcast(input, signal),
    );
    setComposer(null);
    toast.success(existing ? "Broadcast updated" : "Broadcast draft created", {
      description:
        "Saved as an editable definition. Nothing was sent or scheduled.",
    });
    await invalidateList();
  };

  const confirmCancel = async () => {
    const target = cancelTarget;
    if (!target) return;
    await runWrite((signal) => cancelSmsBroadcast(target.id, signal));
    setCancelTarget(null);
    toast.success("Broadcast cancelled", {
      description:
        "Still-pending recipients, including quiet-hours holds, were marked cancelled. Provider-accepted messages cannot be recalled.",
    });
    await invalidateList();
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    await runWrite((signal) => deleteSmsBroadcast(target.id, signal));
    setDeleteTarget(null);
    if (expandedId === target.id) setExpandedId(null);
    queryClient.removeQueries({
      queryKey: [...key, target.id, "progress"],
      exact: true,
    });
    toast.success("Broadcast deleted");
    await invalidateList();
  };

  const dispatchReason = firstPage?.broadcastDispatchUnavailableReason;
  const dispatchAvailable = firstPage?.broadcastDispatchAvailable === true;
  const dispatchHoldCopy = smsBroadcastDispatchHoldCopy(dispatchReason);

  const confirmSend = async () => {
    const target = sendTarget;
    if (!target) return;
    // Belt and braces: the control is disabled while held, and the server
    // refuses anyway (503); never start a dispatch request against a hold.
    if (!dispatchAvailable) {
      throw new Error(`${dispatchHoldCopy} No dispatch request was sent.`);
    }
    const out = await runWrite((signal) => sendSmsBroadcast(target.id, signal));
    setSendTarget(null);
    if (out.broadcast.status === "scheduled") {
      toast.success(
        `Scheduled for ${out.broadcast.scheduled_at ? new Date(out.broadcast.scheduled_at).toLocaleString() : "its scheduled time"}`,
        { description: "You can cancel any time before then from this row." },
      );
    } else {
      toast.success(
        out.enqueued > 0
          ? `Sending — ${out.enqueued.toLocaleString()} messages enqueued`
          : "Already sending — progress replayed (no new messages enqueued)",
      );
      // Open the drilldown so the operator watches it drain.
      setExpandedId(out.broadcast.id);
    }
    await invalidateList();
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-4 w-4" aria-hidden />
            Broadcasts
          </CardTitle>
          <CardDescription>
            One-to-many SMS definitions targeting an SMS list, a segment, or a
            tag. Only opted-in, non-suppressed numbers are ever resolved as
            recipients.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-10"
            onClick={() => void refetch()}
            loading={refreshing}
            disabled={!enabled}
          >
            {!refreshing ? <RefreshCw aria-hidden /> : null}
            Refresh
          </Button>
          <Button
            ref={composerTriggerRef}
            type="button"
            className="min-h-10"
            disabled={!loaded || writeBusy}
            onClick={() => setComposer({ existing: null })}
          >
            <Plus aria-hidden />
            New broadcast
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {firstPage ? (
          firstPage.broadcastDispatchAvailable ? (
            <Alert>
              <AlertTitle>Broadcast dispatch is reported available</AlertTitle>
              <AlertDescription>
                Send now or Schedule on a draft or scheduled row authorizes a
                real one-to-many dispatch attempt after confirmation. Saving a
                definition alone arms nothing.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertTitle>Broadcast dispatch is unavailable</AlertTitle>
              <AlertDescription>
                <span id="sms-broadcast-dispatch-reason">{dispatchHoldCopy}</span>{" "}
                The server reports{" "}
                <code className="font-mono text-xs">
                  {dispatchReason || "no reason code"}
                </code>
                . Send and Schedule are disabled on every row; while this
                verdict stands the page does not send or schedule broadcasts
                and makes no dispatch request.
              </AlertDescription>
            </Alert>
          )
        ) : null}

        {query.isError ? (
          <CardLoadError
            message={`Broadcasts could not be loaded: ${apiErrorMessage(query.error)}`}
            onRetry={() => void refetch()}
          />
        ) : snapshotDrift ? (
          <CardLoadError
            message="The broadcast insertion window changed between pages. Refresh from the first page before continuing."
            onRetry={() => void refetch()}
          />
        ) : query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading broadcasts…
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Radio}
            title="No SMS broadcasts yet"
            description="No broadcast rows were returned for this response cutoff. Draft one for an SMS list, segment, or tag; recipient eligibility is rechecked only when dispatch is authorized."
          />
        ) : (
          <ul className="space-y-3" aria-label="SMS broadcasts">
            {rows.map((broadcast) => {
              const badge = smsBroadcastStatusBadge(broadcast.status);
              const expanded = expandedId === broadcast.id;
              const progressId = `sms-broadcast-progress-${broadcast.id}`;
              const deletable = canDeleteSmsBroadcast(broadcast.status);
              return (
                <li
                  key={broadcast.id}
                  className="rounded-lg border p-4"
                  aria-labelledby={`sms-broadcast-title-${broadcast.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3
                        id={`sms-broadcast-title-${broadcast.id}`}
                        className="font-medium"
                      >
                        {broadcast.name}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {smsBroadcastAudienceSummary(broadcast, lookup)}
                      </p>
                    </div>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Recorded provider outcomes
                      </dt>
                      <dd className="tabular-nums">
                        {broadcast.sent_count.toLocaleString()} accepted ·{" "}
                        {broadcast.failed_count.toLocaleString()} failed ·{" "}
                        {broadcast.held_count.toLocaleString()} held
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Segments per message
                      </dt>
                      <dd className="tabular-nums">
                        {broadcast.segments_per_message}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Schedule
                      </dt>
                      <dd className="tabular-nums">
                        {broadcast.scheduled_at
                          ? new Date(broadcast.scheduled_at).toLocaleString()
                          : "Not scheduled"}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-expanded={expanded}
                      aria-controls={progressId}
                      aria-label={`${expanded ? "Hide" : "Show"} delivery progress for ${broadcast.name}`}
                      onClick={() =>
                        setExpandedId(expanded ? null : broadcast.id)
                      }
                    >
                      {expanded ? "Hide progress" : "Progress"}
                    </Button>
                    {canEditSmsBroadcast(broadcast.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!loaded || writeBusy}
                        onClick={() => setComposer({ existing: broadcast })}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {canSendSmsBroadcast(broadcast.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!loaded || writeBusy || !dispatchAvailable}
                        aria-describedby={
                          dispatchAvailable
                            ? undefined
                            : "sms-broadcast-dispatch-reason"
                        }
                        title={dispatchAvailable ? undefined : dispatchHoldCopy}
                        onClick={(event) => {
                          if (!dispatchAvailable) return;
                          sendTriggerRef.current = event.currentTarget;
                          setSendTarget(broadcast);
                        }}
                      >
                        {smsBroadcastArmsLater(broadcast) ? "Schedule" : "Send now"}
                      </Button>
                    ) : null}
                    {canCancelSmsBroadcast(broadcast.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!loaded || writeBusy}
                        onClick={(event) => {
                          cancelTriggerRef.current = event.currentTarget;
                          setCancelTarget(broadcast);
                        }}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={!loaded || writeBusy || !deletable}
                      aria-describedby={
                        deletable
                          ? undefined
                          : `sms-broadcast-delete-reason-${broadcast.id}`
                      }
                      onClick={(event) => {
                        deleteTriggerRef.current = event.currentTarget;
                        setDeleteTarget(broadcast);
                      }}
                    >
                      Delete
                    </Button>
                    {!deletable ? (
                      <span
                        id={`sms-broadcast-delete-reason-${broadcast.id}`}
                        className="self-center text-xs text-muted-foreground"
                      >
                        A sending broadcast cannot be deleted; cancel it first.
                      </span>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div id={progressId} className="mt-3">
                      <SmsBroadcastProgressRegion
                        broadcast={broadcast}
                        listKey={key}
                        enabled={enabled}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {firstPage && rows.length > 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"} loaded for the
            response cutoff at {new Date(firstPage.snapshotAt).toLocaleString()}
            .
            {query.hasNextPage
              ? " More rows exist beyond this loaded window."
              : " No continuation cursor was returned; newer changes may still exist."}
          </p>
        ) : null}
        {query.hasNextPage && !snapshotDrift ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={query.isFetchingNextPage}
            onClick={() => void loadNextQueryPage(query, query.isEnabled)}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more broadcasts"}
          </Button>
        ) : null}
      </CardContent>

      {composer ? (
        <SmsBroadcastComposerDialog
          existing={composer.existing}
          lists={lists}
          segments={Array.isArray(segmentsQuery.data) ? segmentsQuery.data : []}
          segmentsError={
            segmentsQuery.isError ? apiErrorMessage(segmentsQuery.error) : null
          }
          baseKey={baseKey}
          onClose={() => {
            setComposer(null);
            composerTriggerRef.current?.focus();
          }}
          onSave={saveBroadcast}
        />
      ) : null}

      {sendTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setSendTarget(null);
          }}
          title={
            smsBroadcastArmsLater(sendTarget)
              ? `Schedule "${sendTarget.name}"?`
              : `Send "${sendTarget.name}" now?`
          }
          description={
            <span className="block space-y-2">
              <span className="block">
                This authorizes a real one-to-many SMS dispatch attempt.
                Audience:{" "}
                <strong>{smsBroadcastAudienceSummary(sendTarget, lookup)}</strong>
                {" — "}the server resolves the audience and rechecks each
                recipient at dispatch. Each provider attempt uses{" "}
                <strong>{sendTarget.segments_per_message}</strong> billed
                segment{sendTarget.segments_per_message === 1 ? "" : "s"}. The
                server rejects sends over the per-broadcast recipient cap.
              </span>
              <span className="block">
                Quiet-hours messages are held, not counted as failures, and may
                resume after the window. A later consent revocation or
                suppression still blocks that recipient.
              </span>
              {smsBroadcastArmsLater(sendTarget) && sendTarget.scheduled_at ? (
                <span className="block">
                  Armed for{" "}
                  <strong>
                    {new Date(sendTarget.scheduled_at).toLocaleString()}
                  </strong>{" "}
                  — you can cancel any time before then.
                </span>
              ) : null}
            </span>
          }
          confirmLabel={
            smsBroadcastArmsLater(sendTarget) ? "Schedule" : "Send now"
          }
          cancelLabel="Keep as draft"
          confirmVariant="default"
          returnFocusRef={sendTriggerRef}
          onConfirm={confirmSend}
        />
      ) : null}

      {cancelTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setCancelTarget(null);
          }}
          title={`Cancel "${cancelTarget.name}"?`}
          description={
            cancelTarget.status === "sending"
              ? "This broadcast is mid-send. Still-pending recipients, including quiet-hours holds, will be marked cancelled. Messages a provider already accepted cannot be recalled."
              : "This broadcast is scheduled. Still-pending recipients, including quiet-hours holds, will be marked cancelled and it will not run at its scheduled time."
          }
          confirmLabel="Cancel broadcast"
          cancelLabel="Keep it"
          returnFocusRef={cancelTriggerRef}
          onConfirm={confirmCancel}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null);
          }}
          title={`Delete "${deleteTarget.name}"?`}
          description="This permanently deletes the broadcast definition and its recorded delivery counters. It cannot be undone."
          confirmLabel="Delete broadcast"
          returnFocusRef={deleteTriggerRef}
          fallbackFocusRef={composerTriggerRef}
          onConfirm={confirmDelete}
        />
      ) : null}
    </Card>
  );
}

/**
 * GET /{id}/progress rendered verbatim (status / sent / failed / held /
 * total), polled every 5s while the broadcast is sending. The progress call
 * also refreshes the denormalised counters server-side, so the row in the
 * list cache is mirrored from each response.
 */
function SmsBroadcastProgressRegion({
  broadcast,
  listKey,
  enabled,
}: {
  broadcast: SmsBroadcast;
  listKey: readonly unknown[];
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const progressKey = useMemo(
    () => [...listKey, broadcast.id, "progress"] as const,
    [broadcast.id, listKey],
  );
  const query = useQuery({
    queryKey: progressKey,
    queryFn: ({ signal }) => getSmsBroadcastProgress(broadcast.id, signal),
    enabled,
    refetchInterval: (current) =>
      current.state.data?.status === "sending" ? PROGRESS_REFRESH_MS : false,
  });
  const progress = query.data ?? null;

  useEffect(() => {
    if (!progress) return;
    queryClient.setQueryData<BroadcastsInfiniteData>(listKey, (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((row) =>
            row.id === broadcast.id
              ? {
                  ...row,
                  status: progress.status,
                  sent_count: progress.sent,
                  failed_count: progress.failed,
                  held_count: progress.held,
                }
              : row,
          ),
        })),
      };
    });
  }, [broadcast.id, listKey, progress, queryClient]);

  const done = progress
    ? Math.min(progress.total, progress.sent + progress.failed)
    : 0;
  const pending = progress
    ? Math.max(
        0,
        progress.total - progress.sent - progress.failed - progress.held,
      )
    : 0;

  return (
    <div
      className="rounded-md border bg-muted/30 p-3 text-sm"
      aria-live="polite"
      aria-atomic="true"
    >
      {query.isError ? (
        <p role="alert" className="text-destructive">
          Progress could not be refreshed: {apiErrorMessage(query.error)}
          {progress ? " The last loaded counters remain below." : ""}
        </p>
      ) : null}
      {!progress ? (
        query.isError ? null : (
          <p role="status" className="text-muted-foreground">
            Loading progress…
          </p>
        )
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Latest recorded status:{" "}
              <strong className="font-medium">{progress.status}</strong>
            </span>
            <span className="tabular-nums text-muted-foreground">
              {smsBroadcastProgressPct(progress)}% accepted or failed ·{" "}
              {done.toLocaleString()} of {progress.total.toLocaleString()}
            </span>
          </div>
          <Progress
            value={smsBroadcastProgressPct(progress)}
            aria-label={`${done} of ${progress.total} recipients accepted by a provider or recorded failed`}
          />
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div>
              <dt className="text-xs text-muted-foreground">
                Accepted by provider
              </dt>
              <dd className="tabular-nums">{progress.sent.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Recorded failed</dt>
              <dd className="tabular-nums">
                {progress.failed.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Held</dt>
              <dd className="tabular-nums">{progress.held.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pending</dt>
              <dd className="tabular-nums">{pending.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Total</dt>
              <dd className="tabular-nums">
                {progress.total.toLocaleString()}
              </dd>
            </div>
          </dl>
          {progress.held > 0 ? (
            <p className="text-xs text-muted-foreground">
              Held = waiting out a quiet-hours window; eligibility is rechecked
              before any later attempt.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {progress.status === "sending"
              ? "Refreshing every 5 seconds while this broadcast is sending."
              : "Polling is stopped because this broadcast is not sending."}
          </p>
        </div>
      )}
    </div>
  );
}
