// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { RefreshCw } from "lucide-react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";

/**
 * A retained campaign list is a SNAPSHOT when the latest refetch failed but
 * earlier rows are still on screen. That is the state desktop calls "Showing
 * last-confirmed campaigns" — and the one in which campaign writes wait for a
 * refresh (`CAMPAIGN_STALE_SNAPSHOT_MESSAGE`).
 */
export function isCampaignSnapshotStale(query: {
  isError: boolean;
  data: unknown;
}): boolean {
  return query.isError && query.data !== undefined;
}

/**
 * Manual revalidation of the campaigns list — desktop parity campaigns-16
 * (CampaignsTopPanels.tsx "Refresh" + the stale-snapshot "Try again" notice).
 *
 * `queryKey` is the list's resource base (`base("campaigns", tenantId, role)`),
 * so one refetch re-reads every ACTIVE query under it: the row window
 * (GET /api/v1/campaigns), the status counts (GET /api/v1/campaigns/count),
 * and the folder counts when the folder filter is mounted.
 */
export function RefreshSnapshotButton({
  queryKey,
  stale,
  lastConfirmedAt,
  loadedCount,
  error,
}: {
  queryKey: readonly unknown[];
  /** `isCampaignSnapshotStale(listQuery)`. */
  stale: boolean;
  /** `listQuery.dataUpdatedAt` — epoch ms of the last successful read. */
  lastConfirmedAt: number;
  /** Rows held in the retained snapshot. */
  loadedCount: number;
  /** The failed refetch's error, rendered as the server's sentence. */
  error?: unknown;
}) {
  const queryClient = useQueryClient();
  const refreshing = useIsFetching({ queryKey: [...queryKey] }) > 0;

  const refresh = () => {
    void queryClient.refetchQueries({ queryKey: [...queryKey], type: "active" });
  };

  const confirmedAt =
    lastConfirmedAt > 0
      ? new Date(lastConfirmedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  const reason = error ? apiErrorMessage(error, "") : "";

  return (
    <div className="grid gap-2" data-testid="campaign-snapshot-refresh">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw
            className={
              refreshing
                ? "h-4 w-4 animate-spin motion-reduce:animate-none"
                : "h-4 w-4"
            }
            aria-hidden
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {stale ? (
        <Alert variant="warning" role="status">
          <AlertTitle>Showing last-confirmed campaigns</AlertTitle>
          <AlertDescription>
            <p>
              {refreshing ? "Rechecking the server. " : "Refresh failed. "}
              The retained snapshot contains {loadedCount.toLocaleString()}{" "}
              loaded campaign{loadedCount === 1 ? "" : "s"} and may no longer
              reflect current coverage or metrics
              {confirmedAt ? `; it was last confirmed at ${confirmedAt}` : ""}.
              {reason ? ` ${reason}` : ""} Changes to campaigns wait until a
              refresh succeeds.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={refreshing}
              onClick={refresh}
            >
              {refreshing ? "Retrying…" : "Try again"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
