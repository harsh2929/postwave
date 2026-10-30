// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { STALE } from "@/lib/query-keys";
import {
  getDirectoryViewTotal,
  type DirectoryStatusFilter,
} from "@/lib/subscriber-directory-api";
import { cn } from "@/lib/utils";

import { useDirectoryIdentity, useDirectoryUrlState } from "./directory-context";

// Desktop's four UI states plus All. The labels say what the state MEANS to
// an operator; the value is the web `?status=` filter the page already maps
// to the engine status (enabled / blocklisted / disabled / unconfirmed).
export const DIRECTORY_STATUS_CHIPS: {
  value: DirectoryStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Subscribed" },
  { value: "suppressed", label: "Unsubscribed" },
  { value: "disabled", label: "Disabled" },
  { value: "pending", label: "Unconfirmed" },
];

/**
 * Status filter chips with the matching total on the active chip. The count
 * is the list endpoint's own `total` for the applied view (query, status and
 * archive scope), fetched as a one-row request.
 */
export function DirectoryStatusChips() {
  const identity = useDirectoryIdentity();
  const { view, setState } = useDirectoryUrlState();
  const total = useQuery({
    queryKey: [...identity.subscribersKey, "directory-view-total", view],
    queryFn: ({ signal }) => getDirectoryViewTotal(view, signal),
    enabled: identity.ready,
    staleTime: STALE.list,
  });

  return (
    <div
      role="group"
      aria-label="Filter subscribers by status"
      className="flex flex-wrap items-center gap-1.5"
    >
      {DIRECTORY_STATUS_CHIPS.map((chip) => {
        const active = view.status === chip.value;
        const countLabel = !active
          ? null
          : total.isError
            ? "count unavailable"
            : total.data === undefined
              ? "…"
              : total.data.toLocaleString();
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={active}
            onClick={() => setState({ status: chip.value, page: 1 })}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
            {countLabel !== null ? (
              <span
                data-testid="directory-status-chip-count"
                className="tabular-nums text-muted-foreground"
              >
                {countLabel}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
