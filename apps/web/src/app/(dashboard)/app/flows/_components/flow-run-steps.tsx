// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-node attempts for one run — the half the run list cannot show.
//
// A `flow_runs` row carries ONE status for the whole traversal. It can say a run
// failed and not which node; it can say a run succeeded while a node inside it
// failed and was retried. Both are the questions somebody opens an inspector to
// answer, and neither is answerable from the row.
//
// Loaded on expand rather than with the list: most runs are never inspected, and
// fetching attempts for a hundred of them to render three would be a request per
// row for data nobody reads.
"use client";

import { useQuery } from "@tanstack/react-query";

import { flowsApi, type FlowRunStepAttempt } from "@/lib/flows-api";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** The outcome word for one attempt, from the three counters. */
function outcome(a: FlowRunStepAttempt): { label: string; className: string } {
  if (a.failed > 0) {
    return { label: "failed", className: "text-destructive" };
  }
  if (a.skipped > 0) {
    // Skipped is not a failure and must not read as one: a branch not taken is
    // the flow working, and colouring it like an error sends someone hunting.
    return { label: "skipped", className: "text-muted-foreground" };
  }
  return { label: "applied", className: "text-foreground" };
}

export function FlowRunSteps({ runId }: { runId: string }) {
  const stepsQuery = useQuery({
    queryKey: ["flow-run-steps", runId],
    queryFn: () => flowsApi.listRunSteps(runId),
  });

  if (stepsQuery.isPending) {
    return (
      <div role="status" aria-label="Loading run steps">
        <Skeleton className="mt-2 h-8 w-full" />
      </div>
    );
  }
  if (stepsQuery.error instanceof Error) {
    return (
      <div
        role="alert"
        className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
      >
        <p>Could not load this run&rsquo;s steps.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void stepsQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  const attempts = Array.isArray(stepsQuery.data) ? stepsQuery.data : [];
  if (attempts.length === 0) {
    // Distinguished from an error on purpose. A run that recorded nothing is
    // ordinary — it may not have reached a node yet — and showing a failure
    // there teaches people to ignore the failure state.
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        No node attempts recorded for this run yet.
      </p>
    );
  }

  return (
    <ol className="mt-2 space-y-1 border-l pl-3">
      {attempts.map((a, i) => {
        const o = outcome(a);
        return (
          // Index is part of the key because ONE node can legitimately appear
          // twice in a run — that is what a retry is, and it is the case this
          // view exists to make visible.
          <li key={`${a.node_id}-${a.occurred_at}-${i}`} className="text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-all font-mono">{a.node_id}</span>
              <span className="text-muted-foreground">{a.action_kind}</span>
              <span className={o.className}>{o.label}</span>
              <span className="ml-auto text-muted-foreground">
                <RelativeTime iso={a.occurred_at} />
              </span>
            </div>
            {a.error ? (
              <p className="mt-0.5 break-words text-destructive">{a.error}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
