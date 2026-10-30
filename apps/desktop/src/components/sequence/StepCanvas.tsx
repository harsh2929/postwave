/**
 * StepCanvas — vertical drag-and-drop step builder. Owns the canvas
 * state, drag-target highlighting, keyboard navigation, and persistence
 * (debounced 500ms for ordering changes, immediate for add / delete /
 * edit). Optimistic updates with rollback on error.
 *
 * The canvas talks to the Voice service through `api.updateSequence`
 * and persists the full v0.3 step union: emails, delays, conditions,
 * tag mutations, and exits. Legacy `emails[]` responses are still
 * promoted into canvas nodes for older local data.
 */
import {
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  api,
  type Sequence,
  type SequenceDetail,
  type SequenceFunnel,
  type SequenceFunnelStep,
  type SequenceGoal,
  type SequenceTrigger,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import {
  SEQUENCE_RUNTIME_AVAILABLE,
  SEQUENCE_RUNTIME_UNAVAILABLE_REASON,
  isEditableSequenceDraft,
  sequenceStatusPresentation,
} from "../../lib/sequence-operational-availability";
import {
  SEQUENCE_VERSION_CONFIRMATION_ERROR,
  confirmedNextSequenceVersion,
} from "../../lib/sequence-version";
import {
  type FunnelStepRow,
  branchFunnelStepId,
  findStepByFunnelId,
  getFunnelMetric,
  topLevelFunnelStepId,
} from "./funnel-metrics";
import { SequenceParticipantsDrawer } from "./SequenceParticipantsDrawer";
import { SequenceRuntimeNotice } from "./SequenceRuntimeNotice";
import { SequenceSettingsCard } from "./SequenceSettingsCard";
import { SequenceStatusControl } from "./SequenceStatusControl";
import { SequenceTriggerCard } from "./SequenceTriggerCard";
import { SequenceTriggerEditor } from "./SequenceTriggerEditor";
import { StepConnector } from "./StepConnector";
import { StepEditor } from "./StepEditor";
import { StepNode } from "./StepNode";
import { StepPalette } from "./StepPalette";
import {
  canPersistStep,
  canPersistSteps,
  findUnpersistableStep,
  persistBlockReason,
} from "./step-persist";
import {
  type CanvasStep,
  type CanvasStepMoveTarget,
  STEP_DRAG_MIME,
  type StepType,
  moveCanvasStep,
  stepTypeLabel,
} from "./types";
import {
  buildNewCanvasStep,
  canvasStepsToBackendSteps,
  deleteStepFromTree,
  findStepInTree,
  flattenSteps,
  insertCanvasStep,
  parseExistingStepDragPayload,
  parsePaletteDragPayload,
  renumberStepTree,
  renumberSteps,
  storedStepsToCanvasSteps,
  updateBranchInTree,
  updateStepInTree,
} from "./step-canvas-helpers";

interface Props {
  sequence: Sequence;
  /** Editor + admin can mutate; viewer is read-only. */
  canMutate: boolean;
  /** Keep the selected list row fresh when status/name changes. */
  onSequenceChange?: (next: Sequence) => void;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

function SequencePerformanceStrip({
  error,
  funnel,
  loading,
  onRetry,
  runtimeAvailable,
  steps,
}: {
  error: string | null;
  funnel: SequenceFunnel | null;
  loading: boolean;
  onRetry: () => void;
  runtimeAvailable: boolean;
  steps: CanvasStep[];
}): ReactElement | null {
  if (!runtimeAvailable) {
    return null;
  }
  if (error) {
    return (
      <div className="notice" role="alert" style={{ marginBottom: 12 }}>
        <span>Couldn&apos;t load sequence analytics: {error}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry metrics
        </button>
      </div>
    );
  }
  if (loading && !funnel) {
    return (
      <div className="seq-performance-strip" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skel" style={{ height: 48 }} />
        ))}
      </div>
    );
  }
  const rows = funnel?.steps ?? [];
  if (rows.length === 0) {
    return (
      <div className="seq-performance-empty">
        No subscribers have entered this sequence yet.
      </div>
    );
  }
  const first = rows[0];
  const entered = first?.reached ?? 0;
  // D07-templates-seq-automations#14: the backend emits one row per
  // (position, step_id), so a branching sequence has SIBLING rows at the
  // final position. Reading only rows[last] counts a single branch's
  // cohort; sum `reached` across every row sharing the max position to
  // mirror the backend's position-level completion total.
  const maxPosition = rows.reduce(
    (m, r) => (r.position > m ? r.position : m),
    rows[0]?.position ?? 0,
  );
  const completed = rows
    .filter((r) => r.position === maxPosition)
    .reduce((sum, r) => sum + (r.reached ?? 0), 0);
  const opens = rows.reduce((sum, row) => sum + row.opened, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clicked, 0);
  const worst = rows.reduce<SequenceFunnelStep | null>((acc, row) => {
    if (!acc || row.dropoff_pct > acc.dropoff_pct) return row;
    return acc;
  }, null);
  // Resolve the worst row back to its canvas step. Rows from step-aware
  // producers carry a path-encoded step_id (may point INSIDE a branch);
  // legacy rows only carry the flat top-level position.
  const worstStepId = (worst as FunnelStepRow | null)?.step_id;
  const stepLabel = worst
    ? ((worstStepId
        ? findStepByFunnelId(steps, worstStepId)?.type
        : steps.find((s) => s.position === worst.position)?.type) ?? "step")
    : "step";
  return (
    <div className="seq-performance-strip">
      <div className="seq-performance-tile">
        <span>Entered</span>
        <strong>{entered.toLocaleString()}</strong>
      </div>
      <div className="seq-performance-tile">
        <span>Reached last step</span>
        <strong>{completed.toLocaleString()}</strong>
      </div>
      <div className="seq-performance-tile">
        <span>Total opens</span>
        <strong>{opens.toLocaleString()}</strong>
      </div>
      <div className="seq-performance-tile">
        <span>Total clicks</span>
        <strong>{clicks.toLocaleString()}</strong>
      </div>
      <div className="seq-performance-tile">
        <span>Worst drop-off</span>
        <strong>
          {worst ? `${worst.dropoff_pct.toFixed(0)}% · ${stepLabel}` : "—"}
        </strong>
      </div>
    </div>
  );
}

/* ------- canvas ---------------------------------------------------- */

type EnqueueCanvasMutation = <T>(task: () => Promise<T>) => Promise<T>;

interface CanvasPersistenceOptions {
  sequenceId: Sequence["id"];
  activeRef: MutableRefObject<boolean>;
  canMutateRef: MutableRefObject<boolean>;
  loadFunnel: () => Promise<void>;
  sequenceVersionRef: MutableRefObject<number | null>;
  lastSavedRef: MutableRefObject<CanvasStep[]>;
  stepsRef: MutableRefObject<CanvasStep[]>;
  setSteps: StateSetter<CanvasStep[]>;
  setEditingId: StateSetter<string | null>;
  setPersistenceError: StateSetter<string | null>;
  setPersistenceConflict: StateSetter<boolean>;
  setConcurrencyReady: StateSetter<boolean>;
}

