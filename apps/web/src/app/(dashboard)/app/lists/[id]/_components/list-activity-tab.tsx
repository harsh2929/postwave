// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Activity (audience-93): the unified audit feed — subscribes, removals and
 * suppression mutations for members of this list. The server answers
 * `?limit=` only (no page/per_page), so paging is client-side over the most
 * recent ACTIVITY_FETCH_LIMIT events and the cap is stated on the page.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ACTIVITY_FETCH_LIMIT,
  ACTIVITY_PAGE_SIZE,
  getListActivity,
  type AudienceList,
  type ListActivityEvent,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import { dateOnly, LoadFailure, Pending } from "./tab-chrome";

const KIND_LABELS: Record<string, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Removed",
  suppression_add: "Suppressed",
  suppression_added: "Suppressed",
  suppression_remove: "Unsuppressed",
  suppression_removed: "Unsuppressed",
};

export function activityLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  if (kind.startsWith("suppression_"))
    return `Suppression ${kind.slice("suppression_".length).replace(/_/gu, " ")}`;
  return kind.replace(/_/gu, " ");
}

function kindVariant(
  kind: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (kind === "subscribed") return "success";
  if (kind === "unsubscribed") return "warning";
  if (kind.startsWith("suppression_")) return "destructive";
  return "secondary";
}

function detailText(ev: ListActivityEvent): string {
  const d = ev.detail ?? {};
  const parts: string[] = [];
  if (typeof d.source === "string" && d.source)
    parts.push(`source ${d.source}`);
  if (typeof d.table === "string" && d.table) parts.push(`via ${d.table}`);
  return parts.join(" · ");
}

export function ListActivityTab({
  list,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const [page, setPage] = useState(1);
  const feed = useQuery({
    queryKey: listKeys.activity(
      tenantId,
      roleKey,
      list.id,
      ACTIVITY_FETCH_LIMIT,
    ),
    queryFn: ({ signal }) =>
      getListActivity(list.id, ACTIVITY_FETCH_LIMIT, signal),
    staleTime: STALE.list,
  });
  const events = useMemo(
    () => (Array.isArray(feed.data) ? feed.data : []),
    [feed.data],
  );
  const totalPages = Math.max(1, Math.ceil(events.length / ACTIVITY_PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageEvents = events.slice(
    (current - 1) * ACTIVITY_PAGE_SIZE,
    current * ACTIVITY_PAGE_SIZE,
  );
  const grouped = useMemo(() => {
    const map = new Map<string, ListActivityEvent[]>();
    for (const ev of pageEvents) {
      const day = dateOnly(ev.at);
      map.set(day, [...(map.get(day) ?? []), ev]);
    }
    return [...map.entries()];
  }, [pageEvents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Subscribes, removals and suppression changes for members of{" "}
          <span className="font-medium text-foreground">{list.name}</span>,
          newest first.
        </p>
        <Button
          type="button"
          variant="outline"
          loading={feed.isFetching}
          onClick={() => void feed.refetch()}
        >
          <RefreshCw aria-hidden className="size-4" /> Refresh
        </Button>
      </div>

      {feed.isPending ? (
        <Pending label="Loading activity" rows={4} />
      ) : feed.isError ? (
        <LoadFailure
          what="Activity"
          error={feed.error}
          busy={feed.isFetching}
          onRetry={() => void feed.refetch()}
        />
      ) : events.length === 0 ? (
        <EmptyState
          icon={History}
          title="No recorded activity yet"
          description="Subscribes, removals and suppression changes appear here as they happen."
        />
      ) : (
        <>
          <ol className="space-y-4" aria-label="Activity timeline">
            {grouped.map(([day, evs]) => (
              <li key={day}>
                <h3 className="sticky top-0 z-10 border-b bg-background py-1 font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {day}
                </h3>
                <ul className="mt-2 space-y-1">
                  {evs.map((ev, i) => (
                    <li
                      key={`${ev.at}-${ev.kind}-${ev.email ?? ""}-${i}`}
                      className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm"
                    >
                      <Badge variant={kindVariant(ev.kind)} title={ev.kind}>
                        {activityLabel(ev.kind)}
                      </Badge>
                      <span className="min-w-0">
                        <span className="block truncate" title={ev.email}>
                          {ev.email ?? "—"}
                        </span>
                        {detailText(ev) ? (
                          <span className="block text-xs text-muted-foreground">
                            {detailText(ev)}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <RelativeTime iso={ev.at} />
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <nav
            aria-label="Activity pages"
            className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
          >
            <span>
              Page {current} of {totalPages} · {events.length.toLocaleString()}{" "}
              event
              {events.length === 1 ? "" : "s"}
              {events.length >= ACTIVITY_FETCH_LIMIT
                ? ` · showing the ${ACTIVITY_FETCH_LIMIT} most recent (the service does not page further)`
                : ""}
            </span>
            {events.length > ACTIVITY_PAGE_SIZE ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Previous page"
                  disabled={current <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Next page"
                  disabled={current >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </nav>
        </>
      )}
    </div>
  );
}
