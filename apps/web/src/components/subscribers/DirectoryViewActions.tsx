// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { useDirectoryIdentity, useDirectoryUrlState } from "./directory-context";

/**
 * Refetch every subscribers-list read for this identity — the page's rows,
 * its counts, and the toolbar's totals all live under the same tenant/role
 * prefix. A failed refetch is announced, not swallowed: a stale view that
 * silently stays stale is the thing this button exists to fix.
 */
export function RefreshDirectoryButton() {
  const queryClient = useQueryClient();
  const identity = useDirectoryIdentity();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-9"
      disabled={!identity.ready || refreshing}
      onClick={async () => {
        setRefreshing(true);
        try {
          await queryClient.refetchQueries({
            queryKey: identity.subscribersKey,
            type: "active",
          });
          const failed = queryClient
            .getQueryCache()
            .findAll({ queryKey: identity.subscribersKey, type: "active" })
            .some((query) => query.state.status === "error");
          if (failed) toast.error("Some subscriber data could not be refreshed.");
        } finally {
          setRefreshing(false);
        }
      }}
    >
      <RefreshCw
        aria-hidden
        className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
      />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}

/**
 * Put the directory back to its default view: no query, All statuses,
 * archived hidden, last-updated sort, page 1. Only shown when something is
 * actually applied.
 */
export function ResetViewButton() {
  const { isDefault, reset } = useDirectoryUrlState();
  if (isDefault) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-9"
      onClick={() => reset()}
    >
      <RotateCcw aria-hidden className="h-4 w-4" />
      Reset view
    </Button>
  );
}