function useCanvasPersistence({
  sequenceId,
  activeRef,
  canMutateRef,
  loadFunnel,
  sequenceVersionRef,
  lastSavedRef,
  stepsRef,
  setSteps,
  setEditingId,
  setPersistenceError,
  setPersistenceConflict,
  setConcurrencyReady,
}: CanvasPersistenceOptions): {
  enqueueMutation: EnqueueCanvasMutation;
  persistNow: (
    next: CanvasStep[],
    freshBlankTagId?: string,
  ) => Promise<boolean>;
  persistDebounced: (next: CanvasStep[]) => void;
  discardFailedPersist: () => void;
  retryFailedPersist: () => Promise<boolean>;
} {
  const persistTimerRef = useRef<number | null>(null);
  const pendingDebouncedPersistRef = useRef<CanvasStep[] | null>(null);
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queuedMutationCountRef = useRef(0);
  const failedSnapshotRef = useRef<CanvasStep[] | null>(null);

  const enqueueMutation = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      queuedMutationCountRef.current += 1;
      const guardedTask = async (): Promise<T> => {
        try {
          return await task();
        } finally {
          queuedMutationCountRef.current = Math.max(
            0,
            queuedMutationCountRef.current - 1,
          );
        }
      };
      const run = mutationChainRef.current.then(guardedTask, guardedTask);
      // Keep the chain alive regardless of the task's outcome so one
      // failed PATCH doesn't wedge every subsequent mutation.
      mutationChainRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const persistNow = useCallback(
    (next: CanvasStep[], freshBlankTagId?: string): Promise<boolean> => {
      // Belt-and-suspenders: even though every caller checks readOnly
      // at its entry, a role downgrade between the click and the
      // setSteps callback could let a persist slip through and 403.
      // Re-check here so the canMutate guard isn't load-bearing only
      // at the call sites.
      if (!activeRef.current || !canMutateRef.current || sequenceId == null) {
        return Promise.resolve(false);
      }
      // Newly dropped tag nodes intentionally start blank so the user
      // can name the tag in the editor. Wait to persist until required
      // fields are present; otherwise the server would reject and roll
      // back before the editor opens. Surface WHICH step is blocking so
      // the operator isn't left wondering why a save silently no-ops —
      // a legacy email with an invalid A/B split they never touched
      // would otherwise block every canvas save with no feedback.
      if (!canPersistSteps(next)) {
        const bad = findUnpersistableStep(next);
        // D07-templates-seq-automations#3: ONLY the persist fired by the
        // drop itself (the just-dropped node, editor about to open) is an
        // expected benign no-op — suppress its toast. A blank tag left
        // over from any other path (e.g. abandoned via Cancel) is a real
        // blocker the user must see, so it now surfaces the reason rather
        // than silently swallowing every subsequent save.
        const isFreshBlankTag =
          !!bad &&
          bad.id === freshBlankTagId &&
          (bad.type === "tag_add" || bad.type === "tag_remove") &&
          (bad.tag ?? "").trim().length === 0;
        if (bad && !isFreshBlankTag) {
          const reason = persistBlockReason(bad);
          if (reason) {
            toast.error(reason);
          }
        }
        return Promise.resolve(false);
      }
      // An immediate snapshot supersedes an older trailing reorder only once
      // the replacement has passed validation. Clearing first would strand
      // the valid reorder when a newly dropped blank tag intentionally cannot
      // persist until its editor is completed or cancelled.
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      pendingDebouncedPersistRef.current = null;
      // D07-templates-seq-automations#8: run inside the shared mutation
      // chain so the version read below happens AFTER the previous PATCH
      // bumped sequenceVersionRef — otherwise back-to-back mutations
      // share one stale If-Match and the second 412s spuriously.
      return enqueueMutation(async (): Promise<boolean> => {
        // This task may wait behind another versioned PATCH. Re-check current
        // authority immediately before touching the server.
        if (!activeRef.current || !canMutateRef.current) return false;
        // Pass the captured version through If-Match so concurrent
        // editors get 412 instead of silently clobbering each other.
        // canMutateRef is false until a positive server version is loaded;
        // the non-null assertion keeps the transport contract mandatory.
        const expectedVersion = sequenceVersionRef.current!;
        let res;
        try {
          res = await api.updateSequence(
            sequenceId,
            { steps: canvasStepsToBackendSteps(next) },
            expectedVersion,
          );
        } catch (error) {
          if (activeRef.current) {
            const message =
              error instanceof Error && error.message
                ? `Couldn't save: ${error.message}`
                : "Couldn't save the sequence. Try again.";
            failedSnapshotRef.current = next;
            setPersistenceConflict(false);
            setPersistenceError(message);
            toast.error(message);
            setSteps((current) => {
              if (JSON.stringify(current) !== JSON.stringify(next)) {
                return current;
              }
              stepsRef.current = lastSavedRef.current;
              return lastSavedRef.current;
            });
          }
          return false;
        }
        if (res.error) {
          // A 412 means another session moved the row forward between
          // our last GET and this PATCH. Surface a recovery hint so the
          // operator knows what to do; refreshing reloads the row and
          // re-captures the new version, then their next edit can land.
          // D07-templates-seq-automations#10: the voice service emits a
          // plain-text 412 body, so `code` is derived as "http_412", not
          // "precondition_failed" — match on the HTTP status instead.
          if (
            res.error.status === 412 ||
            res.error.code === "precondition_failed"
          ) {
            const message =
              "This sequence was edited in another tab. Reload the latest version, then re-apply your change.";
            failedSnapshotRef.current = next;
            sequenceVersionRef.current = null;
            setConcurrencyReady(false);
            setPersistenceConflict(true);
            setPersistenceError(message);
            toast.error(message);
          } else {
            const message = `Couldn't save: ${res.error.message}`;
            failedSnapshotRef.current = next;
            setPersistenceConflict(false);
            setPersistenceError(message);
            toast.error(message);
          }
          setSteps((current) => {
            // A later optimistic snapshot may already be visible and queued.
            // Roll back only when this failed snapshot is still the latest UI.
            if (JSON.stringify(current) !== JSON.stringify(next)) {
              return current;
            }
            stepsRef.current = lastSavedRef.current;
            return lastSavedRef.current;
          });
          return false;
        }
        const confirmedVersion = confirmedNextSequenceVersion(
          res.data?.version,
          expectedVersion,
        );
        if (confirmedVersion === null) {
          failedSnapshotRef.current = next;
          sequenceVersionRef.current = null;
          setConcurrencyReady(false);
          setPersistenceConflict(true);
          setPersistenceError(SEQUENCE_VERSION_CONFIRMATION_ERROR);
          toast.error(SEQUENCE_VERSION_CONFIRMATION_ERROR);
          setSteps((current) => {
            if (JSON.stringify(current) !== JSON.stringify(next)) {
              return current;
            }
            stepsRef.current = lastSavedRef.current;
            return lastSavedRef.current;
          });
          return false;
        }
        lastSavedRef.current = next;
        failedSnapshotRef.current = null;
        setPersistenceConflict(false);
        setPersistenceError(null);
        sequenceVersionRef.current = confirmedVersion;
        void loadFunnel();
        return true;
      });
    },
    [
      activeRef,
      canMutateRef,
      enqueueMutation,
      lastSavedRef,
      loadFunnel,
      sequenceId,
      sequenceVersionRef,
      setConcurrencyReady,
      setSteps,
      setPersistenceConflict,
      setPersistenceError,
      stepsRef,
    ],
  );

  /**
   * Reorder-by-drag-handle batches position updates with a 500ms
   * trailing debounce so one settled move emits one PATCH.
   */
  const persistDebounced = useCallback(
    (next: CanvasStep[]): void => {
      pendingDebouncedPersistRef.current = next;
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = window.setTimeout(() => {
        persistTimerRef.current = null;
        const pending = pendingDebouncedPersistRef.current;
        pendingDebouncedPersistRef.current = null;
        if (pending) void persistNow(pending);
      }, 500);
    },
    [persistNow],
  );

  const flushCanvasPersistence = useCallback(async (): Promise<void> => {
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingDebouncedPersistRef.current;
    pendingDebouncedPersistRef.current = null;
    if (pending) {
      const saved = await persistNow(pending);
      if (!saved) throw new Error("sequence_persistence_not_confirmed");
    }
    await mutationChainRef.current;
    if (failedSnapshotRef.current) {
      throw new Error("sequence_persistence_requires_reconciliation");
    }
    if (
      JSON.stringify(stepsRef.current) !== JSON.stringify(lastSavedRef.current)
    ) {
      throw new Error("sequence_persistence_dirty_without_pending_save");
    }
  }, [persistNow]);

  const retryFailedPersist = useCallback(async (): Promise<boolean> => {
    const failed = failedSnapshotRef.current;
    if (!failed) return true;
    const currentIsLastConfirmed =
      JSON.stringify(stepsRef.current) === JSON.stringify(lastSavedRef.current);
    const candidate = currentIsLastConfirmed ? failed : stepsRef.current;
    stepsRef.current = candidate;
    setSteps(candidate);
    return await persistNow(candidate);
  }, [lastSavedRef, persistNow, setSteps, stepsRef]);

  const discardFailedPersist = useCallback((): void => {
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    pendingDebouncedPersistRef.current = null;
    failedSnapshotRef.current = null;
    setPersistenceConflict(false);
    setPersistenceError(null);
    stepsRef.current = lastSavedRef.current;
    setSteps(lastSavedRef.current);
    setEditingId(null);
  }, [
    lastSavedRef,
    setEditingId,
    setPersistenceConflict,
    setPersistenceError,
    setSteps,
    stepsRef,
  ]);

  useEffect(() => {
    return registerLifecycleGuard({
      id: `sequence-canvas-${String(sequenceId)}`,
      label: "Sequence canvas changes",
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        const queued = queuedMutationCountRef.current;
        const pending = pendingDebouncedPersistRef.current !== null;
        const dirty =
          JSON.stringify(stepsRef.current) !==
          JSON.stringify(lastSavedRef.current);
        const failed = failedSnapshotRef.current !== null;
        if (!pending && queued === 0 && !dirty && !failed) return null;
        return {
          level: "blocking",
          detail:
            queued > 0
              ? "Sequence changes are still being persisted in order."
              : failed
                ? "A sequence save was not confirmed. Retry the failed change, reload the server version, or explicitly discard it."
                : "Sequence canvas changes are waiting for their trailing save.",
          canDiscard: queued === 0,
        };
      },
      prepare: flushCanvasPersistence,
      discard: () => {
        if (queuedMutationCountRef.current > 0) {
          throw new Error("sequence_persistence_active");
        }
        if (persistTimerRef.current != null) {
          window.clearTimeout(persistTimerRef.current);
          persistTimerRef.current = null;
        }
        pendingDebouncedPersistRef.current = null;
        failedSnapshotRef.current = null;
        setPersistenceConflict(false);
        setPersistenceError(null);
        stepsRef.current = lastSavedRef.current;
        setSteps(lastSavedRef.current);
        setEditingId(null);
      },
    });
  }, [flushCanvasPersistence, sequenceId]);

  // Normal navigation is coordinated by the lifecycle guard above. Once this
  // identity unmounts, never start a new full-array write from stale state.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
      }
      pendingDebouncedPersistRef.current = null;
    };
  }, []);

  return {
    enqueueMutation,
    discardFailedPersist,
    persistNow,
    persistDebounced,
    retryFailedPersist,
  };
}

