// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarClock, History, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  AGENT_ROUTINE_KINDS,
  AGENT_ROUTINE_SCHEDULES,
  createAgentRoutine,
  deleteAgentRoutine,
  getAgentRoutine,
  listAgentRoutineRuns,
  listAgentRoutines,
  routineDraftError,
  routineNextEligibility,
  runAgentRoutine,
  sameAgentRoutineConfiguration,
  sameAgentRoutineRevision,
  updateAgentRoutine,
  verifyFreshRoutineAuthority,
  type AgentRoutine,
  type AgentRoutineDraft,
  type AgentRoutineDraftPreview,
  type AgentRoutineRun,
} from "@/lib/agent-routines-api";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import { listSegments } from "@/lib/segments-api";
import { asRoute } from "@/lib/typed-routes";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const EMPTY_DRAFT: AgentRoutineDraft = {
  name: "",
  prompt: "",
  kind: "draft_campaign",
  schedule: "manual",
  targetSegmentId: "",
  requireApproval: true,
  enabled: true,
};

interface SegmentOption {
  id: string;
  name: string;
}

// The agent-call ledger sits below the routine list and carries the MCP
// telemetry client with it, so it loads after the routines render.
const RecentAgentActivity = dynamic(
  () =>
    import("@/components/mcp/recent-agent-activity").then(
      (module) => module.RecentAgentActivity,
    ),
  {
    loading: () => (
      <GovernanceLoading label="Loading recent agent activity…" rows={3} />
    ),
  },
);

function canWriteRoutines(identity: MeResponse): boolean {
  return (
    !identity.viewer_mode &&
    ["owner", "admin", "editor"].includes(effectiveAuthRole(identity))
  );
}

function decodeSegmentOptions(
  payload: Awaited<ReturnType<typeof listSegments>>,
  tenantId: string,
): SegmentOption[] {
  if (!Array.isArray(payload) || payload.length > 1_000) {
    throw new Error("The canonical segment catalog is malformed or too large.");
  }
  const seen = new Set<string>();
  return payload.map((segment, index) => {
    if (
      !segment ||
      typeof segment.id !== "string" ||
      !UUID_PATTERN.test(segment.id) ||
      segment.tenantId !== tenantId ||
      typeof segment.name !== "string" ||
      !segment.name.trim() ||
      Array.from(segment.name).length > 200 ||
      seen.has(segment.id)
    ) {
      throw new Error(
        `The canonical segment catalog contains an invalid row at position ${index + 1}.`,
      );
    }
    seen.add(segment.id);
    return { id: segment.id, name: segment.name };
  });
}

function routineDraft(routine: AgentRoutine): AgentRoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    kind: routine.kind,
    schedule: routine.schedule,
    targetSegmentId: routine.targetSegmentId ?? "",
    requireApproval: routine.requireApproval,
    enabled: routine.enabled,
    clearLegacyTargetList: Boolean(routine.legacyTargetListId),
  };
}

function routineStatusVariant(
  routine: AgentRoutine,
): "success" | "warning" | "outline" {
  if (routine.hasActiveRun) return "warning";
  if (routine.enabled) return "success";
  return "outline";
}

function scheduleLabel(schedule: AgentRoutine["schedule"]): string {
  return {
    manual: "Manual only",
    daily: "Every 24 hours",
    weekly: "Every 7 days",
    monthly: "Every 30 days",
  }[schedule];
}

function eligibilityLabel(routine: AgentRoutine): string {
  const eligibility = routineNextEligibility(routine);
  if (!routine.enabled) return "Automatic interval paused";
  if (routine.schedule === "manual") return "No automatic eligibility";
  if (eligibility === "eligible_now")
    return "Eligible now; a later scheduler scan may start it";
  if (eligibility)
    return `Eligible after ${formatWireTimestamp(eligibility, "an unknown time")}`;
  return "Eligibility unavailable";
}

function kindLabel(kind: AgentRoutine["kind"]): string {
  return kind === "draft_campaign" ? "Campaign draft" : "Sequence draft";
}

