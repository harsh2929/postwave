// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// SETA-056 — "Audit streaming" settings: manage streaming sinks (SIEM / S3 /
// webhook destinations for the audit log) and scheduled email exports, over the
// already-mounted /api/v1/audit-sinks + /api/v1/audit/export-schedules CRUD.
// Reads need audit:read; every mutation needs audit:configure_sinks (enforced
// server-side; the UI gate is a convenience, not the security boundary).

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import { getAuditAuthority } from "@/lib/audit-operations-api";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { qk, STALE } from "@/lib/query-keys";
import {
  SINK_FIELD_SPECS,
  createAuditSink,
  createExportSchedule,
  deleteAuditSink,
  deleteExportSchedule,
  listAuditSinks,
  listExportSchedules,
  patchAuditSink,
  testAuditSinkPreflight,
  type AuditExportSchedule,
  type AuditSink,
  type CreateSinkInput,
  type ScheduleCadence,
} from "@/lib/audit-sinks-api";
import {
  buildSinkEditInput,
  collectFilled,
  missingRequired,
  sinkEditIsUnchanged,
  type SinkFormValue,
} from "./sink-form";

const CreateSinkDialog = dynamic(
  () =>
    import("./audit-sink-dialogs").then((module) => module.CreateSinkDialog),
  { ssr: false, loading: () => <DialogLoading label="sink editor" /> },
);
const EditSinkDialog = dynamic(
  () => import("./audit-sink-dialogs").then((module) => module.EditSinkDialog),
  { ssr: false, loading: () => <DialogLoading label="sink editor" /> },
);
const CreateScheduleDialog = dynamic(
  () =>
    import("./audit-sink-dialogs").then(
      (module) => module.CreateScheduleDialog,
    ),
  { ssr: false, loading: () => <DialogLoading label="schedule editor" /> },
);
const DeferredConfirmDialog = dynamic(
  () =>
    import("@/components/ui/confirm-dialog").then(
      (module) => module.ConfirmDialog,
    ),
  { ssr: false, loading: () => <DialogLoading label="confirmation" /> },
);
const AuditSinkRecoveryPanel = dynamic(
  () =>
    import("@/components/settings/audit-sink-recovery-panel").then(
      (module) => module.AuditSinkRecoveryPanel,
    ),
  { ssr: false, loading: () => <RecoveryPanelLoading /> },
);

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function SinkHealthBadge({ sink }: { sink: AuditSink }) {
  if (!sink.enabled) {
    // A sink auto-disabled by repeated failures is broken, not a benign pause.
    if (
      sink.circuit_state === "open" ||
      sink.consecutive_failures >= sink.auto_disable_after
    ) {
      return <Badge variant="destructive">Auto-disabled</Badge>;
    }
    return <Badge variant="secondary">Disabled</Badge>;
  }
  if (sink.circuit_state === "open") {
    return <Badge variant="destructive">Failing</Badge>;
  }
  if (sink.consecutive_failures > 0) {
    return (
      <Badge variant="warning">
        {sink.consecutive_failures}/{sink.auto_disable_after}
      </Badge>
    );
  }
  return <Badge variant="success">Healthy</Badge>;
}

function emptySinkForm(): SinkFormValue {
  return {
    name: "",
    kind: "http",
    config: {},
    credentials: {},
    outputFormat: "postwave_native",
    webhookFormat: "postwave_v1",
  };
}

function sinkFormFromRow(sink: AuditSink): SinkFormValue {
  const config: Record<string, string> = {};
  for (const key of SINK_FIELD_SPECS[sink.kind].config) {
    const raw = sink.config?.[key];
    config[key] = raw == null ? "" : String(raw);
  }
  return {
    name: sink.name,
    kind: sink.kind,
    config,
    // Credentials are write-only — never returned. Blank = leave unchanged.
    credentials: {},
    outputFormat: sink.output_format,
    webhookFormat: sink.webhook_format,
  };
}

// ---- Page ------------------------------------------------------------------

