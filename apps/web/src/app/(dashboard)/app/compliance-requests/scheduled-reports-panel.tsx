// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import {
  composeSchedule,
  createScheduledReport,
  DEFAULT_SCHEDULE_PARTS,
  deleteScheduledReport,
  isAmbiguousScheduledReportRunError,
  isValidTimezone,
  listScheduledReports,
  newScheduledReportRunKey,
  normalizeScheduledReportCreateInput,
  normalizeScheduledReportPatchInput,
  parseRecipientDraft,
  parseScheduleParts,
  reportMatchesPatch,
  sameScheduledReportConfiguration,
  sendScheduledReportNow,
  updateScheduledReport,
  WEEKDAYS,
  type ScheduleParts,
  type ScheduledReport,
  type ScheduledReportCreateInput,
  type ScheduledReportPatchInput,
  type ScheduledReportRunStatus,
  type ScheduledReportSendNowReceipt,
  type ScheduledReportTemplate,
} from "@/lib/scheduled-reports-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const TEMPLATE_OPTIONS: ReadonlyArray<{
  value: ScheduledReportTemplate;
  label: string;
}> = [
  { value: "engagement_summary", label: "Engagement summary" },
  { value: "deliverability", label: "Deliverability" },
  { value: "growth", label: "Growth" },
];

const TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

interface ReportEditor {
  baseline: ScheduledReport | null;
  name: string;
  template: ScheduledReportTemplate;
  schedule: ScheduleParts;
  timezone: string;
  recipientsText: string;
  enabled: boolean;
}

interface SendIntent {
  report: ScheduledReport;
  idempotencyKey: string;
}

function localTimezone(): string {
  try {
    const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return candidate && isValidTimezone(candidate) ? candidate : "UTC";
  } catch {
    return "UTC";
  }
}

function editorFromReport(report?: ScheduledReport): ReportEditor {
  return {
    baseline: report ?? null,
    name: report?.name ?? "",
    template: report?.template ?? "engagement_summary",
    schedule:
      (report ? parseScheduleParts(report.schedule) : null) ??
      DEFAULT_SCHEDULE_PARTS,
    timezone: report?.timezone ?? localTimezone(),
    recipientsText: report?.recipients?.join("\n") ?? "",
    enabled: report?.enabled ?? true,
  };
}

function createInput(editor: ReportEditor): ScheduledReportCreateInput {
  return normalizeScheduledReportCreateInput({
    name: editor.name,
    template: editor.template,
    schedule: composeSchedule(editor.schedule),
    timezone: editor.timezone,
    recipients: parseRecipientDraft(editor.recipientsText),
  });
}

function patchInput(editor: ReportEditor): ScheduledReportPatchInput {
  return normalizeScheduledReportPatchInput({
    name: editor.name,
    enabled: editor.enabled,
    schedule: composeSchedule(editor.schedule),
    timezone: editor.timezone,
    recipients: parseRecipientDraft(editor.recipientsText),
  });
}

function editorValidation(editor: ReportEditor): string | null {
  try {
    if (editor.baseline) patchInput(editor);
    else createInput(editor);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Review the report settings.";
  }
}

function editorIsDirty(editor: ReportEditor | null): boolean {
  if (!editor) return false;
  try {
    if (!editor.baseline) {
      return (
        Boolean(editor.name || editor.recipientsText) ||
        editor.template !== "engagement_summary" ||
        composeSchedule(editor.schedule) !==
          composeSchedule(DEFAULT_SCHEDULE_PARTS) ||
        editor.timezone !== localTimezone() ||
        editor.enabled !== true
      );
    }
    const patch = patchInput(editor);
    return (
      editor.template !== editor.baseline.template ||
      !reportMatchesPatch(editor.baseline, patch)
    );
  } catch {
    return true;
  }
}