interface StepMutationActionOptions {
  readOnly: boolean;
  pendingNewStepIdRef: MutableRefObject<string | null>;
  setSteps: StateSetter<CanvasStep[]>;
  persistNow: (
    next: CanvasStep[],
    freshBlankTagId?: string,
  ) => Promise<boolean>;
  persistDebounced: (next: CanvasStep[]) => void;
  setFocusedId: StateSetter<string | null>;
  setEditingId: StateSetter<string | null>;
  setCanvasAnnouncement: StateSetter<string>;
  nodeRefs: MutableRefObject<Map<string, HTMLElement>>;
  focusedId: string | null;
  editingId: string | null;
  lastSavedRef: MutableRefObject<CanvasStep[]>;
  stepsRef: MutableRefObject<CanvasStep[]>;
  setDraggingStepId: StateSetter<string | null>;
  setDropTargetKey: StateSetter<string | null>;
}

function createStepMutationActions({
  readOnly,
  pendingNewStepIdRef,
  setSteps,
  persistNow,
  persistDebounced,
  setFocusedId,
  setEditingId,
  setCanvasAnnouncement,
  nodeRefs,
  focusedId,
  editingId,
  lastSavedRef,
  stepsRef,
  setDraggingStepId,
  setDropTargetKey,
}: StepMutationActionOptions) {
  const addPaletteStep = (
    type: StepType,
    target: { kind: "before" | "after"; targetId: string } | { kind: "end" },
  ): void => {
    if (readOnly) return;
    const newStep = buildNewCanvasStep(type);
    // Mark this as the just-dropped node so persistNow tolerates its
    // blank state (tag nodes) and cancelEdit can reclaim it if abandoned.
    pendingNewStepIdRef.current = newStep.id;

    setSteps((prev) => {
      let next: CanvasStep[];
      if (target.kind === "end") {
        next = renumberSteps([...prev, newStep]);
      } else {
        const idx = prev.findIndex((s) => s.id === target.targetId);
        if (idx < 0) next = renumberSteps([...prev, newStep]);
        else
          next = insertCanvasStep(
            prev,
            target.kind === "before" ? idx : idx + 1,
            newStep,
          );
      }
      // Persist immediately for add. Use the "next" we just built.
      stepsRef.current = next;
      void persistNow(next, newStep.id);
      return next;
    });
    setFocusedId(newStep.id);
    setEditingId(newStep.id);
    setCanvasAnnouncement(
      `Added ${stepTypeLabel(type)} step. Its editor is open.`,
    );
  };

  const handlePaletteDrop = (
    raw: string,
    target: { kind: "before" | "after"; targetId: string } | { kind: "end" },
  ): void => {
    const payload = parsePaletteDragPayload(raw);
    if (!payload) return;
    addPaletteStep(payload.type, target);
  };

  const moveExistingStep = (
    stepId: string,
    target: CanvasStepMoveTarget,
  ): void => {
    if (readOnly) return;
    setSteps((prev) => {
      const next = moveCanvasStep(prev, stepId, target);
      if (next === prev) return prev;
      stepsRef.current = next;
      persistDebounced(next);
      const moved = next.find((step) => step.id === stepId);
      if (moved) {
        setCanvasAnnouncement(
          `Moved ${stepTypeLabel(moved.type)} step to position ${moved.position} of ${next.length}.`,
        );
      }
      return next;
    });
    setFocusedId(stepId);
    window.requestAnimationFrame(() => {
      nodeRefs.current.get(stepId)?.focus();
    });
  };

  const moveBranchStep = (
    conditionId: string,
    branch: "yes" | "no",
    stepId: string,
    delta: -1 | 1,
  ): void => {
    if (readOnly) return;
    setSteps((prev) => {
      let position = 0;
      let branchLength = 0;
      let movedType: StepType | null = null;
      const next = updateBranchInTree(prev, conditionId, branch, (current) => {
        const from = current.findIndex((step) => step.id === stepId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= current.length) return current;
        const copy = [...current];
        const [moved] = copy.splice(from, 1);
        if (!moved) return current;
        copy.splice(to, 0, moved);
        position = to + 1;
        branchLength = copy.length;
        movedType = moved.type;
        return copy;
      });
      if (!movedType) return prev;
      stepsRef.current = next;
      persistDebounced(next);
      setCanvasAnnouncement(
        `Moved ${stepTypeLabel(movedType)} step to position ${position} of ${branchLength} in the ${branch === "yes" ? "Yes" : "No"} branch.`,
      );
      return next;
    });
    setFocusedId(stepId);
    window.requestAnimationFrame(() => nodeRefs.current.get(stepId)?.focus());
  };

  const handleStepDropPayload = (
    raw: string,
    target: CanvasStepMoveTarget,
  ): void => {
    const existing = parseExistingStepDragPayload(raw);
    if (existing) {
      moveExistingStep(existing.stepId, target);
      return;
    }
    handlePaletteDrop(raw, target);
  };

  const handleExistingStepDragStart = (
    e: DragEvent<HTMLButtonElement>,
    id: string,
  ): void => {
    if (readOnly) return;
    setDraggingStepId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      STEP_DRAG_MIME,
      JSON.stringify({ source: "canvas-step", stepId: id }),
    );
    e.dataTransfer.setData("text/plain", "Move sequence step");
  };

  const handleExistingStepDragEnd = (): void => {
    setDraggingStepId(null);
    setDropTargetKey(null);
  };

  const deleteStep = (id: string): void => {
    if (readOnly) return;
    // Compute neighbour focus from the SAME snapshot setSteps is
    // working against. Reading the outer `steps` closure here meant
    // that if the user added or moved a step and immediately deleted
    // another before this handler captured a fresh render, the
    // neighbour lookup ran against a stale list and focus jumped
    // to the wrong row.
    let neighbourId: string | null = null;
    const wasFocused = focusedId === id;
    setSteps((prev) => {
      if (wasFocused) {
        const flat = flattenSteps(prev);
        const idx = flat.findIndex((s) => s.id === id);
        neighbourId = flat[idx + 1]?.id ?? flat[idx - 1]?.id ?? null;
      }
      const next = renumberStepTree(deleteStepFromTree(prev, id));
      stepsRef.current = next;
      void persistNow(next);
      return next;
    });
    if (editingId === id) setEditingId(null);
    if (wasFocused) setFocusedId(neighbourId);
  };

  const saveStep = async (next: CanvasStep): Promise<void> => {
    if (readOnly)
      throw new Error("Editor access is required to save this step.");
    // The pending node has now been edited + is being persisted, so it's
    // no longer a "fresh drop" (D07-templates-seq-automations#3).
    if (pendingNewStepIdRef.current === next.id) {
      pendingNewStepIdRef.current = null;
    }
    const updated = updateStepInTree(stepsRef.current, next);
    stepsRef.current = updated;
    setSteps(updated);
    const saved = await persistNow(updated);
    if (!saved) {
      throw new Error(
        "The server did not confirm this step. Review the error and try again.",
      );
    }
    setEditingId(null);
  };

  /**
   * Close the step editor. If the user is cancelling a node they just
   * dropped and never named (only tag nodes start blank/unpersistable),
   * reclaim it: an abandoned blank node otherwise lingers in local state
   * and, because canPersistSteps() then stays false, silently blocks
   * EVERY later save — edits/reorders/deletes appear applied but never
   * PATCH and vanish on reload (D07-templates-seq-automations#3).
   */
  const cancelEdit = (): void => {
    const editing = editingId;
    setEditingId(null);
    if (!editing) return;
    setSteps((prev) => {
      const step = findStepInTree(prev, editing);
      if (!step || canPersistStep(step)) return prev;
      // Only drop nodes that were never persisted — an EXISTING node the
      // user is merely editing (e.g. legacy data with a bad variant
      // split) must survive a cancel, not be deleted.
      const everSaved = findStepInTree(lastSavedRef.current, editing) != null;
      if (everSaved) return prev;
      pendingNewStepIdRef.current = null;
      const next = renumberStepTree(deleteStepFromTree(prev, editing));
      stepsRef.current = next;
      // Cancelling can follow a debounced reorder. Persist the reclaimed,
      // valid snapshot immediately so no local order is left without a timer
      // or a failed-save recovery surface.
      void persistNow(next);
      return next;
    });
  };

  return {
    addPaletteStep,
    handlePaletteDrop,
    moveExistingStep,
    moveBranchStep,
    handleStepDropPayload,
    handleExistingStepDragStart,
    handleExistingStepDragEnd,
    deleteStep,
    saveStep,
    cancelEdit,
  };
}

interface SequenceMutationActionOptions {
  readOnly: boolean;
  activeRef: MutableRefObject<boolean>;
  canMutateRef: MutableRefObject<boolean>;
  sequenceId: Sequence["id"];
  trigger: SequenceTrigger | null;
  setTrigger: StateSetter<SequenceTrigger | null>;
  enqueueMutation: EnqueueCanvasMutation;
  sequenceVersionRef: MutableRefObject<number | null>;
  setConcurrencyReady: StateSetter<boolean>;
  setSequence: StateSetter<Sequence>;
  onSequenceChange: ((next: Sequence) => void) | undefined;
  setSettingsSaving: StateSetter<boolean>;
  setGoal: StateSetter<SequenceGoal | null>;
  setStuckAfterDays: StateSetter<number>;
}

