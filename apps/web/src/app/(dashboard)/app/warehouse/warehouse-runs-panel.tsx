// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant-wide warehouse sync runs: search, status filter, refresh, and the
// admin-only redacted row-error evidence (parity with desktop
// components/dataplatform/WarehouseRunsPanel.tsx filters :293-330 and the
// errors modal :485-504). Replaces the unfiltered RunsSection in
// warehouse-manager.tsx.
//
//   GET /api/v1/warehouse/runs              — owned by the page's runs query;
//                                             Refresh re-runs it (read scope)
//   GET /api/v1/warehouse/runs/{id}/errors  — admin scope; requested only when
//                                             a verified owner/admin opens it
//
// Filtering is client-side over the latest server-bounded page (the endpoint
// takes no filter parameters), and the copy says so: "N of M loaded", never
// "N runs", so a filter cannot be read as a statement about all history.
"use client";

import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import {
  DataSection,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  listWarehouseRunErrors,
  type WarehouseAuthority,
  type WarehouseRun,
} from "@/lib/warehouse-api";
import { cn } from "@/lib/utils";

const MAX_VISIBLE_RUNS = 100;

function prettyNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function runHasIssue(run: WarehouseRun): boolean {
  return run.issue_present || run.rows_failed > 0 || run.schema_errors > 0;
}

/** A category sentence that never echoes rejected values or provider text. */
export function publicRunFailure(run: WarehouseRun): string {
  if (run.schema_errors > 0) {
    return "The warehouse rejected one or more rows against its schema.";
  }
  if (run.rows_failed > 0) {
    return "One or more rows failed without exposing rejected values.";
  }
  return run.issue_present
    ? "The warehouse did not confirm this run."
    : "No run-level failure was recorded.";
}

