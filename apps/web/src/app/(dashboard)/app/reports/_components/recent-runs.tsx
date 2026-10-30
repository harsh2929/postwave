// SPDX-License-Identifier: AGPL-3.0-only
//
// Recent report runs, with the one field that makes a number interpretable.
//
// `computed_as_of` is read from the DATA — max(at) over the reporting source —
// never from the clock. Stamping now() would claim a six-hour-old answer is
// current, which is precisely how two surfaces disagree about one saved report
// with no way to tell a lag from a defect.
//
// Shown as "unknown" when absent rather than hidden. The column is NULL-able and
// un-backfilled on purpose: provenance unknown is honest for a historical run,
// and an invented value would be indistinguishable from a real one.
"use client";

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";

import { reportingApi } from "@/lib/reporting-api";
import {
  reportingIdentityKey,
  reportingQueryKey,
} from "@/lib/reporting-authority";
import { useAdminGate } from "@/lib/use-admin-gate";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export function RecentRuns() {
  const queryClient = useQueryClient();
  const gate = useAdminGate();
  const identity = gate.identity ?? null;
  const identityKey = reportingIdentityKey(identity);
  const runsKey = useMemo(
    () => reportingQueryKey("runs", identity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );
  const runsQuery = useQuery({
    queryKey: runsKey,
    queryFn: ({ signal }) => reportingApi.listRuns({ signal }),
    enabled: Boolean(identity),
    retry: false,
  });

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey: runsKey });
      queryClient.removeQueries({ queryKey: runsKey });
    },
    [queryClient, runsKey],
  );

  if (gate.state === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not verify the workspace identity for recent report runs.
      </p>
    );
  }

  if (runsQuery.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading recent report runs…</span>
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (runsQuery.error instanceof Error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
      >
        <p className="text-sm text-destructive">
          Could not load recent runs. No history has been hidden as empty.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void runsQuery.refetch()}
          disabled={runsQuery.isFetching}
        >
          {runsQuery.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  const runs = Array.isArray(runsQuery.data) ? runsQuery.data : [];
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No report runs yet"
        description="A saved definition has no numbers until it runs. Completed runs and their provenance will appear here."
        className="py-8"
      />
    );
  }

  return (
    <ul className="space-y-2">
      {runs.map((run) => (
        <li key={run.id} className="rounded-md border p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-mono">
              {run.definition_id ?? run.id}
            </span>
            <Badge
              variant={
                run.status === "completed" || run.status === "succeeded"
                  ? "success"
                  : "outline"
              }
            >
              {run.status || "status unknown"}
            </Badge>
          </div>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
            <div className="flex gap-1">
              <dt>Data as of</dt>
              <dd>
                {run.computed_as_of ? (
                  <RelativeTime iso={run.computed_as_of} />
                ) : (
                  "unknown"
                )}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Metric version</dt>
              <dd className="font-mono">{run.metric_version ?? "unknown"}</dd>
            </div>
          </dl>
          {run.errors && run.errors.length > 0 ? (
            <p className="mt-1 text-destructive">{run.errors.join("; ")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