export default function AuditSinksPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const identityBase = useMemo(
    () => [tenantId, userId, role ?? "none", viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const authorityKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "audit-sinks"),
        userId,
        viewerState,
        "authority",
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const authorityQuery = useQuery({
    queryKey: authorityKey,
    queryFn: ({ signal }) => getAuditAuthority({ signal }),
    enabled: meQuery.isSuccess,
    staleTime: 0,
    retry: false,
  });
  const canConfigure =
    authorityQuery.data?.auditScopes?.includes("audit:configure_sinks") === true;
  const canReadSchedules =
    authorityQuery.data?.auditScopes?.includes("audit:read") === true &&
    authorityQuery.data.auditScopes.includes("audit:read_pii");
  const canWrite = Boolean(
    meQuery.isSuccess &&
    !meQuery.data?.viewer_mode &&
    roleCanWrite(role) &&
    canConfigure,
  );

  const sinksKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "audit-sinks"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const schedulesKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "audit-export-schedules"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );

  const sinksQuery = useQuery({
    queryKey: sinksKey,
    queryFn: ({ signal }) => listAuditSinks({ signal }),
    enabled: meQuery.isSuccess && authorityQuery.isSuccess && canConfigure,
    staleTime: STALE.list,
  });
  const schedulesQuery = useQuery({
    queryKey: schedulesKey,
    queryFn: ({ signal }) => listExportSchedules({ signal }),
    enabled: meQuery.isSuccess && authorityQuery.isSuccess && canReadSchedules,
    staleTime: STALE.list,
  });
  const sinks = Array.isArray(sinksQuery.data?.sinks)
    ? sinksQuery.data?.sinks
    : [];
  const schedules = Array.isArray(schedulesQuery.data?.schedules)
    ? schedulesQuery.data?.schedules
    : [];

  useEffect(() => {
    if (sinksQuery.error) toast.error("Failed to load audit sinks.");
  }, [sinksQuery.error]);
  useEffect(() => {
    if (schedulesQuery.error) toast.error("Failed to load export schedules.");
  }, [schedulesQuery.error]);

  const invalidateSinks = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: sinksKey, exact: false })
      .then(() => undefined);
  const invalidateSchedules = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: schedulesKey, exact: false })
      .then(() => undefined);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const previousKeysRef = useRef<{
    identity: readonly unknown[];
    keys: readonly (readonly unknown[])[];
  } | null>(null);
  const [createSinkError, setCreateSinkError] = useState<string | null>(null);
  const [createSinkTestReceipt, setCreateSinkTestReceipt] = useState<
    string | null
  >(null);
  const [editSinkError, setEditSinkError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const createSinkErrorRef = useRef<HTMLParagraphElement>(null);
  const editSinkErrorRef = useRef<HTMLParagraphElement>(null);
  const scheduleErrorRef = useRef<HTMLParagraphElement>(null);
  const createSinkReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const editSinkReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const scheduleReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  // Sink create/edit dialogs.
  const [createSinkOpen, setCreateSinkOpen] = useState(false);
  const [createSinkForm, setCreateSinkForm] =
    useState<SinkFormValue>(emptySinkForm);
  const [testedSinkFingerprint, setTestedSinkFingerprint] = useState<
    string | null
  >(null);
  const [editingSink, setEditingSink] = useState<AuditSink | null>(null);
  const [editSinkForm, setEditSinkForm] =
    useState<SinkFormValue>(emptySinkForm);

  // Schedule create dialog.
  const [createSchedOpen, setCreateSchedOpen] = useState(false);
  const [schedCadence, setSchedCadence] = useState<ScheduleCadence>("weekly");
  const [schedRecipients, setSchedRecipients] = useState("");
  const editSinkUnchanged = editingSink
    ? sinkEditIsUnchanged(editSinkForm, sinkFormFromRow(editingSink))
    : true;

  useEffect(() => {
    const previous = previousKeysRef.current;
    if (previous && previous.identity !== identityBase) {
      savingRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
      setSaving(false);
      setCreateSinkOpen(false);
      setCreateSchedOpen(false);
      setEditingSink(null);
      setCreateSinkForm(emptySinkForm());
      setEditSinkForm(emptySinkForm());
      setSchedRecipients("");
      setCreateSinkTestReceipt(null);
      setTestedSinkFingerprint(null);
      for (const key of previous.keys) {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.removeQueries({ queryKey: key });
      }
    }
    previousKeysRef.current = {
      identity: identityBase,
      keys: [authorityKey, sinksKey, schedulesKey],
    };
    if (!meQuery.isSuccess) {
      for (const key of [authorityKey, sinksKey, schedulesKey]) {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.removeQueries({ queryKey: key });
      }
    }
  }, [
    authorityKey,
    identityBase,
    meQuery.isSuccess,
    queryClient,
    schedulesKey,
    sinksKey,
  ]);

  useEffect(() => {
    if (createSinkError) createSinkErrorRef.current?.focus();
  }, [createSinkError]);
  useEffect(() => {
    if (editSinkError) editSinkErrorRef.current?.focus();
  }, [editSinkError]);
  useEffect(() => {
    if (scheduleError) scheduleErrorRef.current?.focus();
  }, [scheduleError]);

  const beginSaving = (): boolean => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    return true;
  };

  const finishSaving = () => {
    savingRef.current = false;
    setSaving(false);
  };

  const buildCreateSinkInput = (): CreateSinkInput => ({
    kind: createSinkForm.kind,
    name: createSinkForm.name.trim(),
    output_format: createSinkForm.outputFormat,
    webhook_format: createSinkForm.webhookFormat,
    config: collectFilled(createSinkForm.config),
    credentials: collectFilled(createSinkForm.credentials),
  });

  const reauthorizeConfigure = async (
    expectedSink?: AuditSink,
    expectedSchedule?: AuditExportSchedule,
    signal?: AbortSignal,
  ): Promise<void> => {
    const [freshIdentity, freshAuthority, freshSinks, freshSchedules] =
      await Promise.all([
        whoamiFresh(signal),
        getAuditAuthority({ cache: "no-store", signal }),
        expectedSink
          ? listAuditSinks({ cache: "no-store", signal })
          : Promise.resolve({ sinks: [] }),
        expectedSchedule
          ? listExportSchedules({ cache: "no-store", signal })
          : Promise.resolve({ schedules: [] }),
      ]);
    if (
      freshIdentity.tenant_id !== tenantId ||
      freshIdentity.user_id !== meQuery.data?.user_id ||
      effectiveAuthRole(freshIdentity) !== role ||
      Boolean(freshIdentity.viewer_mode) !==
        Boolean(meQuery.data?.viewer_mode) ||
      freshIdentity.viewer_mode === true ||
      !freshAuthority.auditScopes.includes("audit:configure_sinks")
    ) {
      throw new Error(
        "Workspace identity or audit-sink authority changed. Reload before trying again.",
      );
    }
    if (expectedSink) {
      const current = freshSinks.sinks.find(
        (sink) => sink.id === expectedSink.id,
      );
      if (
        !current ||
        sinkInventoryFingerprint(current) !==
          sinkInventoryFingerprint(expectedSink)
      ) {
        throw new Error(
          "The sink changed after this view loaded. Refresh and review its current state.",
        );
      }
    }
    if (expectedSchedule) {
      const current = freshSchedules.schedules.find(
        (schedule) => schedule.id === expectedSchedule.id,
      );
      if (
        !current ||
        scheduleInventoryFingerprint(current) !==
          scheduleInventoryFingerprint(expectedSchedule)
      ) {
        throw new Error(
          "The export schedule changed after this view loaded. Refresh before deleting it.",
        );
      }
    }
  };

  const authorizedTransport = async <T,>(
    operation: (signal: AbortSignal) => Promise<T>,
    expectedSink?: AuditSink,
    expectedSchedule?: AuditExportSchedule,
  ): Promise<T> => {
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await reauthorizeConfigure(
        expectedSink,
        expectedSchedule,
        controller.signal,
      );
      return await operation(controller.signal);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  useEffect(() => () => controllerRef.current?.abort(), []);

  const handleTestSink = async (): Promise<void> => {
    if (savingRef.current) return;
    const err = missingRequired(createSinkForm, false);
    if (err) {
      setCreateSinkError(err);
      return;
    }
    const input = buildCreateSinkInput();
    if (!beginSaving()) return;
    setCreateSinkError(null);
    setCreateSinkTestReceipt(null);
    try {
      const receipt = await authorizedTransport((signal) =>
        testAuditSinkPreflight(input, { signal }),
      );
      setTestedSinkFingerprint(sinkDraftFingerprint(createSinkForm));
      setCreateSinkTestReceipt(
        `The server delivered one ${receipt.kind} canary. Review the destination, then create the sink without changing this form.`,
      );
    } catch (error) {
      setTestedSinkFingerprint(null);
      setCreateSinkError(errText(error, "Could not verify this sink draft."));
    } finally {
      finishSaving();
    }
  };

  const handleCreateSink = async () => {
    if (savingRef.current) return;
    const err = missingRequired(createSinkForm, false);
    if (err) {
      setCreateSinkError(err);
      toast.error(err);
      return;
    }
    if (testedSinkFingerprint !== sinkDraftFingerprint(createSinkForm)) {
      const message =
        "Test the current destination and credentials before creating this sink.";
      setCreateSinkError(message);
      return;
    }
    const input = buildCreateSinkInput();
    if (!beginSaving()) return;
    setCreateSinkError(null);
    try {
      await authorizedTransport((signal) => createAuditSink(input, { signal }));
      toast.success("Sink created.");
      setCreateSinkForm(emptySinkForm());
      setTestedSinkFingerprint(null);
      setCreateSinkTestReceipt(null);
      savingRef.current = false;
      setCreateSinkOpen(false);
      // Create returns a partial row — refetch for the full row + health.
      void invalidateSinks();
    } catch (e) {
      const message = errText(e, "Could not create sink.");
      setCreateSinkError(message);
      toast.error(message);
    } finally {
      finishSaving();
    }
  };

  const openEditSink = (sink: AuditSink, trigger: HTMLButtonElement) => {
    editSinkReturnFocusRef.current = trigger;
    setEditSinkForm(sinkFormFromRow(sink));
    setEditSinkError(null);
    setEditingSink(sink);
  };

  const handleEditSink = async () => {
    if (savingRef.current) return;
    if (!editingSink) return;
    const err = missingRequired(editSinkForm, true);
    if (err) {
      setEditSinkError(err);
      toast.error(err);
      return;
    }
    if (sinkEditIsUnchanged(editSinkForm, sinkFormFromRow(editingSink))) {
      setEditSinkError("No changes to save.");
      return;
    }
    const input = buildSinkEditInput(editSinkForm);
    if (!beginSaving()) return;
    setEditSinkError(null);
    try {
      await authorizedTransport(
        (signal) => patchAuditSink(editingSink.id, input, { signal }),
        editingSink,
      );
      toast.success("Sink updated.");
      savingRef.current = false;
      setEditingSink(null);
      void invalidateSinks();
    } catch (e) {
      const message = errText(e, "Could not update sink.");
      setEditSinkError(message);
      toast.error(message);
    } finally {
      finishSaving();
    }
  };

  const handleToggleSink = async (sink: AuditSink) => {
    if (!beginSaving()) return;
    try {
      const enabled = !sink.enabled;
      await authorizedTransport(
        (signal) => patchAuditSink(sink.id, { enabled }, { signal }),
        sink,
      );
      queryClient.setQueryData<{ sinks: AuditSink[] } | undefined>(
        sinksKey,
        (cur) =>
          cur
            ? {
                sinks: cur.sinks.map((s) =>
                  s.id === sink.id ? { ...s, enabled: !s.enabled } : s,
                ),
              }
            : cur,
      );
      toast.success(sink.enabled ? "Sink disabled." : "Sink enabled.");
      void invalidateSinks();
    } catch (e) {
      toast.error(errText(e, "Could not change sink status."));
    } finally {
      finishSaving();
    }
  };

  const handleDeleteSink = async (sink: AuditSink) => {
    if (!beginSaving()) return;
    try {
      await authorizedTransport(
        (signal) => deleteAuditSink(sink.id, { signal }),
        sink,
      );
      queryClient.setQueryData<{ sinks: AuditSink[] } | undefined>(
        sinksKey,
        (cur) =>
          cur
            ? {
                sinks: cur.sinks.filter(
                  (candidate) => candidate.id !== sink.id,
                ),
              }
            : cur,
      );
      toast.success("Sink deleted.");
      void invalidateSinks();
    } catch (e) {
      toast.error(errText(e, "Delete failed."));
      throw e;
    } finally {
      finishSaving();
    }
  };

  const handleCreateSchedule = async () => {
    if (savingRef.current) return;
    const parsed = schedRecipients
      .split(/[,\n]/)
      .map((r) => r.trim())
      .filter(Boolean);
    // De-dup case-insensitively (mirrors the backend) before the count cap so a
    // list the server would accept isn't falsely rejected.
    const recipients = Array.from(
      new Map(parsed.map((r) => [r.toLowerCase(), r])).values(),
    );
    if (recipients.length === 0) {
      const message = "Add at least one recipient email.";
      setScheduleError(message);
      toast.error(message);
      return;
    }
    if (recipients.length > 20) {
      const message = "At most 20 recipients.";
      setScheduleError(message);
      toast.error(message);
      return;
    }
    if (!recipients.every((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) {
      const message = "One or more recipients is not a valid email.";
      setScheduleError(message);
      toast.error(message);
      return;
    }
    if (!beginSaving()) return;
    setScheduleError(null);
    try {
      const frozen = { cadence: schedCadence, recipients: [...recipients] };
      const created = await authorizedTransport((signal) =>
        createExportSchedule(frozen, { signal }),
      );
      queryClient.setQueryData<
        { schedules: AuditExportSchedule[] } | undefined
      >(schedulesKey, (cur) => ({
        schedules: [created, ...(cur?.schedules ?? [])],
      }));
      toast.success("Schedule created.");
      setSchedRecipients("");
      setSchedCadence("weekly");
      savingRef.current = false;
      setCreateSchedOpen(false);
      void invalidateSchedules();
    } catch (e) {
      const message = errText(e, "Could not create schedule.");
      setScheduleError(message);
      toast.error(message);
    } finally {
      finishSaving();
    }
  };

  const handleDeleteSchedule = async (schedule: AuditExportSchedule) => {
    if (!beginSaving()) return;
    try {
      await authorizedTransport(
        (signal) => deleteExportSchedule(schedule.id, { signal }),
        undefined,
        schedule,
      );
      queryClient.setQueryData<
        { schedules: AuditExportSchedule[] } | undefined
      >(schedulesKey, (cur) =>
        cur
          ? {
              schedules: cur.schedules.filter(
                (candidate) => candidate.id !== schedule.id,
              ),
            }
          : cur,
      );
      toast.success("Schedule removed.");
      void invalidateSchedules();
    } catch (e) {
      toast.error(errText(e, "Delete failed."));
      throw e;
    } finally {
      finishSaving();
    }
  };

  const sinksLoading =
    meQuery.isLoading ||
    (canConfigure && sinksQuery.isPending && !sinksQuery.data);
  const schedulesLoading =
    meQuery.isLoading ||
    (canReadSchedules && schedulesQuery.isPending && !schedulesQuery.data);

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Audit streaming
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Stream the audit log to your SIEM, object storage, or a webhook, and
          schedule recurring email exports.
        </p>
      </header>

      {/* Sinks -------------------------------------------------------------- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Streaming sinks</CardTitle>
            <CardDescription>
              Durable delivery of every audit event to an external destination,
              with automatic circuit-breaking on repeated failures.
            </CardDescription>
          </div>
          {canWrite ? (
            <>
              <Button
                ref={createSinkReturnFocusRef}
                type="button"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={createSinkOpen}
                onClick={(event) => {
                  createSinkReturnFocusRef.current = event.currentTarget;
                  setCreateSinkError(null);
                  setCreateSinkOpen(true);
                }}
              >
                Add sink
              </Button>
              {createSinkOpen ? (
                <CreateSinkDialog
                  saving={saving}
                  savingRef={savingRef}
                  returnFocusRef={createSinkReturnFocusRef}
                  form={createSinkForm}
                  error={createSinkError}
                  testReceipt={createSinkTestReceipt}
                  errorRef={createSinkErrorRef}
                  tested={
                    testedSinkFingerprint ===
                    sinkDraftFingerprint(createSinkForm)
                  }
                  onFormChange={(next) => {
                    setCreateSinkError(null);
                    setCreateSinkTestReceipt(null);
                    setTestedSinkFingerprint(null);
                    setCreateSinkForm(next);
                  }}
                  onTest={handleTestSink}
                  onSubmit={handleCreateSink}
                  onOpenChange={(open) => {
                    if (!open && savingRef.current) return;
                    setCreateSinkOpen(open);
                    if (open) setCreateSinkError(null);
                    if (!open) {
                      setCreateSinkForm(emptySinkForm());
                      setCreateSinkError(null);
                      setTestedSinkFingerprint(null);
                      setCreateSinkTestReceipt(null);
                    }
                  }}
                />
              ) : null}
            </>
          ) : null}
        </CardHeader>
        <CardContent>
          {authorityQuery.isPending || sinksLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : authorityQuery.isError ? (
            <EmptyState
              title="Audit authority unavailable"
              description="Sink inventory is withheld until the current audit scopes can be verified."
            />
          ) : !canConfigure ? (
            <EmptyState
              title="Audit sink access required"
              description="This session does not hold audit:configure_sinks, which the server requires even to read destination topology."
            />
          ) : sinksQuery.isError ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning-emphasis">
              <span>Couldn&apos;t load audit sinks.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void sinksQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : sinks.length === 0 ? (
            <EmptyState
              title="No streaming sinks"
              description="Add a sink to stream the audit log to your SIEM, S3, or a webhook."
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Health</TableHead>
                    {canWrite ? (
                      <TableHead className="text-right">Actions</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sinks.map((sink) => (
                    <TableRow key={sink.id}>
                      <TableCell className="font-medium">{sink.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {sink.kind}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {sink.output_format}
                      </TableCell>
                      <TableCell>
                        <SinkHealthBadge sink={sink} />
                        {sink.has_last_error ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (provider details withheld)
                          </span>
                        ) : null}
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <LazyConfirmAction
                              triggerLabel={sink.enabled ? "Disable" : "Enable"}
                              title={
                                sink.enabled
                                  ? "Pause this audit sink?"
                                  : "Resume this audit sink?"
                              }
                              description={
                                sink.enabled
                                  ? "Scheduled delivery stops after the server applies this change. Recovery evidence remains available."
                                  : "Scheduled delivery resumes with the current stored destination and credentials."
                              }
                              confirmLabel={
                                sink.enabled ? "Pause sink" : "Resume sink"
                              }
                              onConfirm={() => handleToggleSink(sink)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              onClick={(event) =>
                                openEditSink(sink, event.currentTarget)
                              }
                            >
                              Edit
                            </Button>
                            <LazyConfirmAction
                              triggerLabel="Delete"
                              title="Delete sink?"
                              description="Delivery to this destination stops immediately and its cursor + dead-letter queue are removed."
                              confirmLabel="Delete"
                              confirmVariant="destructive"
                              confirmationToken="DELETE"
                              onConfirm={() => handleDeleteSink(sink)}
                              fallbackFocusRef={createSinkReturnFocusRef}
                            />
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {editingSink ? (
        <EditSinkDialog
          saving={saving}
          savingRef={savingRef}
          returnFocusRef={editSinkReturnFocusRef}
          form={editSinkForm}
          error={editSinkError}
          errorRef={editSinkErrorRef}
          unchanged={editSinkUnchanged}
          onFormChange={(next) => {
            setEditSinkError(null);
            setEditSinkForm(next);
          }}
          onSubmit={handleEditSink}
          onOpenChange={(open) => {
            if (!open && savingRef.current) return;
            if (!open) {
              setEditingSink(null);
              setEditSinkError(null);
            }
          }}
        />
      ) : null}

      {/* Export schedules --------------------------------------------------- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Scheduled exports</CardTitle>
            <CardDescription>
              Recurring signed CSV exports of the audit log, emailed to your
              compliance recipients.
            </CardDescription>
          </div>
          {canWrite ? (
            <>
              <Button
                ref={scheduleReturnFocusRef}
                type="button"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={createSchedOpen}
                onClick={(event) => {
                  scheduleReturnFocusRef.current = event.currentTarget;
                  setScheduleError(null);
                  setCreateSchedOpen(true);
                }}
              >
                Add schedule
              </Button>
              {createSchedOpen ? (
                <CreateScheduleDialog
                  saving={saving}
                  savingRef={savingRef}
                  returnFocusRef={scheduleReturnFocusRef}
                  cadence={schedCadence}
                  recipients={schedRecipients}
                  error={scheduleError}
                  errorRef={scheduleErrorRef}
                  onCadenceChange={(next) => {
                    setScheduleError(null);
                    setSchedCadence(next);
                  }}
                  onRecipientsChange={(next) => {
                    setScheduleError(null);
                    setSchedRecipients(next);
                  }}
                  onSubmit={handleCreateSchedule}
                  onOpenChange={(open) => {
                    if (!open && savingRef.current) return;
                    setCreateSchedOpen(open);
                    if (open) setScheduleError(null);
                    if (!open) {
                      setSchedRecipients("");
                      setSchedCadence("weekly");
                      setScheduleError(null);
                    }
                  }}
                />
              ) : null}
            </>
          ) : null}
        </CardHeader>
        <CardContent>
          {authorityQuery.isPending || schedulesLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : authorityQuery.isError ? (
            <EmptyState
              title="Audit authority unavailable"
              description="Export schedule inventory is withheld until the current audit scopes can be verified."
            />
          ) : !canReadSchedules ? (
            <EmptyState
              title="Raw audit read access required"
              description="Schedules include recipient addresses and require both audit:read and audit:read_pii."
            />
          ) : schedulesQuery.isError ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning-emphasis">
              <span>Couldn&apos;t load export schedules.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void schedulesQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : schedules.length === 0 ? (
            <EmptyState
              title="No scheduled exports"
              description="Add a schedule to email recurring audit-log exports to your team."
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cadence</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Created</TableHead>
                    {canWrite ? (
                      <TableHead className="text-right">Actions</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((sched) => (
                    <TableRow key={sched.id}>
                      <TableCell className="font-medium capitalize">
                        {sched.cadence}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {sched.recipients.join(", ")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {sched.last_enqueued_at ? (
                          <RelativeTime iso={sched.last_enqueued_at} />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime iso={sched.created_at} />
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-right">
                          <LazyConfirmAction
                            triggerLabel="Delete"
                            title="Delete schedule?"
                            description="This recurring export stops. Past exports are unaffected."
                            confirmLabel="Delete"
                            confirmVariant="destructive"
                            confirmationToken="DELETE"
                            onConfirm={() => handleDeleteSchedule(sched)}
                            fallbackFocusRef={scheduleReturnFocusRef}
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <AuditSinkRecoveryPanel
        tenantId={tenantId}
        userId={meQuery.data?.user_id ?? ""}
        role={role}
        identityReady={meQuery.isSuccess}
        viewerMode={meQuery.data?.viewer_mode === true}
      />
    </div>
  );
}

function DialogLoading({ label }: { label: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      Loading {label}…
    </span>
  );
}

function RecoveryPanelLoading() {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-64 max-w-full" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-20 w-full" />
        <span className="sr-only" role="status">
          Loading audit recovery controls…
        </span>
      </CardContent>
    </Card>
  );
}

function LazyConfirmAction({
  triggerLabel,
  title,
  description,
  confirmLabel,
  confirmVariant,
  confirmationToken,
  onConfirm,
  fallbackFocusRef,
}: {
  triggerLabel: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonProps["variant"];
  confirmationToken?: string;
  onConfirm: () => void | Promise<void>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        ref={returnFocusRef}
        variant="ghost"
        size="sm"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>
      {open ? (
        <DeferredConfirmDialog
          open
          onOpenChange={setOpen}
          returnFocusRef={returnFocusRef}
          fallbackFocusRef={fallbackFocusRef}
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          confirmVariant={confirmVariant}
          confirmationToken={confirmationToken}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}

function sinkInventoryFingerprint(sink: AuditSink): string {
  return compactFingerprint(
    JSON.stringify([
      sink.id,
      sink.kind,
      sink.name,
      sink.enabled,
      sink.config,
      sink.output_format,
      sink.webhook_format,
      sink.consecutive_failures,
      sink.auto_disable_after,
      sink.circuit_state,
      sink.cooldown_until ?? "",
      sink.last_success_at ?? "",
      sink.last_failure_at ?? "",
      sink.has_last_error,
    ]),
  );
}

function scheduleInventoryFingerprint(schedule: AuditExportSchedule): string {
  return compactFingerprint(
    JSON.stringify([
      schedule.id,
      schedule.cadence,
      schedule.recipients,
      schedule.enabled,
      schedule.last_enqueued_at ?? "",
      schedule.created_at,
    ]),
  );
}

function sinkDraftFingerprint(form: SinkFormValue): string {
  return compactFingerprint(
    JSON.stringify([
      form.kind,
      form.name,
      form.config,
      form.credentials,
      form.outputFormat,
      form.webhookFormat,
    ]),
  );
}

function compactFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${value.length}:${first.toString(16)}:${second.toString(16)}`;
}