function createSequenceMutationActions({
  readOnly,
  activeRef,
  canMutateRef,
  sequenceId,
  trigger,
  setTrigger,
  enqueueMutation,
  sequenceVersionRef,
  setConcurrencyReady,
  setSequence,
  onSequenceChange,
  setSettingsSaving,
  setGoal,
  setStuckAfterDays,
}: SequenceMutationActionOptions) {
  const saveTrigger = (next: SequenceTrigger | null): void => {
    if (readOnly || sequenceId == null || !SEQUENCE_RUNTIME_AVAILABLE) {
      toast.error(SEQUENCE_RUNTIME_UNAVAILABLE_REASON);
      return;
    }
    const previous = trigger;
    setTrigger(next);
    // Serialize with every other PATCH (D07-templates-seq-automations#8)
    // so this save re-reads the version after any in-flight step edit —
    // otherwise a trigger save bumps the row version and the next step
    // edit 412s for no real conflict.
    void enqueueMutation(async () => {
      if (!activeRef.current || !canMutateRef.current) return;
      const expectedVersion = sequenceVersionRef.current!;
      const res = await api.updateSequence(
        sequenceId,
        { trigger: next },
        expectedVersion,
      );
      if (res.error) {
        setTrigger(previous);
        if (
          res.error.status === 412 ||
          res.error.code === "precondition_failed"
        ) {
          toast.error(
            "This sequence was edited in another tab — refresh to see the latest version, then re-apply your change.",
          );
        } else {
          toast.error(`Couldn't save trigger: ${res.error.message}`);
        }
        return;
      }
      const confirmedVersion = confirmedNextSequenceVersion(
        res.data?.version,
        expectedVersion,
      );
      if (confirmedVersion === null) {
        sequenceVersionRef.current = null;
        setConcurrencyReady(false);
        setTrigger(previous);
        toast.error(SEQUENCE_VERSION_CONFIRMATION_ERROR);
        return;
      }
      sequenceVersionRef.current = confirmedVersion;
      // D07-templates-seq-automations#1: the Voice service has no
      // `trigger` column/struct field, so a non-null trigger we send is
      // silently dropped — it never round-trips and never enrolls anyone.
      // Detect the drop (we sent one but the full-sequence response
      // doesn't echo it back) and tell the truth instead of toasting a
      // false "saved" and keeping a client-only illusion via `?? next`.
      // Forward-compatible: a backend that DOES persist the trigger
      // serializes it into this response and the success path runs.
      const echoed = res.data?.trigger;
      if (next && (echoed === undefined || echoed === null)) {
        setTrigger(previous);
        toast.error(
          "Entry triggers aren't supported by this server yet — the trigger was not saved.",
        );
        return;
      }
      setTrigger(echoed ?? next);
      toast.success(
        next ? "Sequence trigger saved" : "Sequence trigger cleared",
      );
    });
  };

  const handleSequenceChange = (next: Sequence): void => {
    setSequence(next);
    onSequenceChange?.(next);
  };

  /**
   * Persist the goal + stuck-threshold settings. Mirrors saveTrigger:
   * thread the If-Match version, capture the bumped version on
   * success, and re-seed local state from the response (falling back
   * to the patch we sent for backends that don't echo the fields yet).
   */
  const saveSettings = (patch: {
    goal: SequenceGoal | null;
    stuck_after_days: number;
  }): void => {
    if (readOnly || sequenceId == null) return;
    setSettingsSaving(true);
    // Serialize with the other PATCHes (D07-templates-seq-automations#8).
    void enqueueMutation(async () => {
      if (!activeRef.current || !canMutateRef.current) {
        if (activeRef.current) setSettingsSaving(false);
        return;
      }
      const expectedVersion = sequenceVersionRef.current!;
      let res;
      try {
        res = await api.updateSequence(
          sequenceId,
          { goal: patch.goal, stuck_after_days: patch.stuck_after_days },
          expectedVersion,
        );
      } catch (error) {
        if (activeRef.current) {
          setSettingsSaving(false);
          toast.error(
            error instanceof Error && error.message
              ? `Couldn't save settings: ${error.message}`
              : "Couldn't save sequence settings. Try again.",
          );
        }
        return;
      }
      if (!activeRef.current) return;
      setSettingsSaving(false);
      if (res.error) {
        if (
          res.error.status === 412 ||
          res.error.code === "precondition_failed"
        ) {
          toast.error(
            "This sequence was edited in another tab — refresh to see the latest version, then re-apply your change.",
          );
        } else {
          toast.error(`Couldn't save settings: ${res.error.message}`);
        }
        return;
      }
      const confirmedVersion = confirmedNextSequenceVersion(
        res.data?.version,
        expectedVersion,
      );
      if (confirmedVersion === null) {
        sequenceVersionRef.current = null;
        setConcurrencyReady(false);
        toast.error(SEQUENCE_VERSION_CONFIRMATION_ERROR);
        return;
      }
      sequenceVersionRef.current = confirmedVersion;
      setGoal(
        res.data?.goal !== undefined ? (res.data.goal ?? null) : patch.goal,
      );
      setStuckAfterDays(res.data?.stuck_after_days ?? patch.stuck_after_days);
      toast.success("Sequence settings saved");
    });
  };

  return { saveTrigger, handleSequenceChange, saveSettings };
}

interface CanvasInteractionOptions {
  steps: CanvasStep[];
  readOnly: boolean;
  moveExistingStep: (stepId: string, target: CanvasStepMoveTarget) => void;
  setFocusedId: StateSetter<string | null>;
  nodeRefs: MutableRefObject<Map<string, HTMLElement>>;
  setEditingId: StateSetter<string | null>;
  setPendingDeleteId: StateSetter<string | null>;
  draggingStepId: string | null;
  handleStepDropPayload: (raw: string, target: CanvasStepMoveTarget) => void;
  setDropTargetKey: StateSetter<string | null>;
}

function createCanvasInteractions({
  steps,
  readOnly,
  moveExistingStep,
  setFocusedId,
  nodeRefs,
  setEditingId,
  setPendingDeleteId,
  draggingStepId,
  handleStepDropPayload,
  setDropTargetKey,
}: CanvasInteractionOptions) {
  const handleNodeKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ): void => {
    const flat = flattenSteps(steps);
    const idx = flat.findIndex((s) => s.id === id);
    if (idx < 0) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const topLevelIndex = steps.findIndex((s) => s.id === id);
      if (topLevelIndex < 0) return;
      e.preventDefault();
      if (readOnly) return;
      if (e.key === "ArrowUp") {
        const target = steps[topLevelIndex - 1];
        if (target)
          moveExistingStep(id, { kind: "before", targetId: target.id });
      } else {
        const target = steps[topLevelIndex + 1];
        if (target)
          moveExistingStep(id, { kind: "after", targetId: target.id });
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = flat[idx + 1];
      if (next) {
        setFocusedId(next.id);
        nodeRefs.current.get(next.id)?.focus();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = flat[idx - 1];
      if (prev) {
        setFocusedId(prev.id);
        nodeRefs.current.get(prev.id)?.focus();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!readOnly) setEditingId(id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (!readOnly) setPendingDeleteId(id);
    }
  };

  /* ----- drop handling on the empty/end zone ----- */

  const onCanvasDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (readOnly) return;
    if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = draggingStepId ? "move" : "copy";
  };
  const onCanvasDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (readOnly) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(STEP_DRAG_MIME);
    if (raw) handleStepDropPayload(raw, { kind: "end" });
    setDropTargetKey(null);
  };

  /* ----- node-relative drop zones (top-half = before, bottom-half = after) */

  const makeNodeWrapHandlers = (
    id: string,
  ): {
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: () => void;
  } => ({
    onDragOver: (e) => {
      if (readOnly) return;
      if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = draggingStepId ? "move" : "copy";
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const half = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDropTargetKey(`${half}:${id}`);
    },
    onDrop: (e) => {
      if (readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = e.dataTransfer.getData(STEP_DRAG_MIME);
      if (!raw) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const kind = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      handleStepDropPayload(raw, { kind, targetId: id });
      setDropTargetKey(null);
    },
    onDragLeave: () => {
      // Clearing happens lazily on next dragOver — leaving alone here
      // to avoid flicker when crossing into the inner StepNode.
    },
  });

  return {
    handleNodeKeyDown,
    onCanvasDragOver,
    onCanvasDrop,
    makeNodeWrapHandlers,
  };
}

interface ConditionBranchRendererOptions {
  readOnly: boolean;
  draggingStepId: string | null;
  dropTargetKey: string | null;
  setDropTargetKey: StateSetter<string | null>;
  pendingNewStepIdRef: MutableRefObject<string | null>;
  setSteps: StateSetter<CanvasStep[]>;
  persistNow: (
    next: CanvasStep[],
    freshBlankTagId?: string,
  ) => Promise<boolean>;
  stepsRef: MutableRefObject<CanvasStep[]>;
  setFocusedId: StateSetter<string | null>;
  setEditingId: StateSetter<string | null>;
  setCanvasAnnouncement: StateSetter<string>;
  editingId: string | null;
  focusedId: string | null;
  funnel: SequenceFunnel | null;
  setPendingDeleteId: StateSetter<string | null>;
  moveBranchStep: (
    conditionId: string,
    branch: "yes" | "no",
    stepId: string,
    delta: -1 | 1,
  ) => void;
  handleNodeKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => void;
  registerNodeRef: (id: string, element: HTMLElement | null) => void;
}

