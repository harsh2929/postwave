// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  EngagementEmpty,
  EngagementLoading,
  EngagementQueryError,
} from "@/app/(dashboard)/app/_engagement/engagement-ui";
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
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  GOAL_METRICS,
  GOAL_PERIODS,
  createWorkspaceGoal,
  deleteWorkspaceGoal,
  getGoalProgress,
  goalDateTimeLocal,
  goalDraftError,
  goalTargetInput,
  listAllGoalDefinitions,
  newGoalDraft,
  normalizeGoalDraft,
  sameGoalConfiguration,
  sameGoalRevision,
  updateWorkspaceGoal,
  type GoalDraft,
  type GoalMetric,
  type GoalPace,
  type GoalProgressSnapshot,
  type WorkspaceGoal,
  type WorkspaceGoalProgress,
} from "@/lib/goals-admin-api";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

type EditorState = {
  mode: "create" | "edit";
  baseline: WorkspaceGoal | null;
  initial: GoalDraft;
  draft: GoalDraft;
};

type Feedback = {
  tone: "success" | "warning" | "error";
  title: string;
  detail: string;
};

const METRIC_LABELS: Record<GoalMetric, string> = {
  subscribers: "Enabled subscribers",
  open_rate: "Open rate",
  revenue_cents: "Attributed revenue",
  list_growth: "New subscribers",
};

function goalDraft(goal: WorkspaceGoal): GoalDraft {
  return {
    name: goal.name,
    metric: goal.metric,
    target: goalTargetInput(goal),
    period: goal.period,
    startsAt: goalDateTimeLocal(goal.startsAt),
  };
}

function draftEqual(left: GoalDraft, right: GoalDraft): boolean {
  return (
    left.name === right.name &&
    left.metric === right.metric &&
    left.target === right.target &&
    left.period === right.period &&
    left.startsAt === right.startsAt
  );
}

function displayGoalName(goal: WorkspaceGoal): string {
  return goal.name || METRIC_LABELS[goal.metric];
}

function formatGoalValue(metric: GoalMetric, value: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  if (metric === "open_rate") return `${value.toFixed(1)}%`;
  if (metric === "revenue_cents") {
    return `${(value / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} currency units`;
  }
  return Math.round(value).toLocaleString();
}

function formatPeriod(start: string, end: string): string {
  const first = new Date(start);
  const last = new Date(end);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) {
    return "Period unavailable";
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  };
  return `${first.toLocaleDateString(undefined, options)} – ${last.toLocaleDateString(undefined, options)}`;
}

function paceBadge(pace: GoalPace): {
  label: string;
  variant: "success" | "warning" | "outline";
} {
  if (pace === "ahead") return { label: "Ahead", variant: "success" };
  if (pace === "behind") return { label: "Behind", variant: "warning" };
  return { label: "On track", variant: "outline" };
}

