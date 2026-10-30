// SPDX-License-Identifier: AGPL-3.0-only
//
// The report builder: choose metrics, see the answer, then save it.
//
// PREVIEW BEFORE SAVE is the whole point, not a convenience. A saved report is a
// definition other people will read numbers from, and a builder that only saves
// lets somebody publish a report they have never seen the output of. The API
// exposes `/reporting/preview` precisely so a draft can be run without becoming
// a definition.
//
// The metric list comes from the SERVER registry rather than a hard-coded list.
// A client-side copy would drift the first time a metric was added, and the
// symptom would be a builder that cannot select a metric the backend supports —
// invisible, because nothing errors.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  reportingApi,
  type ReportMetricDefinition,
  type ReportPreview,
  type ReportRequest,
} from "@/lib/reporting-api";
import {
  definitionConfirmsRequest,
  freezeReportRequest,
  reportingIdentityKey,
  reportingQueryKey,
  reportRequestFingerprint,
  verifyFreshReportingAdminAuthority,
  verifyFreshReportingReadAuthority,
} from "@/lib/reporting-authority";
import type { MeResponse } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { AdminGateNotice } from "@/components/admin-gate-notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminGate } from "@/lib/use-admin-gate";
import { useOnline } from "@/lib/use-online";

import { ReportCsvButton } from "./report-csv-button";

interface BuilderIntent {
  id: string;
  identity: MeResponse;
  identityKey: string;
  request: ReportRequest;
  fingerprint: string;
  controller: AbortController;
}

function previewCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable value";
  }
}