function statusCopy(status: ScheduledReportRunStatus | null): {
  label: string;
  variant: BadgeProps["variant"];
  detail: string;
} {
  switch (status) {
    case "queued":
      return {
        label: "Queued",
        variant: "outline",
        detail: "A durable run is waiting for a worker.",
      };
    case "leased":
      return {
        label: "Preparing",
        variant: "info",
        detail: "A worker has claimed the run and is preparing its snapshot.",
      };
    case "delivering":
      return {
        label: "Requesting acceptance",
        variant: "info",
        detail: "Recipient requests are in progress.",
      };
    case "succeeded":
      return {
        label: "Provider accepted",
        variant: "success",
        detail:
          "The provider accepted every recipient request; inbox placement and opens are not proven.",
      };
    case "partial":
      return {
        label: "Partially accepted",
        variant: "warning",
        detail: "Some recipient requests were accepted and others failed.",
      };
    case "failed":
      return {
        label: "Not accepted",
        variant: "destructive",
        detail: "No recipient acceptance was confirmed.",
      };
    case "needs_review":
      return {
        label: "Needs review",
        variant: "warning",
        detail:
          "At least one provider outcome is unknown and is not retried automatically.",
      };
    default:
      return {
        label: "No run yet",
        variant: "secondary",
        detail: "No durable delivery run has been reported.",
      };
  }
}

function templateLabel(template: ScheduledReportTemplate): string {
  return (
    TEMPLATE_OPTIONS.find((option) => option.value === template)?.label ??
    template
  );
}

function scheduleLabel(report: ScheduledReport): string {
  const parts = parseScheduleParts(report.schedule);
  if (!parts) return report.schedule;
  return parts.kind === "weekly"
    ? `Weekly on ${parts.weekday.toUpperCase()} at ${parts.time}`
    : `Monthly on day ${parts.dayOfMonth} at ${parts.time}`;
}

