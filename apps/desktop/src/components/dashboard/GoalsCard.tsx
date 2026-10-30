/**
 * GoalsCard — "Goals & pacing" (goalsApi, R9).
 *
 * One GET /goals/progress drives the whole card: each row carries the
 * goal plus its live progress (current / target / pct / pace / period
 * window), so we never join two lists client-side. After any mutation
 * we refetch progress rather than patching state — the server computes
 * pct/pace and we don't want a client-side approximation drifting.
 *
 * Mutations (create / edit / delete) are admin-gated via useCanAdmin —
 * the same role gate the server enforces. Viewers/editors see the
 * goals read-only with honest copy about who can change them.
 *
 * Unit handling lives in goals-helpers.ts (pure, tested): revenue is
 * typed in dollars and stored in cents; open_rate is PERCENT units
 * end-to-end (the server's query multiplies by 100).
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type TenantGoal,
  type TenantGoalMetric,
  type TenantGoalPeriod,
  type TenantGoalProgress,
  goalsApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

import {
  GOAL_METRICS,
  goalDisplayName,
  goalMetricLabel,
  goalTargetToInput,
  parseGoalTargetInput,
} from "./goals-helpers";
import { GoalProgressView } from "./GoalProgressView";
import "./dashboard-insight-cards.css";

type GoalsLoadFailure = "initial" | "refresh" | null;

const GOAL_DELETE_ERROR =
  "Goal couldn't be deleted. Check your access and connection, then try again.";
const GOAL_SAVE_ERROR =
  "Goal couldn't be saved. Review the form, then check your access and connection before retrying.";

function validSourceTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

export function GoalsCard(): ReactElement {
  const canAdmin = useCanAdmin();
  const [rows, setRows] = useState<TenantGoalProgress[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<GoalsLoadFailure>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<TenantGoal | "new" | null>(null);
  const [deleting, setDeleting] = useState<TenantGoal | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const deleteOperation = useSingleFlightOperation({
    ownerId: "goal-delete",
    label: "Goal deletion",
  });

  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<void> => {
      const requestId = ++loadRequestRef.current;
      const retainAcknowledged = mode === "refresh";
      setLoadFailure(null);
      setRefreshing(retainAcknowledged);
      if (!retainAcknowledged) {
        setRows(null);
        setAsOf(null);
      }
      try {
        const res = await goalsApi.progress();
        if (!activeRef.current || requestId !== loadRequestRef.current) return;
        if (res.error) {
          setLoadFailure(mode);
          return;
        }
        setLoadFailure(null);
        const progress = Array.isArray(res.data.progress)
          ? res.data.progress
          : [];
        setRows(progress);
        setAsOf(validSourceTimestamp(res.data.as_of || progress[0]?.as_of));
      } catch {
        if (activeRef.current && requestId === loadRequestRef.current) {
          setLoadFailure(mode);
        }
      } finally {
        if (activeRef.current && requestId === loadRequestRef.current) {
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    activeRef.current = true;
    void load("initial");
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "goal-delete",
    label: "Goal deletion",
    dirty: false,
    operationRef: deleteOperation.promiseRef,
    discard: () => undefined,
    operationDetail:
      "Wait for the goal deletion request to finish before leaving Moosewave.",
  });

  const onDelete = useCallback(async (): Promise<void> => {
    if (!deleting) return;
    if (deleteOperation.promiseRef.current) {
      await deleteOperation.wait();
      return;
    }
    setDeleteBusy(true);
    const target = deleting;
    const request = deleteOperation.run(async (): Promise<void> => {
      try {
        const res = await goalsApi.remove(target.id);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(GOAL_DELETE_ERROR);
          return;
        }
        setDeleting(null);
        toast.success("Goal deleted.");
        await load("refresh");
      } catch {
        if (activeRef.current) {
          toast.error(GOAL_DELETE_ERROR);
        }
      } finally {
        if (activeRef.current) setDeleteBusy(false);
      }
    });
    if (request) await request;
  }, [deleteOperation, deleting, load]);

  return (
    <>
      <GoalProgressView
        rows={rows}
        asOf={asOf}
        loadFailure={loadFailure}
        refreshing={refreshing}
        canAdmin={canAdmin}
        onRetry={() => void load(rows === null ? "initial" : "refresh")}
        onNew={() => setEditing("new")}
        onEdit={setEditing}
        onDelete={setDeleting}
      />

      {editing !== null ? (
        <GoalEditorModal
          goal={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load("refresh");
          }}
        />
      ) : null}

      <ConfirmModal
        open={deleting !== null}
        title="Delete goal?"
        description={
          deleting
            ? `"${goalDisplayName(deleting)}" and its pacing history will be removed.`
            : ""
        }
        confirmLabel="Delete goal"
        danger
        busy={deleteOperation.active || deleteBusy}
        onConfirm={() => void onDelete()}
        onClose={() => {
          if (!deleteOperation.active) setDeleting(null);
        }}
      />
    </>
  );
}

/* ---------- editor modal --------------------------------------------- */

