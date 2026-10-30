// SPDX-License-Identifier: AGPL-3.0-only
//
// Flow run inspector (FLOW-035): per-subscriber enrollment timeline for a flow
// — status, the triggering event, and scheduled/started/finished times — read
// from the existing flow_runs table via GET .../flows/{id}/runs.
"use client";

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { flowsApi, type FlowRun } from "@/lib/flows-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { FlowRunSteps } from "./flow-run-steps";

function statusVariant(
  status: string,
): "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "completed":
    case "finished":
      return "success";
    case "failed":
    case "error":
      return "destructive";
    case "scheduled":
    case "waiting":
    case "running":
      return "warning";
    default:
      return "outline";
  }
}

export function FlowRunsPanel({ flowId }: { flowId: string }) {
  // Which runs are expanded. A set rather than a single id: comparing two runs
  // is the normal way to work out why one behaved differently, and collapsing
  // the first when the second opens makes that impossible.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runsQuery = useQuery({
    queryKey: ["flow-runs", flowId],
    queryFn: () => flowsApi.listRuns(flowId, 100),
  });

  return (
    <div className="space-y-3 p-3" aria-busy={runsQuery.isFetching}>
      <div>
        <h3 className="text-sm font-semibold">Recorded run inspector</h3>
        <p className="text-xs text-muted-foreground">
          Historical per-subscriber records only. Flow execution is
          release-held, so this view does not imply new runtime activity.
        </p>
      </div>

      {runsQuery.isPending ? (
        <div role="status" aria-label="Loading flow runs" className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : runsQuery.error instanceof Error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <p>Could not load runs for this flow.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (runsQuery.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recorded enrollments. This inspector does not start or prove
          runtime execution.
        </p>
      ) : (
        <ul className="space-y-2">
          {runsQuery.data?.map((run: FlowRun) => (
            <li key={run.id} className="rounded-md border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={run.subscriber_id}
                >
                  {run.subscriber_id}
                </span>
                <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                <button
                  type="button"
                  onClick={() => toggle(run.id)}
                  aria-expanded={expanded.has(run.id)}
                  aria-controls={`flow-run-steps-${run.id}`}
                  className="inline-flex min-h-8 shrink-0 items-center rounded-sm px-1 text-xs underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {expanded.has(run.id) ? "Hide steps" : "Steps"}
                </button>
              </div>
              {run.trigger_event_name ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  via {run.trigger_event_name}
                </p>
              ) : null}
              <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                <div className="flex gap-1">
                  <dt>Scheduled</dt>
                  <dd>
                    <RelativeTime iso={run.scheduled_at} />
                  </dd>
                </div>
                {run.started_at ? (
                  <div className="flex gap-1">
                    <dt>Started</dt>
                    <dd>
                      <RelativeTime iso={run.started_at} />
                    </dd>
                  </div>
                ) : null}
                {run.finished_at ? (
                  <div className="flex gap-1">
                    <dt>Finished</dt>
                    <dd>
                      <RelativeTime iso={run.finished_at} />
                    </dd>
                  </div>
                ) : null}
              </dl>
              {expanded.has(run.id) ? (
                <div id={`flow-run-steps-${run.id}`}>
                  <FlowRunSteps runId={run.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