export function ReportBuilder() {
  const queryClient = useQueryClient();
  const adminGate = useAdminGate();
  const identity = adminGate.identity ?? null;
  const identityKey = reportingIdentityKey(identity);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const online = useOnline();
  const onlineNow = online === "online";
  const { canWrite, loading: gateLoading } = adminGate;
  const [name, setName] = useState("");
  const [metricSearch, setMetricSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const operationRef = useRef<BuilderIntent | null>(null);

  const registryKey = useMemo(
    () => reportingQueryKey("metric-registry", identity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );
  const definitionsKey = useMemo(
    () => reportingQueryKey("definitions", identity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );

  const registryQuery = useQuery({
    queryKey: registryKey,
    queryFn: ({ signal }) => reportingApi.metricRegistry({ signal }),
    enabled: Boolean(identity),
    retry: false,
  });

  const request = useMemo(
    () => ({
      name: name.trim(),
      metrics: [...selected].map((key) => ({ key })),
    }),
    [name, selected],
  );

  const previewMutation = useMutation({
    mutationFn: async (intent: BuilderIntent) => {
      await verifyFreshReportingReadAuthority(
        intent.identity,
        intent.controller.signal,
      );
      if (identityRef.current !== intent.identityKey) {
        throw new Error("Workspace identity changed before preview.");
      }
      const result = await reportingApi.preview(intent.request, {
        signal: intent.controller.signal,
        idempotencyKey: intent.id,
      });
      if (identityRef.current !== intent.identityKey) {
        throw new Error("Workspace identity changed while previewing.");
      }
      return { intent, result };
    },
    onSuccess: ({ intent, result }) => {
      if (
        identityRef.current !== intent.identityKey ||
        reportRequestFingerprint(request) !== intent.fingerprint
      ) {
        return;
      }
      setPreview({
        ...result,
        rows: Array.isArray(result.rows) ? result.rows : [],
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        errors: Array.isArray(result.errors) ? result.errors : [],
      });
    },
    onSettled: (_data, _error, intent) => {
      if (operationRef.current?.id === intent.id) operationRef.current = null;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (intent: BuilderIntent) => {
      await verifyFreshReportingAdminAuthority(
        intent.identity,
        intent.controller.signal,
      );
      if (identityRef.current !== intent.identityKey) {
        throw new Error("Workspace identity changed before save.");
      }
      const definition = await reportingApi.saveDefinition(intent.request, {
        signal: intent.controller.signal,
        idempotencyKey: intent.id,
      });
      if (!definitionConfirmsRequest(definition, intent.request)) {
        throw new Error("The save receipt did not match the reviewed report.");
      }
      const confirmed = await reportingApi.getDefinition(definition.id, {
        signal: intent.controller.signal,
        fresh: true,
      });
      if (!definitionConfirmsRequest(confirmed, intent.request)) {
        throw new Error("A fresh read did not confirm the saved report.");
      }
      if (identityRef.current !== intent.identityKey) {
        throw new Error("Workspace identity changed while confirming save.");
      }
      return { intent, definition: confirmed };
    },
    onSuccess: ({ intent, definition }) => {
      if (
        identityRef.current === intent.identityKey &&
        reportRequestFingerprint(request) === intent.fingerprint
      ) {
        setSaved(definition.id);
      }
      // The saved list is the other half of this page; leaving it stale would
      // show somebody their new report is missing.
      void queryClient.invalidateQueries({ queryKey: definitionsKey });
    },
    onSettled: (_data, _error, intent) => {
      if (operationRef.current?.id === intent.id) operationRef.current = null;
    },
  });

  useEffect(() => {
    setName("");
    setMetricSearch("");
    setSelected(new Set());
    setPreview(null);
    setSaved(null);
    operationRef.current?.controller.abort();
    operationRef.current = null;
    previewMutation.reset();
    saveMutation.reset();
    return () => {
      operationRef.current?.controller.abort();
      void queryClient.cancelQueries({ queryKey: registryKey });
      queryClient.removeQueries({ queryKey: registryKey });
    };
    // Mutation objects are stable TanStack Query observers; identityKey is the
    // authority boundary that deliberately resets this draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, queryClient, registryKey]);

  function startMutation(kind: "preview" | "save") {
    if (!identity || !onlineNow || operationRef.current) return;
    if (kind === "save" && !canWrite) return;
    const frozen = freezeReportRequest(request);
    const intent: BuilderIntent = {
      id: newUUIDv7(),
      identity,
      identityKey,
      request: frozen,
      fingerprint: reportRequestFingerprint(frozen),
      controller: new AbortController(),
    };
    operationRef.current = intent;
    if (kind === "preview") setPreview(null);
    setSaved(null);
    if (kind === "preview") previewMutation.mutate(intent);
    else saveMutation.mutate(intent);
  }

  const toggle = (key: string) => {
    if (operationRef.current) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // A changed selection invalidates what is on screen: leaving the old
      // preview visible would show numbers for a report that is no longer the
      // one described above them.
      setPreview(null);
      setSaved(null);
      previewMutation.reset();
      saveMutation.reset();
      return next;
    });
  };

  if (adminGate.state === "error") {
    return (
      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="Report access is unavailable until identity can be verified."
      />
    );
  }
  if (registryQuery.isPending) {
    return (
      <div className="space-y-3">
        <AdminGateNotice
          gate={adminGate}
          readOnlyMessage="Admin access is required to save report definitions. Preview remains available."
        />
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading report metrics…</span>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }
  if (registryQuery.error instanceof Error) {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
      >
        <p className="text-sm text-destructive">
          Could not load the metric registry, so nothing can be selected.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void registryQuery.refetch()}
          disabled={registryQuery.isFetching}
        >
          {registryQuery.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  const metrics = Array.isArray(registryQuery.data) ? registryQuery.data : [];
  const normalizedMetricSearch = metricSearch.trim().toLocaleLowerCase();
  const visibleMetrics = normalizedMetricSearch
    ? metrics.filter((metric) =>
        [metric.label, metric.key, metric.product_area].some((value) =>
          value.toLocaleLowerCase().includes(normalizedMetricSearch),
        ),
      )
    : metrics;
  // Saving is refused rather than sent: a nameless report is unfindable in the
  // list, and one with no metrics measures nothing.
  const canSave =
    canWrite &&
    Boolean(identity) &&
    onlineNow &&
    request.metrics.length > 0 &&
    request.name.length > 0;
  const canPreview =
    Boolean(identity) && onlineNow && request.metrics.length > 0;
  const busy = previewMutation.isPending || saveMutation.isPending;
  const previewColumns = preview
    ? Array.from(new Set(preview.rows.flatMap((row) => Object.keys(row))))
    : [];

  return (
    <div className="space-y-5">
      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="Admin access is required to save a report definition. You can still select metrics and preview the result."
      />
      {!onlineNow ? (
        <p role="status" className="text-sm text-warning-emphasis">
          Reconnect before previewing or saving. Reporting actions are never
          queued offline.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="report-name">Report name</Label>
        <Input
          id="report-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(null);
            saveMutation.reset();
          }}
          placeholder="Weekly engagement"
          maxLength={120}
          autoComplete="off"
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">
          Required only when you save. A preview can stay unnamed.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Metrics
          <span className="ml-2 font-normal text-muted-foreground">
            {selected.size} selected
          </span>
        </legend>
        {metrics.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            The registry is empty; there is nothing to report on yet.
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="report-metric-search" className="sr-only">
                Find a metric
              </Label>
              <Input
                id="report-metric-search"
                type="search"
                value={metricSearch}
                onChange={(event) => setMetricSearch(event.target.value)}
                placeholder="Find by metric name, key, or product area…"
                autoComplete="off"
                aria-describedby="report-metric-results"
              />
              <p
                id="report-metric-results"
                className="text-xs text-muted-foreground"
              >
                Showing {visibleMetrics.length} of {metrics.length} metrics
              </p>
            </div>
            {visibleMetrics.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No metrics match “{metricSearch.trim()}”. Try a name such as
                opens, revenue, or subscribers.
              </p>
            ) : (
              <div className="grid max-h-96 gap-2 overflow-y-auto overscroll-contain pr-1 sm:grid-cols-2">
                {visibleMetrics.map((m: ReportMetricDefinition) => (
                  <label
                    key={m.key}
                    className="flex min-h-14 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                  >
                    <Checkbox
                      checked={selected.has(m.key)}
                      onChange={() => toggle(m.key)}
                      className="mt-0.5"
                      disabled={busy}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {m.label}
                      </span>
                      <span className="block break-all font-mono text-xs text-muted-foreground">
                        {m.key}
                      </span>
                      {/* A metric the runtime cannot yet compute is selectable but
                      labelled: hiding it would make the builder disagree with
                      the registry. */}
                      {m.runtime_status && m.runtime_status !== "supported" ? (
                        <span className="mt-1 block text-xs text-warning-emphasis">
                          {m.runtime_status === "partial"
                            ? "Partial source coverage"
                            : `${m.runtime_status} runtime`}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!canPreview || busy}
          onClick={() => startMutation("preview")}
          aria-busy={previewMutation.isPending}
        >
          {previewMutation.isPending ? "Running…" : "Preview"}
        </Button>
        <Button
          type="button"
          disabled={gateLoading || !canSave || busy}
          onClick={() => startMutation("save")}
          aria-busy={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Saving…" : "Save report"}
        </Button>
      </div>

      {previewMutation.error instanceof Error &&
      previewMutation.variables?.identityKey === identityKey ? (
        <p role="alert" className="text-sm text-destructive">
          Preview failed. Check the selected metric availability and try again.
        </p>
      ) : null}
      {saveMutation.error instanceof Error &&
      saveMutation.variables?.identityKey === identityKey ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this report. Your draft is still here.
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-success">
          Report saved as <span className="break-all font-mono">{saved}</span>.
        </p>
      ) : null}

      {preview ? (
        <section
          aria-labelledby="report-preview-title"
          className="space-y-3 rounded-md border bg-muted/20 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="report-preview-title" className="text-sm font-semibold">
                Preview result
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"}
                {" · data as of "}
                {/* Shown on the PREVIEW too, not only on saved runs. */}
                {preview.computed_as_of ?? "unknown"}
                {preview.metric_version
                  ? ` · metric version ${preview.metric_version}`
                  : " · metric version unknown"}
              </p>
            </div>
            {/* Saves exactly the rows the table below shows; no request. */}
            <ReportCsvButton
              name={request.name}
              columns={previewColumns}
              rows={preview.rows}
            />
          </div>
          {preview.errors && preview.errors.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {preview.errors.join("; ")}
            </p>
          ) : null}
          {preview.valid === false &&
          (!preview.errors || preview.errors.length === 0) ? (
            <p role="alert" className="text-sm text-destructive">
              This preview did not validate. Review the selected metrics before
              saving.
            </p>
          ) : null}
          {preview.warnings && preview.warnings.length > 0 ? (
            <p className="text-sm text-warning-emphasis">
              {preview.warnings.join("; ")}
            </p>
          ) : null}
          {preview.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The preview returned no rows for this workspace.
            </p>
          ) : previewColumns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The preview returned rows without any displayable fields.
            </p>
          ) : (
            <div
              role="region"
              aria-label="Report preview rows"
              tabIndex={0}
              className="overflow-x-auto rounded-md border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="min-w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    {previewColumns.map((column) => (
                      <th
                        key={column}
                        scope="col"
                        className="px-3 py-2 font-medium"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.rows.map((row, index) => (
                    <tr key={index}>
                      {previewColumns.map((column) => {
                        const value = previewCell(row[column]);
                        return (
                          <td
                            key={column}
                            className="max-w-72 px-3 py-2 font-mono text-xs"
                            title={value}
                          >
                            <span className="block truncate">{value}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