export function GoalsManager({ identity }: { identity: MeResponse }) {
  const queryClient = useQueryClient();
  const role = effectiveAuthRole(identity);
  const canAdmin = roleCanWrite(role) && identity.viewer_mode !== true;
  const queryKey = useMemo(
    () => ["workspace-goal-progress", identity.tenant_id, role] as const,
    [identity.tenant_id, role],
  );
  const progressQuery = useQuery({
    queryKey,
    queryFn: () => getGoalProgress(identity.tenant_id),
    staleTime: STALE.dashboard,
    retry: false,
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceGoal | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const operationRef = useRef<Promise<void> | null>(null);
  const operationControllerRef = useRef<AbortController | null>(null);
  const editorDirty = Boolean(
    editor && !draftEqual(editor.initial, editor.draft),
  );
  useUnsavedChangesGuard(editorDirty || pending);

  const rows = Array.isArray(progressQuery.data?.progress)
    ? progressQuery.data.progress
    : [];

  async function freshProgress(
    signal: AbortSignal,
  ): Promise<GoalProgressSnapshot> {
    const snapshot = await getGoalProgress(identity.tenant_id, {
      fresh: true,
      signal,
    });
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, snapshot);
    return snapshot;
  }

  function runExclusive(
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (operationRef.current) return operationRef.current;
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setPending(true);
    const request = task(controller.signal).finally(() => {
      if (operationRef.current === request) operationRef.current = null;
      if (operationControllerRef.current === controller) {
        operationControllerRef.current = null;
      }
      setPending(false);
    });
    operationRef.current = request;
    return request;
  }

  function openCreate() {
    const draft = newGoalDraft();
    setEditor({ mode: "create", baseline: null, initial: draft, draft });
    setReviewed(false);
    setEditorError(null);
  }

  function openEdit(goal: WorkspaceGoal) {
    const draft = goalDraft(goal);
    setEditor({ mode: "edit", baseline: goal, initial: draft, draft });
    setReviewed(false);
    setEditorError(null);
  }

  function requestEditorClose() {
    if (pending) return;
    if (editorDirty) setDiscardOpen(true);
    else setEditor(null);
  }

  async function saveEditor() {
    if (!editor || !canAdmin || pending) return;
    const validation = goalDraftError(editor.draft);
    if (validation) {
      setEditorError(validation);
      return;
    }
    if (!reviewed) {
      setEditorError(
        "Confirm that you reviewed the target, period, and pacing anchor.",
      );
      return;
    }
    setEditorError(null);
    await runExclusive(async (signal) => {
      let writeConfirmed = false;
      try {
        const freshIdentity = await verifyFreshAdminAuthority(identity, signal);
        let receipt: WorkspaceGoal;
        if (editor.mode === "create") {
          receipt = await createWorkspaceGoal(editor.draft, signal);
        } else {
          const baseline = editor.baseline;
          if (!baseline) throw new Error("The goal baseline is unavailable.");
          const definitions = await listAllGoalDefinitions(
            freshIdentity.tenant_id,
            { fresh: true, signal },
          );
          const current = definitions.find((goal) => goal.id === baseline.id);
          if (!current)
            throw new Error(
              "This goal no longer exists. Reload before continuing.",
            );
          if (!sameGoalRevision(current, baseline)) {
            throw new Error(
              "This goal changed after you opened it. Nothing was overwritten; reload and review the newer revision.",
            );
          }
          receipt = await updateWorkspaceGoal(current, editor.draft, signal);
        }
        writeConfirmed = true;
        const readback = await listAllGoalDefinitions(freshIdentity.tenant_id, {
          fresh: true,
          signal,
        });
        const confirmed = readback.find((goal) => goal.id === receipt.id);
        const expected = normalizeGoalDraft(editor.draft);
        if (
          !confirmed ||
          !sameGoalRevision(receipt, confirmed) ||
          !sameGoalConfiguration(confirmed, expected)
        ) {
          throw new Error(
            "The server write receipt could not be matched to a fresh goal readback.",
          );
        }
        setEditor(null);
        setReviewed(false);
        try {
          await freshProgress(signal);
          setFeedback({
            tone: "success",
            title:
              editor.mode === "create"
                ? "Goal created and confirmed"
                : "Goal updated and confirmed",
            detail:
              "The saved definition and server-computed progress were read back from this workspace.",
          });
        } catch {
          await queryClient.invalidateQueries({ queryKey });
          setFeedback({
            tone: "warning",
            title: "Goal saved; progress refresh needs attention",
            detail:
              "The definition write and exact definition readback succeeded, but live aggregate progress could not be refreshed. Do not resubmit the write; use Refresh progress.",
          });
        }
      } catch (caught) {
        const message =
          caught instanceof Error
            ? caught.message
            : "The goal could not be saved.";
        if (writeConfirmed) {
          setEditor(null);
          setFeedback({
            tone: "warning",
            title:
              "Goal write returned a receipt, but verification was incomplete",
            detail: `${message} Do not resubmit blindly; refresh progress and inspect the current definition first.`,
          });
        } else {
          setEditorError(message);
        }
      }
    });
  }

  async function removeGoal() {
    const target = deleteTarget;
    if (!target || !canAdmin) return;
    await runExclusive(async (signal) => {
      const freshIdentity = await verifyFreshAdminAuthority(identity, signal);
      const definitions = await listAllGoalDefinitions(
        freshIdentity.tenant_id,
        {
          fresh: true,
          signal,
        },
      );
      const current = definitions.find((goal) => goal.id === target.id);
      if (!current)
        throw new Error("This goal was already removed. Refresh progress.");
      if (!sameGoalRevision(current, target)) {
        throw new Error(
          "This goal changed after the delete dialog opened. Nothing was removed; reload and review the newer revision.",
        );
      }
      await deleteWorkspaceGoal(current, signal);
      const readback = await listAllGoalDefinitions(freshIdentity.tenant_id, {
        fresh: true,
        signal,
      });
      if (readback.some((goal) => goal.id === target.id)) {
        setFeedback({
          tone: "warning",
          title: "Deletion receipt conflicts with readback",
          detail:
            "The server returned a deletion receipt but the goal remained visible in a fresh definition scan. Do not retry until the workspace is refreshed.",
        });
        return;
      }
      try {
        await freshProgress(signal);
        setFeedback({
          tone: "success",
          title: "Goal deleted and confirmed",
          detail:
            "The exact reviewed revision is absent from both the definition registry and refreshed progress.",
        });
      } catch {
        await queryClient.invalidateQueries({ queryKey });
        setFeedback({
          tone: "warning",
          title: "Goal deleted; progress refresh needs attention",
          detail:
            "Deletion and definition readback succeeded. Live progress could not be refreshed, so use Refresh progress before relying on the remaining cards.",
        });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted-foreground">
          {progressQuery.data
            ? `Live aggregate snapshot · ${new Date(progressQuery.data.asOf).toLocaleString()}`
            : "Waiting for a confirmed live aggregate snapshot"}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={progressQuery.isFetching}
            disabled={pending}
            onClick={() => void progressQuery.refetch()}
          >
            <RefreshCw aria-hidden /> Refresh progress
          </Button>
          {canAdmin ? (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={openCreate}
            >
              <Plus aria-hidden /> New goal
            </Button>
          ) : null}
        </div>
      </div>

      {!canAdmin ? (
        <Alert>
          <AlertTitle>Goal management is read only</AlertTitle>
          <AlertDescription>
            Your effective {role} role can inspect live pacing. An owner or
            admin must create, edit, or delete goals; viewer mode also keeps
            these controls locked.
          </AlertDescription>
        </Alert>
      ) : null}

      {feedback ? (
        <Alert variant={feedback.tone === "error" ? "destructive" : "default"}>
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.detail}</AlertDescription>
        </Alert>
      ) : null}

      {progressQuery.isPending ? (
        <EngagementLoading label="Loading goal progress" rows={3} />
      ) : progressQuery.isError ? (
        <EngagementQueryError
          title="Goal progress could not be loaded"
          description="No target is being presented as on track without a validated server progress snapshot."
          retrying={progressQuery.isFetching}
          onRetry={() => void progressQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EngagementEmpty
          title="No goals set"
          description={
            canAdmin
              ? "Create a bounded monthly or quarterly target to start server-computed pacing."
              : "An owner or admin can create the first workspace goal."
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Workspace goal progress">
          {rows.map((row) => (
            <GoalProgressRow
              key={row.goal.id}
              row={row}
              canAdmin={canAdmin}
              disabled={pending}
              onEdit={() => openEdit(row.goal)}
              onDelete={() => setDeleteTarget(row.goal)}
            />
          ))}
        </ul>
      )}

      <GoalEditorDialog
        editor={editor}
        pending={pending}
        reviewed={reviewed}
        error={editorError}
        onReviewedChange={setReviewed}
        onDraftChange={(draft) => {
          setEditor((current) => (current ? { ...current, draft } : current));
          setReviewed(false);
          setEditorError(null);
        }}
        onClose={requestEditorClose}
        onSave={() => void saveEditor()}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard unsaved goal changes?"
        description="The local goal draft will be cleared. No server definition has been changed by closing this editor."
        confirmLabel="Discard draft"
        confirmationToken="DISCARD DRAFT"
        onConfirm={() => {
          setEditor(null);
          setReviewed(false);
          setEditorError(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this goal?"
        description={
          deleteTarget
            ? `“${displayGoalName(deleteTarget)}” will be removed. Historical source data is not deleted, but this pacing definition cannot be restored.`
            : "The selected goal will be removed."
        }
        confirmLabel="Delete goal"
        confirmationToken="DELETE GOAL"
        onConfirm={removeGoal}
      />
    </div>
  );
}

function GoalProgressRow({
  row,
  canAdmin,
  disabled,
  onEdit,
  onDelete,
}: {
  row: WorkspaceGoalProgress;
  canAdmin: boolean;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const pace = paceBadge(row.pace);
  const percent = Math.max(0, row.pct * 100);
  return (
    <li className="rounded-xl border bg-background/60 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold">
              {displayGoalName(row.goal)}
            </h3>
            <Badge variant={pace.variant}>{pace.label}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {METRIC_LABELS[row.goal.metric]} · {row.goal.period} ·{" "}
            {formatPeriod(row.periodStart, row.periodEnd)}
          </p>
        </div>
        {canAdmin ? (
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={onEdit}
            >
              <Pencil aria-hidden /> Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={onDelete}
            >
              <Trash2 aria-hidden /> Delete
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex items-end justify-between gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Current </span>
          <strong>{formatGoalValue(row.goal.metric, row.current)}</strong>
        </div>
        <div className="text-right">
          <span className="text-muted-foreground">Target </span>
          <strong>{formatGoalValue(row.goal.metric, row.target)}</strong>
        </div>
      </div>
      <Progress
        className="mt-2"
        value={percent}
        aria-label={`${displayGoalName(row.goal)} progress: ${Math.round(percent)} percent`}
      />
      <p className="mt-2 text-right text-xs tabular-nums text-muted-foreground">
        {Math.round(percent).toLocaleString()}% complete
      </p>
      {row.goal.metric === "revenue_cents" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The API reports minor currency units but does not return a currency
          code. Values therefore use “currency units”; no USD label is inferred.
        </p>
      ) : null}
    </li>
  );
}

function GoalEditorDialog({
  editor,
  pending,
  reviewed,
  error,
  onReviewedChange,
  onDraftChange,
  onClose,
  onSave,
}: {
  editor: EditorState | null;
  pending: boolean;
  reviewed: boolean;
  error: string | null;
  onReviewedChange: (value: boolean) => void;
  onDraftChange: (draft: GoalDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!editor) return null;
  const { draft } = editor;
  const validation = goalDraftError(draft);
  const metricHint =
    draft.metric === "revenue_cents"
      ? "Enter major currency units; the API stores whole minor units."
      : draft.metric === "open_rate"
        ? "Enter percentage points, for example 45 for 45%."
        : "Enter a whole subscriber count.";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeDisabled={pending} aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>
            {editor.mode === "create"
              ? "New workspace goal"
              : "Edit workspace goal"}
          </DialogTitle>
          <DialogDescription>
            The server computes current value and pacing from live workspace
            aggregates. Metric is immutable after creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={draft.name}
              maxLength={120}
              disabled={pending}
              placeholder={METRIC_LABELS[draft.metric]}
              onChange={(event) =>
                onDraftChange({ ...draft, name: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Optional · 120 UTF-8 bytes maximum.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-metric">Metric</Label>
            <Select
              id="goal-metric"
              value={draft.metric}
              disabled={pending || editor.mode === "edit"}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  metric: event.target.value as GoalMetric,
                  target: "",
                })
              }
            >
              {GOAL_METRICS.map((metric) => (
                <option key={metric} value={metric}>
                  {METRIC_LABELS[metric]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-target">Target</Label>
            <Input
              id="goal-target"
              inputMode="decimal"
              value={draft.target}
              disabled={pending}
              placeholder={draft.metric === "open_rate" ? "45" : "1000"}
              onChange={(event) =>
                onDraftChange({ ...draft, target: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">{metricHint}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="goal-period">Period</Label>
              <Select
                id="goal-period"
                value={draft.period}
                disabled={pending}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    period: event.target.value as GoalDraft["period"],
                  })
                }
              >
                {GOAL_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {period === "monthly" ? "Monthly" : "Quarterly"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="goal-starts-at">Pacing anchor</Label>
              <Input
                id="goal-starts-at"
                type="datetime-local"
                value={draft.startsAt}
                disabled={pending}
                onChange={(event) =>
                  onDraftChange({ ...draft, startsAt: event.target.value })
                }
              />
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
            <Checkbox
              id="goal-reviewed"
              checked={reviewed}
              disabled={pending || Boolean(validation)}
              onChange={(event) =>
                onReviewedChange(event.currentTarget.checked)
              }
            />
            <Label
              htmlFor="goal-reviewed"
              className="text-sm font-normal leading-5"
            >
              I reviewed the metric units, target, period, and pacing anchor for
              this workspace.
            </Label>
          </div>
          {error || validation ? (
            <Alert variant="destructive">
              <AlertTitle>Goal draft needs attention</AlertTitle>
              <AlertDescription>{error || validation}</AlertDescription>
            </Alert>
          ) : null}
          <Alert>
            <CalendarClock aria-hidden />
            <AlertTitle>Concurrency protected</AlertTitle>
            <AlertDescription>
              Existing goals are compared with a fresh definition and updated
              through an atomic expected_updated_at predicate. Every successful
              write is read back before this editor reports confirmation.
            </AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            loading={pending}
            disabled={pending || Boolean(validation) || !reviewed}
            onClick={onSave}
          >
            {editor.mode === "create" ? "Create goal" : "Save goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