function createConditionBranchRenderer({
  readOnly,
  draggingStepId,
  dropTargetKey,
  setDropTargetKey,
  pendingNewStepIdRef,
  setSteps,
  persistNow,
  stepsRef,
  setFocusedId,
  setEditingId,
  setCanvasAnnouncement,
  editingId,
  focusedId,
  funnel,
  setPendingDeleteId,
  moveBranchStep,
  handleNodeKeyDown,
  registerNodeRef,
}: ConditionBranchRendererOptions): (
  condition: CanvasStep,
  conditionFunnelId: string,
) => ReactElement {
  const renderConditionBranches = (
    cond: CanvasStep,
    condFunnelId: string,
  ): ReactElement => {
    const yesSteps = cond.yes_branch ?? [];
    const noSteps = cond.no_branch ?? [];
    const branch = (label: "yes" | "no", list: CanvasStep[]): ReactElement => {
      const onBranchDragOver = (e: DragEvent<HTMLDivElement>): void => {
        if (readOnly) return;
        if (draggingStepId) return;
        if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropTargetKey(`branch-${label}:${cond.id}`);
      };
      const insertBranchStep = (
        type: StepType,
        target:
          | { kind: "end" }
          | { kind: "before" | "after"; targetId: string },
      ): void => {
        const newStep = buildNewCanvasStep(type);
        // Mark this branch node as the just-dropped one (see handlePaletteDrop).
        pendingNewStepIdRef.current = newStep.id;
        setSteps((prev) => {
          const next = updateBranchInTree(prev, cond.id, label, (current) => {
            if (target.kind === "end") return [...current, newStep];
            const idx = current.findIndex((s) => s.id === target.targetId);
            if (idx < 0) return [...current, newStep];
            const insertIndex = target.kind === "before" ? idx : idx + 1;
            const copy = [...current];
            copy.splice(insertIndex, 0, newStep);
            return copy;
          });
          stepsRef.current = next;
          void persistNow(next, newStep.id);
          return next;
        });
        setFocusedId(newStep.id);
        setEditingId(newStep.id);
        setCanvasAnnouncement(
          `Added ${stepTypeLabel(type)} step to the ${label === "yes" ? "Yes" : "No"} branch. Its editor is open.`,
        );
      };
      const onBranchDrop = (e: DragEvent<HTMLDivElement>): void => {
        if (readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        const raw = e.dataTransfer.getData(STEP_DRAG_MIME);
        if (!raw) return;
        const payload = parsePaletteDragPayload(raw);
        if (!payload) return;
        insertBranchStep(payload.type, { kind: "end" });
        setDropTargetKey(null);
      };
      const branchNodeHandlers = (id: string) => ({
        onDragOver: (e: DragEvent<HTMLDivElement>): void => {
          if (readOnly) return;
          if (draggingStepId) return;
          if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME))
            return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          const rect = e.currentTarget.getBoundingClientRect();
          const half =
            e.clientY < rect.top + rect.height / 2 ? "before" : "after";
          setDropTargetKey(`branch-${label}-${half}:${id}`);
        },
        onDrop: (e: DragEvent<HTMLDivElement>): void => {
          if (readOnly) return;
          e.preventDefault();
          e.stopPropagation();
          const raw = e.dataTransfer.getData(STEP_DRAG_MIME);
          if (!raw) return;
          const payload = parsePaletteDragPayload(raw);
          if (!payload) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const kind =
            e.clientY < rect.top + rect.height / 2 ? "before" : "after";
          insertBranchStep(payload.type, { kind, targetId: id });
          setDropTargetKey(null);
        },
      });
      return (
        <div
          className={
            "step-branch step-branch-" +
            label +
            (dropTargetKey === `branch-${label}:${cond.id}`
              ? " is-drop-target"
              : "")
          }
          onDragOver={onBranchDragOver}
          onDrop={onBranchDrop}
          role="group"
          aria-label={`${label === "yes" ? "Yes" : "No"} branch`}
        >
          <div className="step-branch-label">
            {label === "yes" ? "Yes" : "No"}
          </div>
          {list.length === 0 ? (
            <div className="step-branch-empty">
              Add a step below, or drop one here
            </div>
          ) : (
            list.map((bs, i) => {
              const handlers = branchNodeHandlers(bs.id);
              const beforeKey = `branch-${label}-before:${bs.id}`;
              const afterKey = `branch-${label}-after:${bs.id}`;
              const bsFunnelId = branchFunnelStepId(
                condFunnelId,
                label,
                bs.position,
              );
              return (
                <div key={bs.id} className="step-branch-node-row">
                  {dropTargetKey === beforeKey ? (
                    <div className="step-drop-marker step-drop-marker-branch" />
                  ) : null}
                  <div
                    className="step-branch-node-wrap"
                    onDragOver={handlers.onDragOver}
                    onDrop={handlers.onDrop}
                  >
                    <StepNode
                      step={bs}
                      index={i}
                      total={list.length}
                      selected={editingId === bs.id}
                      focused={focusedId === bs.id}
                      disabled={readOnly}
                      // Branch steps match funnel rows by path-encoded
                      // step_id only (migration 0367). Legacy rows carry
                      // no branch identity, so there is deliberately NO
                      // position fallback here — overlays stay hidden
                      // rather than showing another step's numbers.
                      metrics={getFunnelMetric(funnel, bsFunnelId, null)}
                      onSelect={(id) => setFocusedId(id)}
                      onEdit={(id) => {
                        if (!readOnly) setEditingId(id);
                      }}
                      onDelete={(id) => {
                        if (!readOnly) setPendingDeleteId(id);
                      }}
                      onMoveEarlier={
                        i > 0
                          ? () => moveBranchStep(cond.id, label, bs.id, -1)
                          : undefined
                      }
                      onMoveLater={
                        i < list.length - 1
                          ? () => moveBranchStep(cond.id, label, bs.id, 1)
                          : undefined
                      }
                      onKeyDown={handleNodeKeyDown}
                      registerNodeRef={registerNodeRef}
                    />
                    {bs.type === "condition"
                      ? renderConditionBranches(bs, bsFunnelId)
                      : null}
                  </div>
                  {dropTargetKey === afterKey ? (
                    <div className="step-drop-marker step-drop-marker-branch" />
                  ) : null}
                </div>
              );
            })
          )}
          {!readOnly ? (
            <BranchStepAddControls
              branchLabel={label === "yes" ? "Yes" : "No"}
              onAdd={(type) => insertBranchStep(type, { kind: "end" })}
            />
          ) : null}
        </div>
      );
    };
    return (
      <div className="step-condition-branches">
        {branch("yes", yesSteps)}
        {branch("no", noSteps)}
      </div>
    );
  };

  return renderConditionBranches;
}

interface StepCanvasReadyViewProps {
  sequence: Sequence;
  steps: CanvasStep[];
  canMutate: boolean;
  handleSequenceChange: (next: Sequence) => void;
  sequenceVersionRef: MutableRefObject<number | null>;
  enqueueMutation: EnqueueCanvasMutation;
  sequenceId: Sequence["id"];
  setParticipantsOpen: StateSetter<boolean>;
  loadFunnel: () => Promise<void>;
  funnelLoading: boolean;
  funnel: SequenceFunnel | null;
  funnelError: string | null;
  persistenceError: string | null;
  persistenceConflict: boolean;
  onRequestConflictReload: () => void;
  retryFailedPersist: () => Promise<boolean>;
  trigger: SequenceTrigger | null;
  setTriggerEditorOpen: StateSetter<boolean>;
  goal: SequenceGoal | null;
  stuckAfterDays: number;
  settingsSaving: boolean;
  saveSettings: (patch: {
    goal: SequenceGoal | null;
    stuck_after_days: number;
  }) => void;
  readOnly: boolean;
  readOnlyReason: string | null;
  addPaletteStep: (
    type: StepType,
    target: { kind: "before" | "after"; targetId: string } | { kind: "end" },
  ) => void;
  dropTargetKey: string | null;
  setDropTargetKey: StateSetter<string | null>;
  onCanvasDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onCanvasDrop: (event: DragEvent<HTMLDivElement>) => void;
  makeNodeWrapHandlers: (id: string) => {
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: () => void;
  };
  editingId: string | null;
  focusedId: string | null;
  draggingStepId: string | null;
  setFocusedId: StateSetter<string | null>;
  setEditingId: StateSetter<string | null>;
  setPendingDeleteId: StateSetter<string | null>;
  handleExistingStepDragStart: (
    event: DragEvent<HTMLButtonElement>,
    id: string,
  ) => void;
  handleExistingStepDragEnd: () => void;
  moveExistingStep: (stepId: string, target: CanvasStepMoveTarget) => void;
  handleNodeKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => void;
  registerNodeRef: (id: string, element: HTMLElement | null) => void;
  renderConditionBranches: (
    condition: CanvasStep,
    conditionFunnelId: string,
  ) => ReactElement;
  handleStepDropPayload: (raw: string, target: CanvasStepMoveTarget) => void;
  canvasAnnouncement: string;
  editingStep: CanvasStep | null;
  saveStep: (step: CanvasStep) => Promise<void>;
  cancelEdit: () => void;
  pendingDeleteStep: CanvasStep | null;
  deleteStep: (id: string) => void;
  triggerEditorOpen: boolean;
  saveTrigger: (trigger: SequenceTrigger | null) => void;
  participantsOpen: boolean;
}