/** Case-insensitive match on run id, connection id/name, direction, mode. */
export function filterWarehouseRuns(
  runs: readonly WarehouseRun[],
  query: string,
  status: string,
  connectionNames: ReadonlyMap<string, string>,
): WarehouseRun[] {
  const needle = query.trim().toLowerCase();
  return runs.filter((run) => {
    if (status !== "all" && run.status !== status) return false;
    if (!needle) return true;
    return [
      run.id,
      run.connection_id,
      connectionNames.get(run.connection_id) ?? "",
      run.direction,
      run.run_mode,
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

export function WarehouseRunsPanel({
  runs,
  loading,
  error,
  refreshing = false,
  onRefresh,
  connectionNames,
  authority,
  queryRoot,
}: {
  runs: readonly WarehouseRun[];
  loading: boolean;
  error: boolean;
  /** runsQuery.isFetching — disables Refresh while a read is in flight. */
  refreshing?: boolean;
  /** Re-runs GET /api/v1/warehouse/runs (runsQuery.refetch). */
  onRefresh: () => unknown;
  connectionNames: ReadonlyMap<string, string>;
  /** Verified owner/admin authority; null for readers (evidence withheld). */
  authority: WarehouseAuthority | null;
  queryRoot: readonly string[];
}) {
  const searchId = useId();
  const statusId = useId();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedRun, setSelectedRun] = useState<WarehouseRun | null>(null);
  const safeRuns = useMemo(() => (Array.isArray(runs) ? runs : []), [runs]);

  const statusOptions = useMemo(
    () =>
      Array.from(new Set(safeRuns.map((run) => run.status))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [safeRuns],
  );
  // A status that vanished from the latest page must not strand the filter on
  // an option the Select no longer offers.
  const effectiveStatus =
    status === "all" || statusOptions.includes(status as WarehouseRun["status"])
      ? status
      : "all";
  const visibleRuns = useMemo(
    () => filterWarehouseRuns(safeRuns, query, effectiveStatus, connectionNames),
    [connectionNames, effectiveStatus, query, safeRuns],
  );
  const filtered = query.trim() !== "" || effectiveStatus !== "all";
  const needsAttention = safeRuns.filter(
    (run) => run.status === "failed" || runHasIssue(run),
  ).length;

  const evidenceQuery = useQuery({
    queryKey: [...queryRoot, "run", selectedRun?.id ?? "none", "errors"],
    queryFn: ({ signal }) =>
      listWarehouseRunErrors({
        authority: authority!,
        runId: selectedRun!.id,
        signal,
      }),
    enabled: Boolean(authority && selectedRun),
  });
  const evidence = Array.isArray(evidenceQuery.data) ? evidenceQuery.data : [];

  return (
    <DataSection
      id="warehouse-runs"
      title="Recent runs"
      description="Tenant-wide run status and bounded row counts across warehouse connections. Raw storage locations and provider errors are intentionally not exposed."
      aside={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refreshing || loading}
          aria-busy={refreshing || undefined}
        >
          <RefreshCw
            className={cn("h-4 w-4", refreshing && "animate-spin")}
            aria-hidden
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      }
    >
      {loading ? (
        <SectionSkeleton rows={4} />
      ) : error ? (
        <QueryError
          title="Run history could not be loaded"
          description="Connection configuration may still be accurate, but execution evidence is unavailable."
          onRetry={() => void onRefresh()}
        />
      ) : safeRuns.length === 0 ? (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          No warehouse run has been recorded.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={searchId}>Find a run</Label>
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Run ID, connection, direction, or mode"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={statusId}>Status</Label>
              <Select
                id={statusId}
                value={effectiveStatus}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">All statuses</option>
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {option.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </div>
            <p
              role="status"
              className="text-xs tabular-nums text-muted-foreground sm:pb-2.5"
            >
              {visibleRuns.length.toLocaleString()} of{" "}
              {safeRuns.length.toLocaleString()} loaded ·{" "}
              {needsAttention.toLocaleString()} need attention
            </p>
          </div>

          {visibleRuns.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-5 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">No runs match these filters</p>
                <p className="mt-1 text-muted-foreground">
                  Clear the search or choose another status.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <ul
              aria-label={filtered ? "Matching warehouse runs" : "Warehouse runs"}
              className="divide-y overflow-hidden rounded-xl border"
            >
              {visibleRuns.slice(0, MAX_VISIBLE_RUNS).map((run) => (
                <li
                  key={run.id}
                  data-testid="warehouse-run-row"
                  className="grid min-w-0 gap-2 p-3.5 text-sm md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-4"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {connectionNames.get(run.connection_id) ??
                        "Retained connection"}
                    </p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {run.id}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {run.direction} · {run.run_mode} ·{" "}
                      {formatWireTimestamp(run.created_at, "unknown time")} ·{" "}
                      {prettyNumber(run.rows_scanned)} scanned ·{" "}
                      {prettyNumber(run.rows_failed)} failed
                    </p>
                    {runHasIssue(run) ? (
                      <p className="mt-1 text-xs text-destructive">
                        {publicRunFailure(run)}
                      </p>
                    ) : null}
                  </div>
                  <StatusPill status={run.status} />
                  {runHasIssue(run) ? (
                    authority ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Inspect error evidence for run ${run.id}`}
                        onClick={() => setSelectedRun(run)}
                      >
                        Error evidence
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Error evidence requires an owner or admin.
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No issue
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {visibleRuns.length > MAX_VISIBLE_RUNS ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {MAX_VISIBLE_RUNS} of{" "}
              {visibleRuns.length.toLocaleString()} matching runs. Narrow the
              search to see the rest.
            </p>
          ) : null}
        </div>
      )}

      <Dialog
        open={Boolean(selectedRun)}
        onOpenChange={(open) => !open && setSelectedRun(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redacted row-error evidence</DialogTitle>
            <DialogDescription>
              {selectedRun
                ? `Run ${selectedRun.id} · ${prettyNumber(selectedRun.rows_failed)} failed rows · ${prettyNumber(selectedRun.schema_errors)} schema errors. `
                : ""}
              Raw rows and provider messages are never returned.
            </DialogDescription>
          </DialogHeader>
          {evidenceQuery.isLoading ? (
            <SectionSkeleton rows={3} />
          ) : evidenceQuery.isError ? (
            <QueryError
              description="Error evidence could not be loaded under the current administrator context."
              onRetry={() => void evidenceQuery.refetch()}
            />
          ) : evidence.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No row-level evidence was recorded for this run.
            </p>
          ) : (
            <ul
              aria-label="Row-error evidence"
              tabIndex={0}
              className="max-h-96 divide-y overflow-y-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {evidence.map((item) => (
                <li key={item.id} className="p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="break-all font-mono text-xs">
                      {item.error_code}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      row {item.row_number}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.source_object} · message{" "}
                    {item.message_present
                      ? "retained server-side"
                      : "not recorded"}{" "}
                    · {formatWireTimestamp(item.created_at, "unknown time")}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedRun(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DataSection>
  );
}