export function GoalEditorModal({
  goal,
  onClose,
  onSaved,
}: {
  /** null → create mode. */
  goal: TenantGoal | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const isNew = goal === null;
  const [name, setName] = useState(goal?.name ?? "");
  // Metric is fixed after create — the server's PATCH has no metric
  // field, so the edit form renders it read-only.
  const [metric, setMetric] = useState<TenantGoalMetric>(
    goal?.metric ?? "subscribers",
  );
  const [target, setTarget] = useState(
    goal ? goalTargetToInput(goal.metric, goal.target) : "",
  );
  const [period, setPeriod] = useState<TenantGoalPeriod>(
    goal?.period ?? "monthly",
  );
  const [busy, setBusy] = useState(false);
  const [targetErr, setTargetErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const activeRef = useRef(true);
  const operation = useSingleFlightOperation({
    ownerId: goal ? `goal-edit-${goal.id}` : "goal-create",
    label: isNew ? "Goal creation" : "Goal update",
  });
  const baselineRef = useRef({
    name: goal?.name ?? "",
    metric: goal?.metric ?? "subscribers",
    target: goal ? goalTargetToInput(goal.metric, goal.target) : "",
    period: goal?.period ?? "monthly",
  });
  const dirty =
    name !== baselineRef.current.name ||
    metric !== baselineRef.current.metric ||
    target !== baselineRef.current.target ||
    period !== baselineRef.current.period;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const metricDef = GOAL_METRICS.find((m) => m.value === metric);
  const targetPrefix = metric === "revenue_cents" ? "$" : "";
  const targetSuffix = metric === "open_rate" ? "%" : "";

  const onSave = useCallback(async (): Promise<boolean> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    const parsed = parseGoalTargetInput(metric, target);
    if ("error" in parsed) {
      setTargetErr(parsed.error);
      return false;
    }
    setTargetErr(null);
    setBusy(true);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = isNew
          ? await goalsApi.create({
              name: name.trim() || undefined,
              metric,
              target: parsed.target,
              period,
            })
          : await goalsApi.update(goal.id, {
              name: name.trim() || undefined,
              target: parsed.target,
              period,
            });
        if (!activeRef.current) return false;
        if (res.error) {
          toast.error(GOAL_SAVE_ERROR);
          return false;
        }
        baselineRef.current = { name, metric, target, period };
        toast.success(isNew ? "Goal created." : "Goal updated.");
        try {
          onSaved();
        } catch {
          toast.error({
            message: isNew
              ? "Goal created, but the list couldn't refresh."
              : "Goal updated, but the list couldn't refresh.",
            detail: "Retry loading goals to see the saved result.",
          });
        }
        return true;
      } catch {
        if (activeRef.current) {
          toast.error(GOAL_SAVE_ERROR);
        }
        return false;
      } finally {
        if (activeRef.current) setBusy(false);
      }
    });
    return request ? await request : false;
  }, [goal, isNew, metric, name, onSaved, operation, period, target]);

  const discardAndClose = useCallback((): void => {
    const baseline = baselineRef.current;
    setName(baseline.name);
    setMetric(baseline.metric as TenantGoalMetric);
    setTarget(baseline.target);
    setPeriod(baseline.period as TenantGoalPeriod);
    setTargetErr(null);
    setDiscardConfirmOpen(false);
    onClose();
  }, [onClose]);

  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) setDiscardConfirmOpen(true);
    else onClose();
  }, [dirty, onClose, operation.promiseRef]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "goal-create",
    label: "New goal draft",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardAndClose,
    detail:
      "This goal has not been created. Return to the form or explicitly discard it.",
    enabled: isNew,
  });
  useExistingSettingLifecycle({
    ownerId: goal ? `goal-edit-${goal.id}` : "goal-edit-new-placeholder",
    label: "Goal changes",
    dirty,
    operationRef: operation.promiseRef,
    save: onSave,
    discard: discardAndClose,
    detail: "Goal changes have not been saved.",
    enabled: !isNew,
  });

  return (
    <Modal
      open
      onClose={requestClose}
      closeOnBackdrop={!operation.active}
      closeOnEscape={!operation.active}
      closeDisabled={operation.active}
      title={isNew ? "New goal" : "Edit goal"}
      description={
        isNew
          ? "Pick a metric and a per-period target — pacing updates live."
          : "Metric can't change after creation; adjust the target or period."
      }
    >
      <FormField label="Name" help="Optional — defaults to the metric name.">
        <input
          type="text"
          value={name}
          maxLength={120}
          placeholder={goalMetricLabel(metric)}
          onChange={(e) => setName(e.target.value)}
          disabled={operation.active}
        />
      </FormField>

      <FormField label="Metric" required help={metricDef?.unitHint}>
        {isNew ? (
          <select
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value as TenantGoalMetric);
              setTargetErr(null);
            }}
            disabled={operation.active}
          >
            {GOAL_METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input type="text" value={goalMetricLabel(metric)} disabled />
        )}
      </FormField>

      <FormField
        label={`Target${targetSuffix ? ` (${targetSuffix})` : targetPrefix ? ` (${targetPrefix})` : ""}`}
        required
        error={targetErr}
        help={
          metric === "revenue_cents"
            ? "In dollars — stored as cents on the server."
            : metric === "open_rate"
              ? "As a percentage, e.g. 45 for 45%."
              : undefined
        }
      >
        <input
          type="text"
          inputMode="decimal"
          value={target}
          placeholder={
            metric === "revenue_cents"
              ? "e.g. 5000"
              : metric === "open_rate"
                ? "e.g. 45"
                : "e.g. 1000"
          }
          onChange={(e) => {
            setTarget(e.target.value);
            if (targetErr) setTargetErr(null);
          }}
          disabled={operation.active}
        />
      </FormField>

      <FormField label="Period" required>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as TenantGoalPeriod)}
          disabled={operation.active}
        >
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
        </select>
      </FormField>

      <ModalFooter>
        <button
          type="button"
          className="btn dashboard-goal-editor__action"
          onClick={requestClose}
          disabled={operation.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary dashboard-goal-editor__action"
          onClick={() => void onSave()}
          disabled={operation.active}
        >
          {busy ? "Saving…" : isNew ? "Create goal" : "Save changes"}
        </button>
      </ModalFooter>
      <ConfirmModal
        open={discardConfirmOpen}
        title={isNew ? "Discard goal draft?" : "Discard goal changes?"}
        description={
          isNew
            ? "This goal has not been created."
            : "Your changes will be restored to the last saved goal."
        }
        confirmLabel="Discard"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => {
          if (!operation.active) setDiscardConfirmOpen(false);
        }}
      />
    </Modal>
  );
}
