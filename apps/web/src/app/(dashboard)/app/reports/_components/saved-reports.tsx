// SPDX-License-Identifier: AGPL-3.0-only
//
// Saved reports, on web.
//
// The row this closes asks a precise question: save a report on desktop, open it
// on web, and see the same metric ids, the same filters, and an as-of stamp.
// That is not a cosmetic parity check. A report is a claim about the business,
// and two surfaces showing one saved report with different metrics — or with no
// statement of when it was true — is how two people leave a meeting having
// agreed on different numbers.
//
// PROVENANCE IS SHOWN, NOT HIDDEN. `metric_version` changes when the arithmetic
// changes, so two runs of "the same" report can be told apart. Both provenance
// fields are optional on the wire and absent on rows saved before provenance
// existed; they render as "unknown" rather than being omitted, because a missing
// stamp and a fresh one must not look alike.
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileBarChart2 } from "lucide-react";

import { reportingApi, type ReportDefinition } from "@/lib/reporting-api";
import {
  reportDefinitionFingerprint,
  reportingIdentityKey,
  reportingQueryKey,
  runConfirmsDefinition,
  verifyFreshReportingAdminAuthority,
} from "@/lib/reporting-authority";
import type { MeResponse } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { AdminGateNotice } from "@/components/admin-gate-notice";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminGate } from "@/lib/use-admin-gate";
import { useOnline } from "@/lib/use-online";

interface RunIntent {
  idempotencyKey: string;
  definitionId: string;
  definitionFingerprint: string;
  identity: MeResponse;
  identityKey: string;
  controller: AbortController;
}

function metricIds(definition: ReportDefinition): string {
  if (definition.metrics.length === 0) return "no metrics";
  return definition.metrics.map((m) => m.key).join(", ");
}

