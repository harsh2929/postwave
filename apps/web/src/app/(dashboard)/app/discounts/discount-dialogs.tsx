// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
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
import { ApiError } from "@/lib/api";
import { listDiscountRedemptionEvents } from "@/lib/discounts-api";
import { STALE } from "@/lib/query-keys";

const RECENT_EVENT_LIMIT = 25;

export function RedemptionHistoryDialog({
  recordId,
  recordLabel,
  discountsBaseKey,
  onClose,
}: {
  recordId: string;
  recordLabel: string;
  discountsBaseKey: readonly unknown[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [accessRevoked, setAccessRevoked] = useState(false);
  const eventsKey = useMemo(
    () =>
      [...discountsBaseKey, "redemption-events", recordId, "preview"] as const,
    [discountsBaseKey, recordId],
  );
  const eventsQuery = useQuery({
    queryKey: eventsKey,
    queryFn: () =>
      listDiscountRedemptionEvents(recordId, {
        limit: RECENT_EVENT_LIMIT,
        offset: 0,
      }),
    retry: false,
    enabled: !accessRevoked,
    staleTime: STALE.list,
  });
  const serverDenied =
    eventsQuery.error instanceof ApiError && eventsQuery.error.status === 403;
  const accessDenied = serverDenied || accessRevoked;
  useEffect(() => {
    if (!serverDenied) return;
    setAccessRevoked(true);
    queryClient.removeQueries({
      queryKey: [...discountsBaseKey, "redemption-events"],
      exact: false,
    });
  }, [discountsBaseKey, queryClient, recordId, serverDenied]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">
            Recent recorded events · {recordLabel}
          </DialogTitle>
          <DialogDescription>
            Newest first. The archive reports only whether each event has a
            linked subscriber record; it never returns the subscriber’s
            identity. This bounded preview does not reconcile the stored count
            or claim complete event lineage.
          </DialogDescription>
        </DialogHeader>

        {accessDenied ? (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning-subtle p-3"
          >
            <p className="text-sm font-medium text-warning-emphasis">
              Recent-event access is unavailable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This workspace role cannot read the sanitized event timeline.
            </p>
          </div>
        ) : eventsQuery.isPending ? (
          <div
            className="space-y-2"
            aria-label="Loading recent discount events"
            aria-busy="true"
            role="status"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : eventsQuery.isError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3"
          >
            <p className="text-sm font-medium text-destructive">
              Recent events could not be loaded
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The request failed, so this is not being shown as an empty
              history.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3 min-h-11 sm:min-h-9"
              loading={eventsQuery.isFetching}
              onClick={() => void eventsQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : eventsQuery.data.items.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm">
            <p className="font-medium">No recorded events</p>
            <p className="mt-1 text-muted-foreground">
              The archive returned a confirmed empty recent-event timeline for
              this record.
            </p>
          </div>
        ) : (
          <TableContainer
            aria-label={`Recent recorded events for ${recordLabel}`}
            className="max-h-72 overflow-auto"
          >
            <Table className="min-w-[360px]">
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead scope="col">Subscriber linkage</TableHead>
                  <TableHead scope="col">Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsQuery.data.items.map((event, index) => (
                  <TableRow key={`${event.redeemed_at}:${index}`}>
                    <TableCell>
                      <Badge
                        variant={
                          event.subscriber_linked ? "secondary" : "outline"
                        }
                      >
                        {event.subscriber_linked
                          ? "Linked record"
                          : "No linked record"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime iso={event.redeemed_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {eventsQuery.data?.hasMore ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Showing the {RECENT_EVENT_LIMIT} most recent events.{" "}
            <Link
              href={`/app/discounts/${encodeURIComponent(recordId)}`}
              className="inline-flex min-h-11 items-center underline underline-offset-4 sm:min-h-0"
            >
              Open the paginated history
            </Link>
            .
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
