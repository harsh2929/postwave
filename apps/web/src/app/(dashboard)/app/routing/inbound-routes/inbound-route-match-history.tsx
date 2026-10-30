// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import {
  INBOUND_ROUTE_MATCH_HISTORY_LIMIT,
  listInboundRouteMatchesStrict,
} from "@/lib/inbound-routes-admin-api";

function formatMatchTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * The route's recorded firing history, read fresh from the mounted service
 * whenever the detail is inspected. An empty list is the ordinary state for a
 * rule that has not fired yet, so it renders concrete copy rather than an
 * error; a failed read renders the server's sentence with a retry.
 */
export function InboundRouteMatchHistory({
  routeId,
  queryScope,
}: {
  routeId: string;
  queryScope: readonly unknown[];
}) {
  const history = useQuery({
    queryKey: [...queryScope, "match-history", routeId],
    queryFn: ({ signal }) =>
      listInboundRouteMatchesStrict({
        routeId,
        limit: INBOUND_ROUTE_MATCH_HISTORY_LIMIT,
        signal,
      }),
    retry: false,
  });
  const headingId = `inbound-route-match-history-${routeId}`;
  const matches = Array.isArray(history.data) ? history.data : [];

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={headingId} className="font-medium">
            Match history
          </h3>
          <p className="text-xs text-muted-foreground">
            The newest {INBOUND_ROUTE_MATCH_HISTORY_LIMIT} matches recorded for
            this rule, read fresh from the mounted service. The catalogue&apos;s
            match counter can run ahead of this window.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={history.isFetching}
          onClick={() => void history.refetch()}
        >
          <RefreshCw aria-hidden className="size-4" />
          {history.isFetching ? "Refreshing…" : "Refresh history"}
        </Button>
      </div>
      {history.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading match history…
        </p>
      ) : history.isError ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive p-3 text-sm"
        >
          <p>
            {apiErrorMessage(
              history.error,
              "Match history could not be loaded",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void history.refetch()}
          >
            Retry history
          </Button>
        </div>
      ) : matches.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No matches recorded yet. History fills as inbound mail arrives that
          matches this rule; use the dry-run preview on the routing page to test
          examples.
        </p>
      ) : (
        <ol className="divide-y rounded-md border text-xs">
          {matches.map((match) => (
            <li
              key={match.id}
              className="grid gap-1 p-3 sm:grid-cols-[9rem_minmax(0,1fr)]"
            >
              <time
                dateTime={match.matchedAt}
                className="text-muted-foreground"
              >
                {formatMatchTime(match.matchedAt)}
              </time>
              <div className="space-y-0.5">
                <div className="break-all font-mono">
                  <span className="text-muted-foreground">From </span>
                  {match.fromEmail || "—"}
                </div>
                <div className="break-all font-mono">
                  <span className="text-muted-foreground">To </span>
                  {match.recipient || "—"}
                </div>
                <div className="break-words">
                  <span className="text-muted-foreground">Subject </span>
                  {match.subject || "—"}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