export function SavedReports() {
  const queryClient = useQueryClient();
  const adminGate = useAdminGate();
  const identity = adminGate.identity ?? null;
  const identityKey = reportingIdentityKey(identity);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const online = useOnline();
  const onlineNow = online === "online";
  const { canWrite, loading: gateLoading } = adminGate;
  const definitionsKey = useMemo(
    () => reportingQueryKey("definitions", identity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );
  const runsKey = useMemo(
    () => reportingQueryKey("runs", identity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );
  const operationRef = useRef<RunIntent | null>(null);
  const definitionsQuery = useQuery({
    queryKey: definitionsKey,
    queryFn: ({ signal }) => reportingApi.listDefinitions({ signal }),
    enabled: Boolean(identity),
    retry: false,
  });
  const runMutation = useMutation({
    mutationFn: async (intent: RunIntent) => {
      await verifyFreshReportingAdminAuthority(
        intent.identity,
        intent.controller.signal,
      );
      if (identityRef.current !== intent.identityKey) {
        throw new Error("Workspace identity changed before report run.");
      }
      const current = await reportingApi.getDefinition(intent.definitionId, {
        signal: intent.controller.signal,
        fresh: true,
      });
      if (
        reportDefinitionFingerprint(current) !== intent.definitionFingerprint
      ) {
        throw new Error(
          "The saved report changed after this action opened. Review it and retry.",
        );
      }
      const started = await reportingApi.run(intent.definitionId, {
        signal: intent.controller.signal,
        idempotencyKey: intent.idempotencyKey,
      });
      if (!runConfirmsDefinition(started, intent.definitionId)) {
        throw new Error("The run receipt did not match the selected report.");
      }
      const confirmed = await reportingApi.getRun(started.id, {
        signal: intent.controller.signal,
        fresh: true,
      });
      if (!runConfirmsDefinition(confirmed, intent.definitionId)) {
        throw new Error(
          "A fresh read did not confirm the selected report run.",
        );
      }
      if (identityRef.current !== intent.identityKey) {
        throw new Error(
          "Workspace identity changed while confirming report run.",
        );
      }
      return { intent, run: confirmed };
    },
    onSuccess: ({ intent }) => {
      if (identityRef.current === intent.identityKey) {
        void queryClient.invalidateQueries({ queryKey: runsKey });
      }
    },
    onSettled: (_data, _error, intent) => {
      if (operationRef.current?.idempotencyKey === intent.idempotencyKey) {
        operationRef.current = null;
      }
    },
  });

  useEffect(() => {
    operationRef.current?.controller.abort();
    operationRef.current = null;
    runMutation.reset();
    return () => {
      operationRef.current?.controller.abort();
      void queryClient.cancelQueries({ queryKey: definitionsKey });
      queryClient.removeQueries({ queryKey: definitionsKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitionsKey, identityKey, queryClient]);

  function runDefinition(definition: ReportDefinition): void {
    if (!identity || !canWrite || !onlineNow || operationRef.current) return;
    const intent: RunIntent = {
      idempotencyKey: newUUIDv7(),
      definitionId: definition.id,
      definitionFingerprint: reportDefinitionFingerprint(definition),
      identity,
      identityKey,
      controller: new AbortController(),
    };
    operationRef.current = intent;
    runMutation.mutate(intent);
  }

  if (adminGate.state === "error") {
    return (
      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="Saved reports are unavailable until identity can be verified."
      />
    );
  }

  if (definitionsQuery.isPending) {
    return (
      <div className="space-y-3">
        <AdminGateNotice
          gate={adminGate}
          readOnlyMessage="Admin access is required to run saved reports."
        />
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading saved reports…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (definitionsQuery.error instanceof Error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
      >
        <p className="text-sm text-destructive">
          Could not load saved reports. This is not an empty workspace.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void definitionsQuery.refetch()}
          disabled={definitionsQuery.isFetching}
        >
          {definitionsQuery.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  const definitions = Array.isArray(definitionsQuery.data)
    ? definitionsQuery.data
    : [];
  if (definitions.length === 0) {
    return (
      <div className="space-y-3">
        <AdminGateNotice
          gate={adminGate}
          readOnlyMessage="Admin access is required to run saved reports."
        />
        <EmptyState
          icon={FileBarChart2}
          title="No saved reports yet"
          description="Build and preview a report above. Once saved, its definition appears here on every Moosewave surface."
          className="py-8"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="Admin access is required to run saved reports."
      />
      {!onlineNow ? (
        <p role="status" className="text-sm text-warning-emphasis">
          Reconnect before running a saved report. Runs are never queued
          offline.
        </p>
      ) : null}
      <ul className="space-y-3">
        {definitions.map((d) => {
          const filterKeys = Object.keys(d.filters ?? {});
          const reportName = d.name.trim() || "Untitled report";
          return (
            <li key={d.id} className="rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">
                    {reportName}
                  </h3>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                    {d.id}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">
                    {d.product_area || "All product areas"}
                  </Badge>
                  <Badge variant="outline">
                    {d.status || "status unknown"}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      gateLoading ||
                      !canWrite ||
                      !onlineNow ||
                      runMutation.isPending
                    }
                    loading={
                      runMutation.isPending &&
                      runMutation.variables?.definitionId === d.id
                    }
                    onClick={() => runDefinition(d)}
                    aria-label={`Run ${reportName}`}
                    title={
                      adminGate.state === "read-only"
                        ? "Admin access is required to run reports"
                        : undefined
                    }
                  >
                    {runMutation.isPending &&
                    runMutation.variables?.definitionId === d.id
                      ? "Running…"
                      : "Run"}
                  </Button>
                </div>
              </div>
              {d.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {d.description}
                </p>
              ) : null}
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Metrics</dt>
                  <dd className="mt-0.5 break-all font-mono">{metricIds(d)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Filters</dt>
                  <dd className="mt-0.5 break-all font-mono">
                    {filterKeys.length > 0 ? filterKeys.join(", ") : "none"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Metric version</dt>
                  <dd className="mt-0.5 break-all font-mono">
                    {/* Absent means the definition predates provenance. Saying
                      "unknown" keeps that distinguishable from a stamped one;
                      omitting the row would make them look identical. */}
                    {d.metric_version ?? "unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5">
                    <RelativeTime iso={d.updated_at} />
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
        {runMutation.isSuccess &&
        runMutation.variables?.identityKey === identityKey ? (
          <li role="status" className="text-sm text-success">
            Report run started. Recent runs will refresh automatically.
          </li>
        ) : null}
        {runMutation.isError &&
        runMutation.variables?.identityKey === identityKey ? (
          <li role="alert" className="text-sm text-destructive">
            Could not run that report. The saved definition was not changed.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