export function ScheduledReportsPanel({
  identity,
}: {
  identity: MeResponse | null;
}) {
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && roleCanWrite(role),
  );
  const identityKey = identity
    ? `${identity.user_id}:${identity.tenant_id}:${role}:${Boolean(identity.viewer_mode)}`
    : "unresolved";
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () =>
      [
        "scheduled-reports",
        identity?.tenant_id ?? "unresolved",
        identity?.user_id ?? "unresolved",
        role ?? "unresolved",
        identity?.viewer_mode ? "viewer" : "member",
      ] as const,
    [identity?.tenant_id, identity?.user_id, identity?.viewer_mode, role],
  );
  const reportsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!identity) throw new Error("Administrator identity is unavailable.");
      return listScheduledReports(identity.tenant_id, { signal });
    },
    enabled: canAdmin,
    staleTime: STALE.detail,
    retry: false,
  });
  const [editor, setEditor] = useState<ReportEditor | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledReport | null>(
    null,
  );
  const [sendIntent, setSendIntent] = useState<SendIntent | null>(null);
  const [lastReceipt, setLastReceipt] =
    useState<ScheduledReportSendNowReceipt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const operationRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const operationControllerRef = useRef<AbortController | null>(null);
  const dirty = editorIsDirty(editor);
  const validation = editor ? editorValidation(editor) : null;
  const scheduleTargetId =
    editor?.schedule.kind === "monthly"
      ? "scheduled-report-month-day"
      : "scheduled-report-weekday";
  useUnsavedChangesGuard(dirty && !saving);

  useEffect(() => {
    operationGenerationRef.current += 1;
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    operationRef.current = false;
    setEditor(null);
    setAcknowledged(false);
    setDeleteTarget(null);
    setSendIntent(null);
    setLastReceipt(null);
    setActionError(null);
    setActionStatus(null);
  }, [identityKey]);

  useEffect(
    () => () => {
      operationGenerationRef.current += 1;
      operationControllerRef.current?.abort();
    },
    [],
  );

  const snapshot =
    reportsQuery.data?.tenantId === identity?.tenant_id
      ? reportsQuery.data
      : null;
  const reports = snapshot?.reports ?? [];

  function beginOperation(): {
    generation: number;
    controller: AbortController;
  } {
    if (operationRef.current) {
      throw new Error(
        "Another scheduled-report operation is still in progress.",
      );
    }
    operationRef.current = true;
    const controller = new AbortController();
    operationControllerRef.current?.abort();
    operationControllerRef.current = controller;
    const generation = ++operationGenerationRef.current;
    return { generation, controller };
  }

  function operationIsCurrent(
    generation: number,
    controller: AbortController,
  ): boolean {
    return (
      generation === operationGenerationRef.current &&
      operationControllerRef.current === controller &&
      !controller.signal.aborted
    );
  }

  function finishOperation(
    generation: number,
    controller: AbortController,
  ): void {
    if (
      generation === operationGenerationRef.current &&
      operationControllerRef.current === controller
    ) {
      operationRef.current = false;
      operationControllerRef.current = null;
      setSaving(false);
    }
  }

  async function saveEditor(): Promise<void> {
    if (
      !identity ||
      !canAdmin ||
      !editor ||
      validation ||
      !acknowledged ||
      operationRef.current
    ) {
      return;
    }
    const opened = editor;
    const { generation, controller } = beginOperation();
    setSaving(true);
    setActionError(null);
    setActionStatus(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await listScheduledReports(identity.tenant_id, {
        signal: controller.signal,
        fresh: true,
      });
      if (opened.baseline) {
        const current = before.reports.find(
          (report) => report.id === opened.baseline?.id,
        );
        if (
          !current ||
          !sameScheduledReportConfiguration(opened.baseline, current)
        ) {
          queryClient.setQueryData(queryKey, before);
          throw new Error(
            "This definition changed after the editor opened. Review the fresh server state before writing.",
          );
        }
        const patch = patchInput(opened);
        await updateScheduledReport(current.id, patch, {
          signal: controller.signal,
        });
        const after = await listScheduledReports(identity.tenant_id, {
          signal: controller.signal,
          fresh: true,
        });
        const confirmed = after.reports.find(
          (report) => report.id === current.id,
        );
        if (!confirmed || !reportMatchesPatch(confirmed, patch)) {
          throw new Error(
            "The update returned, but a fresh read did not confirm the requested definition.",
          );
        }
        if (!operationIsCurrent(generation, controller)) return;
        queryClient.setQueryData(queryKey, after);
        setActionStatus("Scheduled report update confirmed by a fresh read.");
      } else {
        const input = createInput(opened);
        const receipt = await createScheduledReport(input, {
          signal: controller.signal,
        });
        const after = await listScheduledReports(identity.tenant_id, {
          signal: controller.signal,
          fresh: true,
        });
        const confirmed = after.reports.find(
          (report) => report.id === receipt.id,
        );
        if (
          !confirmed ||
          confirmed.template !== input.template ||
          !reportMatchesPatch(confirmed, { ...input, enabled: true })
        ) {
          throw new Error(
            "The create returned, but a fresh read did not confirm the new definition.",
          );
        }
        if (!operationIsCurrent(generation, controller)) return;
        queryClient.setQueryData(queryKey, after);
        setActionStatus("Scheduled report creation confirmed by a fresh read.");
      }
      if (!operationIsCurrent(generation, controller)) return;
      setEditor(null);
      setAcknowledged(false);
      toast.success(
        opened.baseline
          ? "Scheduled report updated."
          : "Scheduled report created.",
      );
    } catch (error) {
      if (!operationIsCurrent(generation, controller)) return;
      setActionError(
        apiErrorMessage(
          error,
          "The scheduled report write could not be confirmed.",
        ),
      );
      void reportsQuery.refetch();
    } finally {
      finishOperation(generation, controller);
    }
  }

  async function removeReport(target: ScheduledReport): Promise<void> {
    if (!identity || !canAdmin || operationRef.current) return;
    const { generation, controller } = beginOperation();
    setSaving(true);
    setActionError(null);
    setActionStatus(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await listScheduledReports(identity.tenant_id, {
        signal: controller.signal,
        fresh: true,
      });
      const current = before.reports.find((report) => report.id === target.id);
      if (!current || !sameScheduledReportConfiguration(target, current)) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This definition changed after deletion was opened. Review the fresh server state.",
        );
      }
      await deleteScheduledReport(target.id, { signal: controller.signal });
      const after = await listScheduledReports(identity.tenant_id, {
        signal: controller.signal,
        fresh: true,
      });
      if (after.reports.some((report) => report.id === target.id)) {
        throw new Error(
          "The delete returned, but a fresh read still contains this definition.",
        );
      }
      if (!operationIsCurrent(generation, controller)) return;
      queryClient.setQueryData(queryKey, after);
      setDeleteTarget(null);
      setActionStatus(
        "Recurring definition removed. Historical run evidence follows server retention policy.",
      );
      toast.success("Scheduled report deleted.");
    } catch (error) {
      if (!operationIsCurrent(generation, controller)) return;
      const message = apiErrorMessage(
        error,
        "The scheduled report deletion could not be confirmed.",
      );
      setActionError(message);
      void reportsQuery.refetch();
      throw new Error(message);
    } finally {
      finishOperation(generation, controller);
    }
  }

  async function queueRun(intent: SendIntent): Promise<void> {
    if (!identity || !canAdmin || operationRef.current) return;
    const { generation, controller } = beginOperation();
    setSaving(true);
    setActionError(null);
    setActionStatus(null);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const before = await listScheduledReports(identity.tenant_id, {
        signal: controller.signal,
        fresh: true,
      });
      const current = before.reports.find(
        (report) => report.id === intent.report.id,
      );
      if (
        !current ||
        !sameScheduledReportConfiguration(intent.report, current)
      ) {
        queryClient.setQueryData(queryKey, before);
        throw new Error(
          "This definition changed after send review opened. Review the fresh recipients and schedule.",
        );
      }
      const receipt = await sendScheduledReportNow(
        current.id,
        intent.idempotencyKey,
        { signal: controller.signal },
      );
      if (!operationIsCurrent(generation, controller)) return;
      setLastReceipt(receipt);
      setSendIntent(null);
      setActionStatus(
        `Durable run ${receipt.runId.slice(0, 8)} is queued. This is not a provider-acceptance or inbox-delivery claim.`,
      );
      toast.success("Scheduled report run queued.");

      // Queue acceptance is already proven by the parsed 202 receipt. A
      // follow-up list failure must not turn that committed result into an
      // apparent send failure or invite a new idempotency key.
      try {
        const after = await listScheduledReports(identity.tenant_id, {
          signal: controller.signal,
          fresh: true,
        });
        if (operationIsCurrent(generation, controller)) {
          queryClient.setQueryData(queryKey, after);
        }
      } catch {
        if (operationIsCurrent(generation, controller)) {
          setActionStatus(
            `Durable run ${receipt.runId.slice(0, 8)} is queued, but the latest aggregate status could not be refreshed yet. Do not create a second request identity.`,
          );
        }
      }
    } catch (error) {
      if (!operationIsCurrent(generation, controller)) return;
      const ambiguous = isAmbiguousScheduledReportRunError(error);
      const message = ambiguous
        ? "The queue response could not be confirmed. Retry this same review to reuse its original request identity; do not open a new send-now review."
        : apiErrorMessage(error, "The report run was not queued.");
      setActionError(message);
      throw new Error(message);
    } finally {
      finishOperation(generation, controller);
    }
  }

  return (
    <GovernanceSection
      className="lg:col-span-2"
      icon={CalendarClock}
      title="Scheduled reports"
      description="Recurring email definitions with durable latest-run evidence and deliberate manual runs."
    >
      <div className="space-y-4">
        <Alert role="note">
          <AlertTitle>Delivery evidence boundary</AlertTitle>
          <AlertDescription>
            “Accepted” means the configured mail provider accepted a request; it
            does not prove inbox placement, delivery, or an open. This API
            exposes only the latest aggregate run, not per-recipient receipts or
            worker availability. A queued run may remain queued when the
            scheduled-report worker is disabled.
          </AlertDescription>
        </Alert>

        {!identity ? (
          <GovernanceLoading label="Verifying scheduled report authority…" />
        ) : !canAdmin ? (
          <Alert role="note">
            <AlertTitle>Administrator access required</AlertTitle>
            <AlertDescription>
              Scheduled definitions contain recipient addresses, so they stay
              hidden for the current {role ?? "unknown"} role and in viewer
              mode.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-muted-foreground">
                {snapshot
                  ? `${reports.length.toLocaleString()} definition${reports.length === 1 ? "" : "s"} · verified ${formatWireTimestamp(snapshot.observedAt, "at an unknown time")}`
                  : "Recipient-bearing state has not been verified yet."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={reportsQuery.isFetching || saving}
                  loading={reportsQuery.isFetching}
                  onClick={() => void reportsQuery.refetch()}
                >
                  {reportsQuery.isFetching ? "Refreshing…" : "Refresh evidence"}
                </Button>
                <Button
                  type="button"
                  disabled={saving || editor !== null}
                  onClick={() => {
                    setEditor(editorFromReport());
                    setAcknowledged(false);
                    setActionError(null);
                  }}
                >
                  New report
                </Button>
              </div>
            </div>

            {reportsQuery.isPending && !snapshot ? (
              <GovernanceLoading
                label="Loading scheduled report definitions…"
                rows={3}
              />
            ) : reportsQuery.isError && !snapshot ? (
              <GovernanceError
                message={apiErrorMessage(
                  reportsQuery.error,
                  "Scheduled report definitions and recipient evidence could not be verified.",
                )}
                retrying={reportsQuery.isFetching}
                onRetry={() => void reportsQuery.refetch()}
              />
            ) : reports.length === 0 ? (
              <GovernanceEmpty>
                No scheduled report definitions were returned for this
                workspace.
              </GovernanceEmpty>
            ) : (
              <ul className="space-y-3">
                {reports.map((report) => {
                  const status = statusCopy(report.latestRunStatus);
                  const classified =
                    report.latestRunAcceptedCount +
                    report.latestRunFailedCount +
                    report.latestRunUnknownCount;
                  const pending = Math.max(
                    0,
                    report.latestRunRecipientCount - classified,
                  );
                  return (
                    <li
                      key={report.id}
                      className="min-w-0 rounded-xl border bg-muted/15 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-words font-medium">
                              {report.name}
                            </p>
                            <Badge
                              variant={report.enabled ? "success" : "secondary"}
                            >
                              {report.enabled ? "Active" : "Paused"}
                            </Badge>
                            <Badge variant={status.variant}>
                              {status.label}
                            </Badge>
                          </div>
                          <p className="break-words text-sm text-muted-foreground">
                            {templateLabel(report.template)} ·{" "}
                            {scheduleLabel(report)} · {report.timezone}
                          </p>
                          <p className="text-xs leading-5 text-muted-foreground">
                            {report.enabled
                              ? `Next due ${formatWireTimestamp(report.nextDueAt, "not reported")}`
                              : "Recurring execution is paused"}
                            {report.latestRunCreatedAt
                              ? ` · latest run created ${formatWireTimestamp(report.latestRunCreatedAt, "at an unknown time")}`
                              : " · no latest run timestamp"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving || editor !== null}
                            onClick={() => {
                              setSendIntent({
                                report,
                                idempotencyKey: newScheduledReportRunKey(),
                              });
                              setActionError(null);
                            }}
                          >
                            Send now
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving || editor !== null}
                            onClick={() => {
                              setEditor(editorFromReport(report));
                              setAcknowledged(false);
                              setActionError(null);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={saving || editor !== null}
                            onClick={() => {
                              setDeleteTarget(report);
                              setActionError(null);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-md border bg-background/70 p-3 text-xs leading-5">
                          <p className="font-medium">Latest run evidence</p>
                          <p className="text-muted-foreground">
                            {status.detail}
                          </p>
                          {report.latestRunId ? (
                            <p className="mt-1 break-all font-mono text-muted-foreground">
                              Run {report.latestRunId}
                            </p>
                          ) : null}
                        </div>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-background/70 p-3 text-xs">
                          <div>
                            <dt className="text-muted-foreground">Accepted</dt>
                            <dd className="font-medium tabular-nums">
                              {report.latestRunAcceptedCount}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">
                              Failed/skipped
                            </dt>
                            <dd className="font-medium tabular-nums">
                              {report.latestRunFailedCount}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Unknown</dt>
                            <dd className="font-medium tabular-nums">
                              {report.latestRunUnknownCount}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Pending</dt>
                            <dd className="font-medium tabular-nums">
                              {pending}
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <details className="mt-3 rounded-md border bg-background/70 p-3 text-xs">
                        <summary className="cursor-pointer font-medium">
                          {report.recipients.length} recipient
                          {report.recipients.length === 1 ? "" : "s"}
                        </summary>
                        <ul className="mt-2 space-y-1 text-muted-foreground">
                          {report.recipients.map((recipient) => (
                            <li key={recipient} className="break-all font-mono">
                              {recipient}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {editor && canAdmin ? (
          <form
            className="space-y-4 rounded-xl border bg-muted/20 p-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void saveEditor();
            }}
          >
            <div>
              <h3 className="font-medium">
                {editor.baseline
                  ? "Edit scheduled report"
                  : "New scheduled report"}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                The backend has no ETag or definition updated timestamp. Save
                uses an exact fresh configuration preflight and post-write
                readback, but a narrow change-and-revert race cannot be proven.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="scheduled-report-name">Name</Label>
                <Input
                  id="scheduled-report-name"
                  value={editor.name}
                  maxLength={160}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? { ...current, name: event.target.value }
                        : current,
                    )
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-report-template">Template</Label>
                <Select
                  id="scheduled-report-template"
                  value={editor.template}
                  disabled={saving || Boolean(editor.baseline)}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            template: event.target
                              .value as ScheduledReportTemplate,
                          }
                        : current,
                    )
                  }
                >
                  {TEMPLATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                {editor.baseline ? (
                  <p className="text-xs text-muted-foreground">
                    The canonical PATCH route does not support changing a
                    template.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="scheduled-report-cadence">Cadence</Label>
                <Select
                  id="scheduled-report-cadence"
                  value={editor.schedule.kind}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            schedule: {
                              ...current.schedule,
                              kind: event.target.value as ScheduleParts["kind"],
                            },
                          }
                        : current,
                    )
                  }
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={scheduleTargetId}>
                  {editor.schedule.kind === "weekly"
                    ? "Weekday"
                    : "Day of month"}
                </Label>
                {editor.schedule.kind === "weekly" ? (
                  <Select
                    id={scheduleTargetId}
                    value={editor.schedule.weekday}
                    disabled={saving}
                    onChange={(event) =>
                      setEditor((current) =>
                        current
                          ? {
                              ...current,
                              schedule: {
                                ...current.schedule,
                                weekday: event.target
                                  .value as ScheduleParts["weekday"],
                              },
                            }
                          : current,
                      )
                    }
                  >
                    {WEEKDAYS.map((weekday) => (
                      <option key={weekday} value={weekday}>
                        {weekday.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={scheduleTargetId}
                    type="number"
                    min={1}
                    max={28}
                    value={editor.schedule.dayOfMonth}
                    disabled={saving}
                    onChange={(event) =>
                      setEditor((current) =>
                        current
                          ? {
                              ...current,
                              schedule: {
                                ...current.schedule,
                                dayOfMonth: Number(event.target.value),
                              },
                            }
                          : current,
                      )
                    }
                  />
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-report-time">Local time</Label>
                <Input
                  id="scheduled-report-time"
                  type="time"
                  value={editor.schedule.time}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            schedule: {
                              ...current.schedule,
                              time: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="scheduled-report-timezone">IANA timezone</Label>
              <Input
                id="scheduled-report-timezone"
                list="scheduled-report-timezones"
                value={editor.timezone}
                maxLength={64}
                disabled={saving}
                spellCheck={false}
                onChange={(event) =>
                  setEditor((current) =>
                    current
                      ? { ...current, timezone: event.target.value }
                      : current,
                  )
                }
              />
              <datalist id="scheduled-report-timezones">
                {TIMEZONE_SUGGESTIONS.map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
              <p className="text-xs leading-5 text-muted-foreground">
                Fall-back uses the first matching wall-clock occurrence;
                spring-forward moves a missing time to the first valid minute.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="scheduled-report-recipients">
                Recipient mailboxes (1–20)
              </Label>
              <Textarea
                id="scheduled-report-recipients"
                value={editor.recipientsText}
                maxLength={6_500}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                // A JSX string attribute renders "\n" literally, which
                // demonstrated a format the recipient parser rejects — the
                // expression keeps the real newline.
                placeholder={"ops@example.com\nowner@example.com"}
                onChange={(event) =>
                  setEditor((current) =>
                    current
                      ? { ...current, recipientsText: event.target.value }
                      : current,
                  )
                }
              />
            </div>

            {editor.baseline ? (
              <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                <Checkbox
                  checked={editor.enabled}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? { ...current, enabled: event.target.checked }
                        : current,
                    )
                  }
                />
                <span>
                  Recurring execution enabled. Turning this off pauses future
                  scheduled occurrences but does not cancel an existing run.
                </span>
              </label>
            ) : null}

            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={acknowledged}
                disabled={saving}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I reviewed the timezone, cadence, and every recipient. Saving an
                active definition can cause recurring external email.
              </span>
            </label>

            {validation ? (
              <p role="alert" className="text-sm text-destructive-emphasis">
                {validation}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={Boolean(validation) || !acknowledged || saving}
                loading={saving}
              >
                {editor.baseline ? "Save report" : "Create report"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setEditor(null);
                  setAcknowledged(false);
                }}
              >
                {dirty ? "Discard draft" : "Cancel"}
              </Button>
            </div>
          </form>
        ) : null}

        {actionError ? (
          <Alert variant="destructive">
            <AlertTitle>Operation not confirmed</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
        {actionStatus ? (
          <p
            role="status"
            className="rounded-md border bg-muted/20 p-3 text-sm"
          >
            {actionStatus}
          </p>
        ) : null}
        {lastReceipt ? (
          <dl className="grid gap-2 rounded-md border p-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Durable run</dt>
              <dd className="break-all font-mono">{lastReceipt.runId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Queue status</dt>
              <dd>Queued for worker processing</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Occurrence</dt>
              <dd>
                {formatWireTimestamp(
                  lastReceipt.occurrenceAt,
                  "at an unknown time",
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDeleteTarget(null);
        }}
        title={`Delete “${deleteTarget?.name ?? "scheduled report"}”?`}
        description="The recurring definition is permanently removed immediately. The API does not expose a restore operation; historical run records follow server retention policy."
        confirmLabel="Delete report"
        confirmationToken="DELETE REPORT"
        onConfirm={async () => {
          if (deleteTarget) await removeReport(deleteTarget);
        }}
      />

      <ConfirmDialog
        open={sendIntent !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setSendIntent(null);
        }}
        title={`Queue one run of “${sendIntent?.report?.name ?? "scheduled report"}”?`}
        description={
          sendIntent
            ? `This creates a live durable run for ${sendIntent.report.recipients.length} recipient${sendIntent.report.recipients.length === 1 ? "" : "s"}, even when the recurring definition is paused. Queued does not mean accepted or delivered. An uncertain retry reuses this review's same request identity.`
            : "This creates one live durable run."
        }
        confirmLabel="Queue run"
        confirmVariant="default"
        confirmationToken="QUEUE RUN"
        onConfirm={async () => {
          if (sendIntent) await queueRun(sendIntent);
        }}
      />
    </GovernanceSection>
  );
}
