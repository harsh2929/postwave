// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { absoluteTime } from "@/lib/relative-time";
import { STALE } from "@/lib/query-keys";
import {
  getSuppressionTimeline,
  removeSuppression,
  type SuppressionEntry,
} from "@/lib/suppressions-admin-api";
import { reasonBadgeVariant, reasonLabel } from "@/lib/suppression-reasons";

/**
 * Per-row drill-down (desktop parity with SuppressionDetailSlideover): the
 * canonical row from GET /api/v1/suppressions/{id}/timeline plus its recent
 * audit trail, with Remove available from the detail when the caller may
 * write. The list row is shown while the timeline loads so the operator is
 * never looking at a blank panel; the server row replaces it on arrival.
 */
export function SuppressionDetailDialog({
  entry,
  queryKeyBase,
  returnFocusRef,
  canRemove,
  onClose,
  onRemoved,
}: {
  entry: SuppressionEntry;
  queryKeyBase: readonly unknown[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  canRemove: boolean;
  onClose: () => void;
  /** Called after a confirmed removal; the caller invalidates and closes. */
  onRemoved: () => void;
}) {
  const query = useQuery({
    queryKey: [...queryKeyBase, "timeline", entry.id],
    queryFn: () => getSuppressionTimeline(entry.id),
    staleTime: STALE.detail,
  });
  const row = query.data?.suppression ?? entry;
  const audit = Array.isArray(query.data?.audit) ? query.data.audit : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-base">
            {row.email}
          </DialogTitle>
          <DialogDescription>
            Suppression detail and timeline. The audit trail is kept even after
            the address is removed.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label="Reason">
            <Badge variant={reasonBadgeVariant(row.reason)}>
              {reasonLabel(row.reason)}
            </Badge>
          </Fact>
          <Fact label="Source">{row.source || "—"}</Fact>
          <Fact label="Channel · Scope">
            {row.channel ?? "email"} · {row.scope ?? "marketing"}
          </Fact>
          <Fact label="Added">
            <time dateTime={row.created_at}>
              {absoluteTime(row.created_at)}
            </time>
          </Fact>
          <Fact label="Expires">
            {row.expires_at ? (
              <time dateTime={row.expires_at}>
                {absoluteTime(row.expires_at)}
              </time>
            ) : (
              "Permanent"
            )}
          </Fact>
          {row.bounce_category ? (
            <Fact label="Bounce category">{row.bounce_category}</Fact>
          ) : null}
          {row.match_kind ? <Fact label="Match">{row.match_kind}</Fact> : null}
          {row.source_event_id ? (
            <Fact label="Source event">
              <span className="break-all font-mono text-xs">
                {row.source_event_id}
              </span>
            </Fact>
          ) : null}
          {row.campaign_id ? (
            <Fact label="Campaign">
              <span className="break-all font-mono text-xs">
                {row.campaign_id}
              </span>
            </Fact>
          ) : null}
        </dl>

        <section aria-label={`Timeline for ${row.email}`} className="space-y-2">
          <h3 className="text-sm font-medium">Timeline</h3>
          {query.isPending ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading suppression timeline"
              className="space-y-2"
            >
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : query.isError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3"
            >
              <p className="text-sm font-medium text-destructive">
                Could not load the suppression timeline.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The request failed, so this is not an empty timeline. The facts
                above come from the list row.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No audit events recorded for this address yet.
            </p>
          ) : (
            <ol className="max-h-64 space-y-2 overflow-auto">
              {audit.map((event, index) => (
                <li
                  key={event.id ?? `${event.created_at}-${index}`}
                  className="min-w-0 rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium capitalize">
                      {event.action.replaceAll("_", " ")}
                    </span>
                    <RelativeTime
                      iso={event.created_at}
                      className="text-xs text-muted-foreground"
                    />
                  </div>
                  <div className="mt-1 break-words text-xs text-muted-foreground">
                    {[
                      event.reason
                        ? `Reason: ${reasonLabel(event.reason)}`
                        : null,
                      event.source ? `Source: ${event.source}` : null,
                      event.actor ? `By: ${event.actor}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No additional detail."}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canRemove ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  Remove suppression
                </Button>
              }
              title={`Remove ${row.email}?`}
              description="Moosewave may email this address again after removal. Auto-suppression can re-add it on the next bounce or complaint."
              confirmLabel="Remove"
              onConfirm={async () => {
                await removeSuppression(row.email);
                toast.success("Removed from suppression list.");
                onRemoved();
              }}
            />
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}