export function AgentRoutinesManager({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canWrite = canWriteRoutines(identity);
  const queryClient = useQueryClient();
  const routinesKey = [
    "agent-routines",
    identity.tenant_id,
    role,
    "list",
  ] as const;
  const routines = useQuery({
    queryKey: routinesKey,
    queryFn: ({ signal }) => listAgentRoutines({ signal }),
    staleTime: STALE.list,
    retry: false,
  });
  const segmentOptions = useQuery({
    queryKey: ["agent-routines", identity.tenant_id, role, "segments"],
    queryFn: async () =>
      decodeSegmentOptions(await listSegments(), identity.tenant_id),
    enabled: canWrite,
    staleTime: STALE.reference,
    retry: false,
  });
  const rows = Array.isArray(routines.data) ? routines.data : [];

  const [editing, setEditing] = useState<"new" | AgentRoutine | null>(null);
  const [draft, setDraft] = useState<AgentRoutineDraft>(EMPTY_DRAFT);
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRoutine | null>(null);
  const [runTarget, setRunTarget] = useState<AgentRoutine | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const operationRef = useRef(false);

  const baseline = editing === "new" ? null : editing;
  const dirty = Boolean(
    editing &&
    (baseline
      ? !sameAgentRoutineConfiguration(baseline, draft)
      : JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT)),
  );
  useUnsavedChangesGuard(dirty && !saving);
  const validation = editing ? routineDraftError(draft) : null;
  // operationRef serialises routine writes, and a single run walks six
  // sequential round trips, so one routine's operation greys out every other
  // routine's write controls for that whole window. Name the cause: a control
  // that disables with no reason reads as a frozen page.
  const writeBusyReason = saving
    ? "Another routine operation is still running. Wait for it to finish."
    : undefined;

  function routineWriteBusyReason(routine: AgentRoutine): string | undefined {
    return (
      writeBusyReason ??
      (routine.hasActiveRun
        ? "This routine already has a run in progress."
        : undefined)
    );
  }

  function openEditor(routine?: AgentRoutine): void {
    setEditing(routine ?? "new");
    setDraft(routine ? routineDraft(routine) : { ...EMPTY_DRAFT });
    setError(null);
    setSuccess(null);
  }

  function closeEditor(force = false): void {
    if (saving) return;
    if (
      dirty &&
      !force &&
      !window.confirm("Discard the unsaved routine changes?")
    ) {
      return;
    }
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT });
  }

  async function saveRoutine(): Promise<void> {
    if (!canWrite || !editing || validation || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    const controller = new AbortController();
    try {
      await verifyFreshRoutineAuthority(identity, controller.signal);
      let saved: AgentRoutine;
      if (baseline) {
        const current = await getAgentRoutine(baseline.id, {
          fresh: true,
          signal: controller.signal,
        });
        if (!sameAgentRoutineRevision(baseline, current)) {
          throw new Error(
            "This routine changed after the editor opened. Nothing was written; review the latest server state.",
          );
        }
        if (current.hasActiveRun) {
          throw new Error(
            "This routine is currently drafting. Wait for the run receipt to settle before editing it.",
          );
        }
        saved = await updateAgentRoutine(current, draft, controller.signal);
      } else {
        saved = await createAgentRoutine(draft, controller.signal);
      }
      const confirmed = await getAgentRoutine(saved.id, {
        fresh: true,
        signal: controller.signal,
      });
      if (
        !sameAgentRoutineRevision(saved, confirmed) ||
        !sameAgentRoutineConfiguration(confirmed, {
          ...draft,
          clearLegacyTargetList: false,
        }) ||
        (draft.clearLegacyTargetList && confirmed.legacyTargetListId)
      ) {
        throw new Error(
          "The routine write returned, but a fresh read did not confirm the requested configuration.",
        );
      }
      const after = await listAgentRoutines({
        fresh: true,
        signal: controller.signal,
      });
      const inList = after.find((candidate) => candidate.id === confirmed.id);
      if (!inList || !sameAgentRoutineRevision(confirmed, inList)) {
        throw new Error(
          "The routine detail was confirmed, but the canonical collection did not include the same revision.",
        );
      }
      queryClient.setQueryData(routinesKey, after);
      setEditing(null);
      setDraft({ ...EMPTY_DRAFT });
      setSuccess(
        baseline
          ? "Routine changes were saved and confirmed by a fresh server read."
          : "Routine was created and confirmed by a fresh server read.",
      );
      toast.success(baseline ? "Routine updated." : "Routine created.");
    } catch (caught) {
      setError(apiErrorMessage(caught, "Could not save the routine."));
      void routines.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function toggleRoutine(routine: AgentRoutine): Promise<void> {
    if (!canWrite || operationRef.current || routine.hasActiveRun) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshRoutineAuthority(identity);
      const current = await getAgentRoutine(routine.id, { fresh: true });
      if (!sameAgentRoutineRevision(routine, current)) {
        throw new Error(
          "This routine changed before the interval action. Nothing was written; review the latest state.",
        );
      }
      const nextDraft = {
        ...routineDraft(current),
        enabled: !current.enabled,
        // Pausing an interval must not silently migrate or clear legacy targeting.
        clearLegacyTargetList: false,
      };
      const receipt = await updateAgentRoutine(current, nextDraft);
      const confirmed = await getAgentRoutine(current.id, { fresh: true });
      if (
        !sameAgentRoutineRevision(receipt, confirmed) ||
        confirmed.enabled !== nextDraft.enabled
      ) {
        throw new Error(
          "The interval action returned, but a fresh read did not confirm it.",
        );
      }
      const after = await listAgentRoutines({ fresh: true });
      queryClient.setQueryData(routinesKey, after);
      setSuccess(
        confirmed.enabled
          ? "Automatic interval eligibility resumed and was confirmed."
          : "Automatic interval eligibility paused and was confirmed. Manual Run now remains available.",
      );
      toast.success(
        confirmed.enabled
          ? "Routine interval resumed."
          : "Routine interval paused.",
      );
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not change the routine interval."),
      );
      void routines.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function startRun(routine: AgentRoutine): Promise<void> {
    if (!canWrite || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshRoutineAuthority(identity);
      const current = await getAgentRoutine(routine.id, { fresh: true });
      if (!sameAgentRoutineRevision(routine, current)) {
        throw new Error(
          "This routine changed before Run now was confirmed. Nothing was started; review the latest state.",
        );
      }
      if (current.hasActiveRun) {
        throw new Error("This routine already has a run in progress.");
      }
      const receipt = await runAgentRoutine(current.id);
      const runs = await listAgentRoutineRuns(current.id, { fresh: true });
      const accepted = runs.find((candidate) => candidate.id === receipt.runId);
      if (!accepted) {
        throw new Error(
          "The server accepted the run, but its fresh run ledger did not confirm the receipt. Do not start another run; refresh the history first.",
        );
      }
      const refreshedRoutine = await getAgentRoutine(current.id, {
        fresh: true,
      });
      if (refreshedRoutine.hasActiveRun !== (accepted.status === "running")) {
        throw new Error(
          "The run ledger was created, but routine lock state did not match its current lifecycle. Refresh before taking another action.",
        );
      }
      const after = await listAgentRoutines({ fresh: true });
      queryClient.setQueryData(routinesKey, after);
      queryClient.setQueryData(
        ["agent-routine-runs", identity.tenant_id, current.id],
        runs,
      );
      setExpandedRuns(current.id);
      setRunTarget(null);
      setSuccess(
        `Run receipt ${receipt.runId} was confirmed with current status ${accepted.status}.`,
      );
      toast.success("Background draft started.");
    } catch (caught) {
      setError(apiErrorMessage(caught, "Could not start the routine."));
      void routines.refetch();
      throw caught;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function removeRoutine(routine: AgentRoutine): Promise<void> {
    if (!canWrite || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshRoutineAuthority(identity);
      const current = await getAgentRoutine(routine.id, { fresh: true });
      if (!sameAgentRoutineRevision(routine, current)) {
        throw new Error(
          "This routine changed after deletion was opened. Nothing was deleted; review the latest state.",
        );
      }
      if (current.hasActiveRun) {
        throw new Error(
          "This routine is currently drafting and cannot be deleted until its run settles.",
        );
      }
      await deleteAgentRoutine(current.id);
      const after = await listAgentRoutines({ fresh: true });
      if (after.some((candidate) => candidate.id === current.id)) {
        throw new Error("A fresh read did not confirm routine deletion.");
      }
      queryClient.setQueryData(routinesKey, after);
      setDeleteTarget(null);
      setSuccess(
        "Routine and its run ledger were deleted. Drafts and approvals it already created remain unchanged.",
      );
      toast.success("Routine deleted.");
    } catch (caught) {
      setError(apiErrorMessage(caught, "Could not delete the routine."));
      void routines.refetch();
      throw caught;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <GovernancePageHeader
        icon={Bot}
        eyebrow="Agent governance"
        title="Agent routines"
        description="Store bounded standing briefs that create inert campaign or sequence drafts—never queued or sent messages."
        refreshLabel="Refresh routines"
        refreshing={routines.isFetching}
        onRefresh={() => void routines.refetch()}
      />

      {canWrite ? (
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={saving}
            title={writeBusyReason}
            onClick={() => openEditor()}
          >
            <Plus className="size-4" aria-hidden />
            New routine
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Alert role="note">
          <AlertTitle>Draft-only boundary</AlertTitle>
          <AlertDescription>
            A run can create a draft and optionally an approval request. It has
            no send, queue, publish, or deployment authority.
          </AlertDescription>
        </Alert>
        <Alert role="note">
          <AlertTitle>Elapsed intervals, not calendar schedules</AlertTitle>
          <AlertDescription>
            Daily, weekly, and monthly mean 24 hours, 7 days, and 30 days after
            the last run began. Scheduler scans may start eligible work later.
          </AlertDescription>
        </Alert>
      </div>

      {!canWrite ? (
        <Alert>
          <AlertTitle>Read-only routine evidence</AlertTitle>
          <AlertDescription>
            Viewers may inspect instructions, run receipts, reasoning, and draft
            snapshots. Owner, admin, or editor access is required to create,
            edit, pause, run, or delete a routine.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Routine operation not confirmed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-success-emphasis">
          {success}
        </p>
      ) : null}

      <GovernanceSection
        icon={CalendarClock}
        title="Standing draft instructions"
        description="No ETag is exposed for this resource. Writes use a fresh exact preflight and post-write readback, while the server remains the concurrency authority."
      >
        {routines.isPending ? (
          <GovernanceLoading label="Loading agent routines…" rows={4} />
        ) : routines.isError ? (
          <GovernanceError
            message={apiErrorMessage(
              routines.error,
              "Could not verify agent routines. This failed request has not been presented as an empty schedule.",
            )}
            retrying={routines.isFetching}
            onRetry={() => void routines.refetch()}
          />
        ) : rows.length === 0 ? (
          <GovernanceEmpty>No routines are configured.</GovernanceEmpty>
        ) : (
          <ul className="space-y-3">
            {rows.map((routine) => (
              <li key={routine.id} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words font-medium">
                        {routine.name}
                      </h3>
                      <Badge variant={routineStatusVariant(routine)}>
                        {routine.hasActiveRun
                          ? "Drafting"
                          : routine.enabled
                            ? "Enabled"
                            : "Paused"}
                      </Badge>
                      <Badge variant="outline">{kindLabel(routine.kind)}</Badge>
                    </div>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {routine.id}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {/* Purely local expand/collapse — it issues no write, so
                        it stays usable while another routine's operation is in
                        flight. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={expandedRuns === routine.id}
                      onClick={() =>
                        setExpandedRuns((current) =>
                          current === routine.id ? null : routine.id,
                        )
                      }
                    >
                      <History className="size-4" aria-hidden />
                      {expandedRuns === routine.id
                        ? "Hide run history"
                        : "Run history"}
                    </Button>
                    {canWrite ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={saving || routine.hasActiveRun}
                          title={routineWriteBusyReason(routine)}
                          onClick={() => openEditor(routine)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={saving || routine.hasActiveRun}
                          title={routineWriteBusyReason(routine)}
                          onClick={() => void toggleRoutine(routine)}
                        >
                          {routine.enabled
                            ? "Pause interval"
                            : "Resume interval"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving || routine.hasActiveRun}
                          title={routineWriteBusyReason(routine)}
                          onClick={() => setRunTarget(routine)}
                        >
                          Run now
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={saving || routine.hasActiveRun}
                          title={routineWriteBusyReason(routine)}
                          onClick={() => setDeleteTarget(routine)}
                        >
                          Delete
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Interval</dt>
                    <dd>{scheduleLabel(routine.schedule)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Eligibility
                    </dt>
                    <dd>{eligibilityLabel(routine)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Audience hint
                    </dt>
                    <dd className="break-all">
                      {routine.targetSegmentId ?? "No segment preselected"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Approval request
                    </dt>
                    <dd>
                      {routine.requireApproval ? "Required" : "Not created"}
                    </dd>
                  </div>
                </dl>

                {routine.legacyTargetListId ? (
                  <Alert variant="warning" className="mt-4">
                    <AlertTitle>Inert legacy list value present</AlertTitle>
                    <AlertDescription>
                      {routine.legacyTargetListId} is retained only for cleanup.
                      Runtime never resolves or targets it. Editing this routine
                      offers an explicit clear operation.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <details className="mt-4 rounded-lg bg-muted/30 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Review standing brief
                  </summary>
                  <p
                    className="mt-2 whitespace-pre-wrap break-words text-sm"
                    dir="auto"
                  >
                    {routine.prompt}
                  </p>
                </details>

                {expandedRuns === routine.id ? (
                  <RoutineRunHistory identity={identity} routine={routine} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </GovernanceSection>

      {/* A routine's own run ledger says what Moosewave started. This says what
          the agent actually CALLED, which is a different question and the one
          an operator asks when a routine misbehaves. */}
      <RecentAgentActivity identity={identity} />

      <RoutineEditorDialog
        open={editing !== null}
        baseline={baseline}
        draft={draft}
        setDraft={setDraft}
        segments={Array.isArray(segmentOptions.data) ? segmentOptions.data : []}
        segmentsLoading={segmentOptions.isPending}
        segmentsError={segmentOptions.isError}
        dirty={dirty}
        validation={validation}
        saving={saving}
        onClose={() => closeEditor()}
        onSave={() => void saveRoutine()}
      />

      <ConfirmDialog
        open={runTarget !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setRunTarget(null);
        }}
        title="Start one background draft?"
        description={
          runTarget ? (
            <span>
              Start “{runTarget.name}” once now. This spends AI quota and
              creates only a {kindLabel(runTarget.kind).toLowerCase()}. It does
              not send anything.{" "}
              {runTarget.requireApproval
                ? "A successful run also opens an approval request."
                : "No approval request will be opened for this routine."}
            </span>
          ) : null
        }
        confirmLabel="Start background draft"
        confirmVariant="default"
        onConfirm={() => (runTarget ? startRun(runTarget) : undefined)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDeleteTarget(null);
        }}
        title="Delete routine and run ledger?"
        description={
          deleteTarget ? (
            <span>
              Delete “{deleteTarget.name}” and its run history. Existing drafts
              and approval requests remain. Type the exact routine name to
              confirm.
            </span>
          ) : null
        }
        confirmationToken={deleteTarget?.name}
        confirmLabel="Delete routine"
        onConfirm={() =>
          deleteTarget ? removeRoutine(deleteTarget) : undefined
        }
      />
    </>
  );
}

function RoutineEditorDialog({
  open,
  baseline,
  draft,
  setDraft,
  segments,
  segmentsLoading,
  segmentsError,
  dirty,
  validation,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  baseline: AgentRoutine | null;
  draft: AgentRoutineDraft;
  setDraft: (draft: AgentRoutineDraft) => void;
  segments: SegmentOption[];
  segmentsLoading: boolean;
  segmentsError: boolean;
  dirty: boolean;
  validation: string | null;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const selectedUnavailable = Boolean(
    draft.targetSegmentId &&
    !segments.some((segment) => segment.id === draft.targetSegmentId),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent closeDisabled={saving} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {baseline ? "Edit agent routine" : "New agent routine"}
          </DialogTitle>
          <DialogDescription>
            Store a bounded brief for draft generation. The draft kind is
            immutable after creation; interval timing is elapsed, not a local
            calendar appointment.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="routine-name">Name</Label>
            <Input
              id="routine-name"
              value={draft.name}
              maxLength={200}
              disabled={saving}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="routine-brief">Standing brief</Label>
            <Textarea
              id="routine-brief"
              value={draft.prompt}
              maxLength={8_000}
              rows={8}
              dir="auto"
              disabled={saving}
              onChange={(event) =>
                setDraft({ ...draft, prompt: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              {Array.from(draft.prompt).length.toLocaleString()} / 8,000
              characters
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="routine-kind">Draft kind</Label>
              <Select
                id="routine-kind"
                value={draft.kind}
                disabled={saving || Boolean(baseline)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    kind: event.target.value as AgentRoutineDraft["kind"],
                  })
                }
              >
                {AGENT_ROUTINE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(kind)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-schedule">Automatic interval</Label>
              <Select
                id="routine-schedule"
                value={draft.schedule}
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: event.target
                      .value as AgentRoutineDraft["schedule"],
                  })
                }
              >
                {AGENT_ROUTINE_SCHEDULES.map((schedule) => (
                  <option key={schedule} value={schedule}>
                    {scheduleLabel(schedule)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="routine-segment">Canonical segment hint</Label>
            <Select
              id="routine-segment"
              value={draft.targetSegmentId}
              disabled={saving || segmentsLoading}
              onChange={(event) =>
                setDraft({ ...draft, targetSegmentId: event.target.value })
              }
            >
              <option value="">No segment preselected</option>
              {selectedUnavailable ? (
                <option value={draft.targetSegmentId}>
                  Current unavailable segment ({draft.targetSegmentId})
                </option>
              ) : null}
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              This is an advisory draft audience hint. A human still confirms
              the audience before any later send workflow.
            </p>
            {segmentsError ? (
              <p role="alert" className="text-sm text-destructive">
                The canonical segment catalog could not be verified. The current
                target may be preserved or cleared, but another target cannot be
                selected from this view.
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={draft.requireApproval}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...draft, requireApproval: event.target.checked })
                }
              />
              <span>
                Open an approval request after a successful draft. Turning this
                off still does not send the draft.
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={draft.enabled}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              <span>
                Enable automatic interval eligibility. Manual Run now remains
                possible while paused.
              </span>
            </label>
          </div>
          {baseline?.legacyTargetListId ? (
            <label className="flex items-start gap-3 rounded-lg border border-warning/40 p-3 text-sm">
              <Checkbox
                checked={draft.clearLegacyTargetList === true}
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    clearLegacyTargetList: event.target.checked,
                  })
                }
              />
              <span>
                Clear inert legacy list value {baseline.legacyTargetListId}. It
                has never been a runtime target.
              </span>
            </label>
          ) : null}
          {validation ? (
            <p role="alert" className="text-sm text-destructive">
              {validation}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onClose}
            >
              {dirty ? "Discard changes" : "Cancel"}
            </Button>
            <Button
              type="submit"
              disabled={Boolean(validation) || saving}
              loading={saving}
            >
              {baseline ? "Save routine" : "Create routine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoutineRunHistory({
  identity,
  routine,
}: {
  identity: MeResponse;
  routine: AgentRoutine;
}) {
  const runs = useQuery({
    queryKey: ["agent-routine-runs", identity.tenant_id, routine.id],
    queryFn: ({ signal }) => listAgentRoutineRuns(routine.id, { signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "running") ? 4_000 : false,
  });
  return (
    <section
      className="mt-4 border-t pt-4"
      aria-label={`Run history for ${routine.name}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium">Run receipts</h4>
          <p className="text-xs text-muted-foreground">
            Active receipts refresh every four seconds while this history is
            open.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={runs.isFetching}
          onClick={() => void runs.refetch()}
        >
          {runs.isFetching ? "Refreshing…" : "Refresh runs"}
        </Button>
      </div>
      {runs.isPending ? (
        <GovernanceLoading label="Loading routine run receipts…" rows={2} />
      ) : runs.isError ? (
        <GovernanceError
          message={apiErrorMessage(
            runs.error,
            "Could not verify the routine run ledger.",
          )}
          retrying={runs.isFetching}
          onRetry={() => void runs.refetch()}
        />
      ) : !runs.data?.length ? (
        <GovernanceEmpty>No runs have been recorded.</GovernanceEmpty>
      ) : (
        <ul className="space-y-3">
          {runs.data.map((run) => (
            <RoutineRunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RoutineRunRow({ run }: { run: AgentRoutineRun }) {
  const outputHref =
    run.outputKind === "campaign" && run.outputRef
      ? `/app/campaigns/${encodeURIComponent(run.outputRef)}`
      : run.outputKind === "sequence" && run.outputRef
        ? `/app/sequences/${encodeURIComponent(run.outputRef)}`
        : null;
  const variant =
    run.status === "succeeded"
      ? "success"
      : run.status === "running"
        ? "warning"
        : "destructive";
  return (
    <li className="rounded-lg bg-muted/25 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Badge variant={variant}>{run.status}</Badge>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {run.id}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatWireTimestamp(
            run.finishedAt ?? run.startedAt,
            "Date unavailable",
          )}
        </p>
      </div>
      {run.error ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="break-words" dir="auto">
            {run.error}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {outputHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={asRoute(outputHref)}>Open inert draft</Link>
          </Button>
        ) : null}
        {run.approvalId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/app/approvals/${encodeURIComponent(run.approvalId)}`}>
              Open approval
            </Link>
          </Button>
        ) : null}
      </div>
      {run.promptUsed ||
      run.contextUsed ||
      run.reasoning ||
      run.draftPreview ? (
        <details className="mt-3 rounded-lg border bg-background p-3">
          <summary className="cursor-pointer font-medium">
            Why and draft snapshot
          </summary>
          <div className="mt-3 space-y-3">
            {run.promptUsed ? (
              <ForensicText title="Prompt used" text={run.promptUsed} />
            ) : null}
            {run.contextUsed ? (
              <ForensicText title="Context used" text={run.contextUsed} />
            ) : null}
            {run.reasoning ? (
              <ForensicText title="Model rationale" text={run.reasoning} />
            ) : null}
            {run.draftPreview ? (
              <DraftPreview preview={run.draftPreview} />
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

function ForensicText({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h5 className="text-xs font-medium uppercase text-muted-foreground">
        {title}
      </h5>
      <pre
        className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-sm"
        dir="auto"
        tabIndex={0}
      >
        {text}
      </pre>
    </div>
  );
}

function DraftPreview({ preview }: { preview: AgentRoutineDraftPreview }) {
  if (preview.kind === "campaign") {
    return (
      <div className="space-y-2">
        <h5 className="text-xs font-medium uppercase text-muted-foreground">
          Immutable campaign snapshot
        </h5>
        <p>
          <strong>Name:</strong> {preview.name || "Not recorded"}
        </p>
        <p>
          <strong>Subject:</strong> {preview.subject || "Not recorded"}
        </p>
        {preview.previewText ? (
          <p>
            <strong>Preview:</strong> {preview.previewText}
          </p>
        ) : null}
        <ForensicText title="Body snapshot" text={preview.body} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-medium uppercase text-muted-foreground">
        Immutable sequence snapshot
      </h5>
      <p>
        <strong>Name:</strong> {preview.name || "Not recorded"}
      </p>
      <ol className="space-y-2">
        {preview.steps.map((step) => (
          <li key={step.position} className="rounded-md border p-3">
            <p className="font-medium">
              Step {step.position} · {step.delayHours} hour delay
            </p>
            <p className="mt-1">{step.subject || "No subject recorded"}</p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">
                Review body snapshot
              </summary>
              <ForensicText title="Body" text={step.body} />
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