interface SequenceCanvasToolbarProps {
  canMutate: boolean;
  enqueueMutation: EnqueueCanvasMutation;
  funnelLoading: boolean;
  handleSequenceChange: (next: Sequence) => void;
  loadFunnel: () => Promise<void>;
  sequence: Sequence;
  sequenceId: Sequence["id"];
  sequenceVersionRef: MutableRefObject<number | null>;
  setParticipantsOpen: StateSetter<boolean>;
  steps: CanvasStep[];
}

function SequenceCanvasToolbar({
  canMutate,
  enqueueMutation,
  funnelLoading,
  handleSequenceChange,
  loadFunnel,
  sequence,
  sequenceId,
  sequenceVersionRef,
  setParticipantsOpen,
  steps,
}: SequenceCanvasToolbarProps): ReactElement {
  const activeRuns = sequence.active_runs ?? 0;
  const runtimeActionReasonId = useId();
  return (
    <div className="seq-canvas-toolbar">
      <div>
        <div className="seq-canvas-toolbar-title">
          {sequence.name ?? "Untitled sequence"}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {steps.length} draft step{steps.length === 1 ? "" : "s"} ·
          conflict-protected autosave
        </div>
      </div>
      <div className="seq-canvas-toolbar-actions">
        <SequenceStatusControl
          sequence={sequence}
          canMutate={canMutate}
          onChange={handleSequenceChange}
          versionRef={sequenceVersionRef}
          enqueueMutation={enqueueMutation}
          runtimeAvailable={SEQUENCE_RUNTIME_AVAILABLE}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!SEQUENCE_RUNTIME_AVAILABLE || sequenceId == null}
          aria-describedby={
            !SEQUENCE_RUNTIME_AVAILABLE ? runtimeActionReasonId : undefined
          }
          title={
            !SEQUENCE_RUNTIME_AVAILABLE
              ? SEQUENCE_RUNTIME_UNAVAILABLE_REASON
              : undefined
          }
          onClick={() => setParticipantsOpen(true)}
        >
          {SEQUENCE_RUNTIME_AVAILABLE
            ? `Subscribers (${activeRuns.toLocaleString()})`
            : "Subscribers"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void loadFunnel()}
          disabled={!SEQUENCE_RUNTIME_AVAILABLE || funnelLoading}
          aria-describedby={
            !SEQUENCE_RUNTIME_AVAILABLE ? runtimeActionReasonId : undefined
          }
          title={
            !SEQUENCE_RUNTIME_AVAILABLE
              ? SEQUENCE_RUNTIME_UNAVAILABLE_REASON
              : undefined
          }
        >
          {funnelLoading ? "Refreshing…" : "Refresh metrics"}
        </button>
        {!SEQUENCE_RUNTIME_AVAILABLE ? (
          <span id={runtimeActionReasonId} className="visually-hidden">
            {SEQUENCE_RUNTIME_UNAVAILABLE_REASON}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StepCanvasReadyView(props: StepCanvasReadyViewProps): ReactElement {
  const {
    sequence,
    steps,
    canMutate,
    handleSequenceChange,
    sequenceVersionRef,
    enqueueMutation,
    sequenceId,
    setParticipantsOpen,
    loadFunnel,
    funnelLoading,
    funnel,
    funnelError,
    persistenceError,
    persistenceConflict,
    onRequestConflictReload,
    retryFailedPersist,
    trigger,
    setTriggerEditorOpen,
    goal,
    stuckAfterDays,
    settingsSaving,
    saveSettings,
    readOnly,
    readOnlyReason,
    addPaletteStep,
    dropTargetKey,
    setDropTargetKey,
    onCanvasDragOver,
    onCanvasDrop,
    makeNodeWrapHandlers,
    editingId,
    focusedId,
    draggingStepId,
    setFocusedId,
    setEditingId,
    setPendingDeleteId,
    handleExistingStepDragStart,
    handleExistingStepDragEnd,
    moveExistingStep,
    handleNodeKeyDown,
    registerNodeRef,
    renderConditionBranches,
    handleStepDropPayload,
    canvasAnnouncement,
    editingStep,
    saveStep,
    cancelEdit,
    pendingDeleteStep,
    deleteStep,
    triggerEditorOpen,
    saveTrigger,
    participantsOpen,
  } = props;
  return (
    <>
      <SequenceCanvasToolbar
        canMutate={canMutate}
        enqueueMutation={enqueueMutation}
        funnelLoading={funnelLoading}
        handleSequenceChange={handleSequenceChange}
        loadFunnel={loadFunnel}
        sequence={sequence}
        sequenceId={sequenceId}
        sequenceVersionRef={sequenceVersionRef}
        setParticipantsOpen={setParticipantsOpen}
        steps={steps}
      />

      <SequenceRuntimeNotice
        status={sequenceStatusPresentation(sequence.status)}
      />

      {persistenceError ? (
        <div className="notice" role="alert">
          <span>
            <strong>Draft save needs attention.</strong> {persistenceError}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!persistenceConflict && readOnly}
            onClick={() => {
              if (persistenceConflict) onRequestConflictReload();
              else void retryFailedPersist();
            }}
          >
            {persistenceConflict
              ? "Reload latest version"
              : "Retry failed change"}
          </button>
        </div>
      ) : null}

      <SequencePerformanceStrip
        error={funnelError}
        funnel={funnel}
        loading={funnelLoading}
        onRetry={() => void loadFunnel()}
        runtimeAvailable={SEQUENCE_RUNTIME_AVAILABLE}
        steps={steps}
      />

      <SequenceTriggerCard
        trigger={trigger}
        canMutate={canMutate}
        runtimeAvailable={SEQUENCE_RUNTIME_AVAILABLE}
        onEdit={() => setTriggerEditorOpen(true)}
      />

      <SequenceSettingsCard
        goal={goal}
        stuckAfterDays={stuckAfterDays}
        canMutate={canMutate}
        saving={settingsSaving}
        onSave={saveSettings}
      />

      <div className="step-canvas-shell">
        <StepPalette
          disabled={readOnly}
          disabledReason={readOnlyReason}
          highlightEmail={steps.length === 0}
          onAdd={(type) => addPaletteStep(type, { kind: "end" })}
        />
        <div
          className={
            "step-canvas" +
            (dropTargetKey === "end" ? " is-drop-end" : "") +
            (readOnly ? " is-readonly" : "")
          }
          onDragOver={(e) => {
            onCanvasDragOver(e);
            if (steps.length === 0) setDropTargetKey("end");
          }}
          onDrop={onCanvasDrop}
          onDragLeave={() => setDropTargetKey(null)}
          role="region"
          aria-label="Sequence step canvas"
          aria-describedby="sequence-canvas-keyboard-instructions"
        >
          <p
            id="sequence-canvas-keyboard-instructions"
            className="visually-hidden"
          >
            Add steps with the palette buttons. Use each step&apos;s Move
            earlier and Move later buttons to reorder. Arrow keys move focus
            between steps; Enter edits and Delete asks for confirmation.
          </p>
          {readOnly ? (
            <div className="notice" style={{ marginBottom: 12 }}>
              <span>{readOnlyReason ?? "This sequence is read-only."}</span>
            </div>
          ) : null}

          {steps.length === 0 ? (
            <div
              className="step-canvas-empty"
              onDragOver={onCanvasDragOver}
              onDrop={onCanvasDrop}
            >
              <div className="step-canvas-empty-arrow" aria-hidden="true">
                ◀
              </div>
              <h3>Add a step from the palette to begin</h3>
              <p>
                Choose a palette button or drag a step. Email is the most common
                starting point.
              </p>
            </div>
          ) : (
            <div
              className="step-canvas-flow"
              role="list"
              aria-label="Sequence steps"
            >
              {steps.map((s, i) => {
                const wrap = makeNodeWrapHandlers(s.id);
                const isBeforeTarget = dropTargetKey === `before:${s.id}`;
                const isAfterTarget = dropTargetKey === `after:${s.id}`;
                return (
                  <div key={s.id} className="step-canvas-row" role="listitem">
                    {i === 0 && isBeforeTarget ? (
                      <div className="step-drop-marker" aria-hidden="true" />
                    ) : null}
                    <div
                      className="step-node-wrap"
                      onDragOver={wrap.onDragOver}
                      onDrop={wrap.onDrop}
                      onDragLeave={wrap.onDragLeave}
                    >
                      <StepNode
                        step={s}
                        index={i}
                        total={steps.length}
                        selected={editingId === s.id}
                        focused={focusedId === s.id}
                        disabled={readOnly}
                        dragging={draggingStepId === s.id}
                        draggable={!readOnly}
                        // Prefer the path-encoded step_id (new producers);
                        // fall back to the flat position for legacy rows.
                        metrics={getFunnelMetric(
                          funnel,
                          topLevelFunnelStepId(s.position),
                          s.position,
                        )}
                        onSelect={(id) => setFocusedId(id)}
                        onEdit={(id) => {
                          if (!readOnly) setEditingId(id);
                        }}
                        onDelete={(id) => {
                          if (!readOnly) setPendingDeleteId(id);
                        }}
                        onDragStart={handleExistingStepDragStart}
                        onDragEnd={handleExistingStepDragEnd}
                        onMoveEarlier={
                          i > 0
                            ? () =>
                                moveExistingStep(s.id, {
                                  kind: "before",
                                  targetId: steps[i - 1]!.id,
                                })
                            : undefined
                        }
                        onMoveLater={
                          i < steps.length - 1
                            ? () =>
                                moveExistingStep(s.id, {
                                  kind: "after",
                                  targetId: steps[i + 1]!.id,
                                })
                            : undefined
                        }
                        onKeyDown={handleNodeKeyDown}
                        registerNodeRef={registerNodeRef}
                      />
                    </div>
                    {s.type === "condition"
                      ? renderConditionBranches(
                          s,
                          topLevelFunnelStepId(s.position),
                        )
                      : null}
                    {i < steps.length - 1 ? (
                      <StepConnector
                        active={
                          isAfterTarget ||
                          dropTargetKey === `before:${steps[i + 1]?.id}`
                        }
                        disabled={readOnly}
                        dropEffect={draggingStepId ? "move" : "copy"}
                        onDropPayload={(raw) =>
                          handleStepDropPayload(raw, {
                            kind: "after",
                            targetId: s.id,
                          })
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
              {/* End-of-flow drop zone */}
              <div
                className={
                  "step-canvas-end" +
                  (dropTargetKey === "end" ? " is-drop-target" : "")
                }
                onDragOver={(e) => {
                  if (readOnly) return;
                  if (
                    !Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME)
                  )
                    return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = draggingStepId ? "move" : "copy";
                  setDropTargetKey("end");
                }}
                onDrop={onCanvasDrop}
              >
                Add with the palette, or drop here
              </div>
            </div>
          )}

          {/* Debounced reorder hint (if any pending) — informational */}
          <div className="step-canvas-spacer" />
          <div
            className="visually-hidden"
            aria-live="polite"
            aria-atomic="true"
          >
            {canvasAnnouncement}
          </div>
        </div>

        {editingStep ? (
          <StepEditor
            step={editingStep}
            readOnly={readOnly}
            sequenceId={sequenceId}
            // The variant-assignment preview only resolves TOP-LEVEL
            // 1-based positions; steps nested in a condition branch have
            // no flat position identity on the wire.
            isTopLevel={steps.some((s) => s.id === editingStep.id)}
            onSave={saveStep}
            onCancel={cancelEdit}
            onDelete={(id) => {
              setPendingDeleteId(id);
            }}
          />
        ) : null}

        {pendingDeleteStep ? (
          <ConfirmDeleteOverlay
            stepLabel={pendingDeleteStep.type}
            onCancel={() => setPendingDeleteId(null)}
            onConfirm={() => {
              const id = pendingDeleteStep.id;
              setPendingDeleteId(null);
              deleteStep(id);
            }}
          />
        ) : null}
      </div>

      <SequenceTriggerEditor
        open={SEQUENCE_RUNTIME_AVAILABLE && triggerEditorOpen}
        initial={trigger}
        onClose={() => setTriggerEditorOpen(false)}
        onSave={saveTrigger}
      />

      {SEQUENCE_RUNTIME_AVAILABLE && sequenceId != null ? (
        <SequenceParticipantsDrawer
          open={participantsOpen}
          onClose={() => setParticipantsOpen(false)}
          sequenceId={sequenceId}
          steps={steps}
          activeRunsHint={sequence.active_runs ?? undefined}
          stuckAfterDays={stuckAfterDays}
        />
      ) : null}
    </>
  );
}

export function StepCanvas({
  sequence: initialSequence,
  canMutate,
  onSequenceChange,
}: Props): ReactElement {
  const sequenceId = initialSequence.id;
  const [steps, setSteps] = useState<CanvasStep[]>([]);
  const [sequence, setSequence] = useState<Sequence>(initialSequence);
  const [trigger, setTrigger] = useState<SequenceTrigger | null>(null);
  const [triggerEditorOpen, setTriggerEditorOpen] = useState(false);
  // Roadmap sequence-level settings: goal / exit criteria + stuck
  // threshold. Captured on GET, PATCHed through saveSettings below.
  const [goal, setGoal] = useState<SequenceGoal | null>(null);
  const [stuckAfterDays, setStuckAfterDays] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [funnel, setFunnel] = useState<SequenceFunnel | null>(null);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [persistenceConflict, setPersistenceConflict] = useState(false);
  const [conflictReloadOpen, setConflictReloadOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [concurrencyReady, setConcurrencyReady] = useState(false);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [canvasAnnouncement, setCanvasAnnouncement] = useState("");
  const lastSavedRef = useRef<CanvasStep[]>([]);
  const stepsRef = useRef<CanvasStep[]>([]);
  stepsRef.current = steps;
  const activeRef = useRef(true);
  const canMutateRef = useRef(false);
  const loadRequestRef = useRef(0);
  const funnelRequestRef = useRef(0);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Tracks the row's current version (Phase-2 optimistic concurrency
  // contract). The canvas captures it on GET and feeds it back through
  // `If-Match` on every PATCH so two tabs editing the same sequence
  // can't silently clobber each other. A nullish ref means the backend
  // cannot prove the concurrency contract, so the current desktop fails
  // closed to read-only instead of falling back to last-write-wins.
  const sequenceVersionRef = useRef<number | null>(null);
  // D07-templates-seq-automations#8: every PATCH that carries the row's
  // If-Match version is chained through this tail promise so two
  // mutations fired within one round-trip can't both send the same stale
  // version (the second would 412 with a false "edited in another tab").
  // Each enqueued task re-reads sequenceVersionRef *after* the previous
  // task's response bumped it.
  // D07-templates-seq-automations#3: id of the just-dropped node whose
  // editor is open. Only that node's own drop-triggered persist may
  // silently no-op on a blank tag; any OTHER blank tag is an abandoned
  // node that must surface a toast rather than silently block saves.
  const pendingNewStepIdRef = useRef<string | null>(null);

  const canMutateDraft =
    canMutate && concurrencyReady && isEditableSequenceDraft(sequence.status);
  canMutateRef.current = canMutateDraft;
  const readOnly = !canMutateDraft;
  const readOnlyReason = !canMutate
    ? "Read-only — editor or admin access is required to change a sequence."
    : !concurrencyReady
      ? "Editing is locked because the server did not provide a valid concurrency version. Reload after the service is updated."
      : !isEditableSequenceDraft(sequence.status)
        ? `Only confirmed drafts are editable. Stored state: ${sequenceStatusPresentation(sequence.status).label}.`
        : null;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      funnelRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setSequence(initialSequence);
  }, [initialSequence]);

  useEffect(() => {
    if (canMutateDraft) return;
    setTriggerEditorOpen(false);
    setParticipantsOpen(false);
    setPendingDeleteId(null);
    setDropTargetKey(null);
  }, [canMutateDraft]);

  const registerNodeRef = useCallback(
    (id: string, el: HTMLElement | null): void => {
      const map = nodeRefs.current;
      if (el) map.set(id, el);
      else map.delete(id);
    },
    [],
  );

  const loadFunnel = useCallback(async (): Promise<void> => {
    if (!SEQUENCE_RUNTIME_AVAILABLE || sequenceId == null) {
      setFunnel(null);
      setFunnelError(null);
      setFunnelLoading(false);
      return;
    }
    const token = ++funnelRequestRef.current;
    setFunnelLoading(true);
    setFunnelError(null);
    try {
      const res = await api.getSequenceFunnel(sequenceId);
      if (!activeRef.current || token !== funnelRequestRef.current) return;
      setFunnelLoading(false);
      if (res.error) {
        setFunnelError(res.error.message);
        return;
      }
      setFunnel(res.data ?? null);
    } catch (error) {
      if (!activeRef.current || token !== funnelRequestRef.current) return;
      setFunnelLoading(false);
      setFunnelError(
        error instanceof Error && error.message
          ? error.message
          : "Sequence analytics could not be reached.",
      );
    }
  }, [sequenceId]);

  const {
    enqueueMutation,
    discardFailedPersist,
    persistNow,
    persistDebounced,
    retryFailedPersist,
  } = useCanvasPersistence({
    sequenceId,
    activeRef,
    canMutateRef,
    loadFunnel,
    sequenceVersionRef,
    lastSavedRef,
    stepsRef,
    setSteps,
    setEditingId,
    setConcurrencyReady,
    setPersistenceConflict,
    setPersistenceError,
  });

  /* ----- initial load ----- */

  useEffect(() => {
    if (sequenceId == null) {
      setErr("Sequence has no id.");
      setLoading(false);
      return;
    }
    const token = ++loadRequestRef.current;
    setLoading(true);
    setErr(null);
    setConcurrencyReady(false);
    setFunnel(null);
    setFunnelError(null);
    setPersistenceConflict(false);
    setPersistenceError(null);
    setConflictReloadOpen(false);
    setTriggerEditorOpen(false);
    setParticipantsOpen(false);
    setEditingId(null);
    setPendingDeleteId(null);
    void (async () => {
      try {
        const res = await api.getSequence(sequenceId);
        if (!activeRef.current || token !== loadRequestRef.current) return;
        if (res.error) {
          setErr(res.error.message);
          setLoading(false);
          return;
        }
        if (!res.data || typeof res.data !== "object") {
          setErr("The sequence service returned an invalid detail response.");
          setLoading(false);
          return;
        }
        const detail = res.data as SequenceDetail;
        const next = storedStepsToCanvasSteps(detail);
        const version = detail.version;
        const hasVersion =
          typeof version === "number" &&
          Number.isInteger(version) &&
          version > 0;
        sequenceVersionRef.current = hasVersion ? version : null;
        setConcurrencyReady(hasVersion);
        stepsRef.current = next;
        setSteps(next);
        setTrigger(detail.trigger ?? null);
        setGoal(detail.goal ?? null);
        setStuckAfterDays(detail.stuck_after_days ?? 0);
        const merged: Sequence = {
          ...initialSequence,
          name: detail.name ?? initialSequence.name,
          status: detail.status ?? initialSequence.status,
          active_runs: detail.active_runs ?? initialSequence.active_runs,
          steps: next.length,
        };
        setSequence(merged);
        lastSavedRef.current = next;
        setFocusedId(next[0]?.id ?? null);
        setLoading(false);
        void loadFunnel();
      } catch (error) {
        if (!activeRef.current || token !== loadRequestRef.current) return;
        setErr(
          error instanceof Error && error.message
            ? error.message
            : "The sequence detail request did not complete.",
        );
        setLoading(false);
      }
    })();
    return () => {
      if (loadRequestRef.current === token) loadRequestRef.current += 1;
    };
    // D07-templates-seq-automations#9: key this load on sequenceId ONLY.
    // Depending on the `initialSequence` object identity re-ran the full
    // GET+setSteps on every parent status/name change, which regenerated
    // step ids (closing the open editor) and reverted un-persisted local
    // state. name/status are reconciled separately by the effect above
    // (`setSequence(initialSequence)`); the merged fallback here only
    // matters on the first load for a given sequenceId, so a slightly
    // stale `initialSequence` in the closure is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceId, loadRevision]);

  /* ----- mutation helpers ----- */

  const {
    addPaletteStep,
    moveExistingStep,
    moveBranchStep,
    handleStepDropPayload,
    handleExistingStepDragStart,
    handleExistingStepDragEnd,
    deleteStep,
    saveStep,
    cancelEdit,
  } = createStepMutationActions({
    readOnly,
    pendingNewStepIdRef,
    setSteps,
    persistNow,
    persistDebounced,
    setFocusedId,
    setEditingId,
    setCanvasAnnouncement,
    nodeRefs,
    focusedId,
    editingId,
    lastSavedRef,
    stepsRef,
    setDraggingStepId,
    setDropTargetKey,
  });

  const { saveTrigger, handleSequenceChange, saveSettings } =
    createSequenceMutationActions({
      readOnly,
      activeRef,
      canMutateRef,
      sequenceId,
      trigger,
      setTrigger,
      enqueueMutation,
      sequenceVersionRef,
      setConcurrencyReady,
      setSequence,
      onSequenceChange,
      setSettingsSaving,
      setGoal,
      setStuckAfterDays,
    });

  /* ----- keyboard + drag interactions ----- */

  const {
    handleNodeKeyDown,
    onCanvasDragOver,
    onCanvasDrop,
    makeNodeWrapHandlers,
  } = createCanvasInteractions({
    steps,
    readOnly,
    moveExistingStep,
    setFocusedId,
    nodeRefs,
    setEditingId,
    setPendingDeleteId,
    draggingStepId,
    handleStepDropPayload,
    setDropTargetKey,
  });

  const renderConditionBranches = createConditionBranchRenderer({
    readOnly,
    draggingStepId,
    dropTargetKey,
    setDropTargetKey,
    pendingNewStepIdRef,
    setSteps,
    persistNow,
    stepsRef,
    setFocusedId,
    setEditingId,
    setCanvasAnnouncement,
    editingId,
    focusedId,
    funnel,
    setPendingDeleteId,
    moveBranchStep,
    handleNodeKeyDown,
    registerNodeRef,
  });

  /* ----- render ----- */

  if (loading) {
    return (
      <div className="step-canvas-shell">
        <div className="step-palette-skel" />
        <div style={{ flex: 1, padding: 16 }}>
          <div className="skel" style={{ height: 60, marginBottom: 12 }} />
          <div className="skel" style={{ height: 60, marginBottom: 12 }} />
          <div className="skel" style={{ height: 60 }} />
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="notice" role="alert">
        <span>Couldn&apos;t load steps: {err}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setLoadRevision((revision) => revision + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  const editingStep = editingId ? findStepInTree(steps, editingId) : null;
  const pendingDeleteStep = pendingDeleteId
    ? findStepInTree(steps, pendingDeleteId)
    : null;
  return (
    <>
      <StepCanvasReadyView
        sequence={sequence}
        steps={steps}
        canMutate={canMutateDraft}
        handleSequenceChange={handleSequenceChange}
        sequenceVersionRef={sequenceVersionRef}
        enqueueMutation={enqueueMutation}
        sequenceId={sequenceId}
        setParticipantsOpen={setParticipantsOpen}
        loadFunnel={loadFunnel}
        funnelLoading={funnelLoading}
        funnel={funnel}
        funnelError={funnelError}
        persistenceError={persistenceError}
        persistenceConflict={persistenceConflict}
        onRequestConflictReload={() => setConflictReloadOpen(true)}
        retryFailedPersist={retryFailedPersist}
        trigger={trigger}
        setTriggerEditorOpen={setTriggerEditorOpen}
        goal={goal}
        stuckAfterDays={stuckAfterDays}
        settingsSaving={settingsSaving}
        saveSettings={saveSettings}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        addPaletteStep={addPaletteStep}
        dropTargetKey={dropTargetKey}
        setDropTargetKey={setDropTargetKey}
        onCanvasDragOver={onCanvasDragOver}
        onCanvasDrop={onCanvasDrop}
        makeNodeWrapHandlers={makeNodeWrapHandlers}
        editingId={editingId}
        focusedId={focusedId}
        draggingStepId={draggingStepId}
        setFocusedId={setFocusedId}
        setEditingId={setEditingId}
        setPendingDeleteId={setPendingDeleteId}
        handleExistingStepDragStart={handleExistingStepDragStart}
        handleExistingStepDragEnd={handleExistingStepDragEnd}
        moveExistingStep={moveExistingStep}
        handleNodeKeyDown={handleNodeKeyDown}
        registerNodeRef={registerNodeRef}
        renderConditionBranches={renderConditionBranches}
        handleStepDropPayload={handleStepDropPayload}
        canvasAnnouncement={canvasAnnouncement}
        editingStep={editingStep}
        saveStep={saveStep}
        cancelEdit={cancelEdit}
        pendingDeleteStep={pendingDeleteStep}
        deleteStep={deleteStep}
        triggerEditorOpen={triggerEditorOpen}
        saveTrigger={saveTrigger}
        participantsOpen={participantsOpen}
      />
      <ConfirmModal
        open={conflictReloadOpen}
        title="Discard the failed change and reload?"
        description="Moosewave will discard the unconfirmed local canvas snapshot and load the latest server version. Review that version, then re-apply your intended change manually."
        confirmLabel="Discard and reload"
        danger
        onConfirm={() => {
          discardFailedPersist();
          setConflictReloadOpen(false);
          setLoadRevision((revision) => revision + 1);
        }}
        onClose={() => setConflictReloadOpen(false)}
      />
    </>
  );
}

const ACCESSIBLE_STEP_TYPES: readonly StepType[] = [
  "email",
  "delay",
  "condition",
  "tag_add",
  "tag_remove",
  "exit",
];

function BranchStepAddControls({
  branchLabel,
  onAdd,
}: {
  branchLabel: string;
  onAdd: (type: StepType) => void;
}): ReactElement {
  const [type, setType] = useState<StepType>("email");
  return (
    <div
      role="group"
      aria-label={`Add step to ${branchLabel} branch`}
      style={{ display: "flex", gap: 4, marginTop: 6 }}
    >
      <select
        aria-label={`Step type for ${branchLabel} branch`}
        value={type}
        onChange={(event) => setType(event.target.value as StepType)}
        style={{ minWidth: 0, flex: 1 }}
      >
        {ACCESSIBLE_STEP_TYPES.map((stepType) => (
          <option key={stepType} value={stepType}>
            {stepTypeLabel(stepType)}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm" onClick={() => onAdd(type)}>
        Add to {branchLabel}
      </button>
    </div>
  );
}

interface ConfirmDeleteProps {
  stepLabel: StepType;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDeleteOverlay({
  stepLabel,
  onCancel,
  onConfirm,
}: ConfirmDeleteProps): ReactElement {
  return (
    <ConfirmModal
      open
      title={`Delete ${stepTypeLabel(stepLabel).toLowerCase()} step?`}
      description="This draft step and its unsaved edits will be removed from the authoring canvas. This build has no live sequence runtime, so no subscriber flow is changed."
      confirmLabel="Delete step"
      danger
      onClose={onCancel}
      onConfirm={onConfirm}
    />
  );
}
