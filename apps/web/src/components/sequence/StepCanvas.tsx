// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The structural canvas of a sequence draft on /app/sequences/[id] — desktop
// parity rows automation-63 (add from the palette by click or drag-drop),
// automation-64 (reorder), automation-65 (slide-over step editor) and
// automation-67 (add into a condition's Yes/No branch). Desktop reference:
// apps/desktop/src/components/sequence/StepCanvas.tsx.
//
// The canvas owns no persistence. Every verb builds a pure CanvasEdit
// (@/lib/flow-canvas-model) and hands it to `onEdit`; the page applies it to
// the draft and saves through PATCH /api/v1/voice/sequences/{id} under the
// draft's If-Match version.

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  STEP_DRAG_MIME,
  STEP_KINDS,
  STEP_KIND_LABEL,
  addressKey,
  branchSteps,
  describeAddress,
  describeBranch,
  dropTargetIndex,
  insertStep,
  insertionProblem,
  moveStep,
  newStep,
  parseStepDragPayload,
  removeStep,
  replaceStep,
  sameSlice,
  sliceAt,
  stepAt,
  type CanvasEdit,
  type SlicePath,
  type StepAddress,
  type StepDragPayload,
  type StepKind,
} from "@/lib/flow-canvas-model";
import type { SequenceStoredStep } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

import { StepNode } from "./StepNode";
import { StepPalette } from "./StepPalette";

const StepEditorSlideover = dynamic(
  () => import("./StepEditor").then((module) => module.StepEditorSlideover),
  {
    ssr: false,
    loading: () => (
      <span role="status" className="sr-only">
        Loading step editor…
      </span>
    ),
  },
);

/**
 * What the page did with an edit: applied it (and started saving when the
 * draft is complete), parked it behind a confirmation, or refused it.
 */
export type CanvasEditOutcome = "applied" | "pending" | "refused";

export function BranchStepInserter({
  path,
  disabled,
  disabledReason,
  onAdd,
}: {
  path: SlicePath;
  disabled: boolean;
  disabledReason?: string;
  onAdd: (kind: StepKind) => void;
}) {
  const [kind, setKind] = useState<StepKind>("email");
  const selectId = useId();
  const last = path[path.length - 1];
  const branchLabel = last?.branch === "no" ? "No" : "Yes";
  const branchName = describeBranch(path);
  return (
    <div
      role="group"
      aria-label={`Add a step to ${branchName}`}
      className="mt-1 flex items-center gap-1"
    >
      <Label htmlFor={selectId} className="sr-only">
        Step type for {branchName}
      </Label>
      <Select
        id={selectId}
        value={kind}
        disabled={disabled}
        onChange={(event) => setKind(event.target.value as StepKind)}
        className="h-8 min-w-0 flex-1 text-xs"
      >
        {STEP_KINDS.map((option) => (
          <option key={option} value={option}>
            {STEP_KIND_LABEL[option]}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => onAdd(kind)}
        className="h-8 shrink-0 px-2 text-xs"
      >
        <Plus className="h-3.5 w-3.5" /> Add to {branchLabel}
      </Button>
    </div>
  );
}

export function StepCanvas({
  steps,
  selectedEmailPosition,
  canEdit,
  busy,
  lockedReason,
  hold,
  renderEmailMeta,
  onSelectEmail,
  onEdit,
}: {
  steps: SequenceStoredStep[];
  /** Top-level email open in the page's main editor. */
  selectedEmailPosition: number | null;
  /** Role + confirmed-draft authority, as the page already resolves it. */
  canEdit: boolean;
  /** A save or reload is in flight; structure is frozen until it settles. */
  busy: boolean;
  /** The sentence that explains a lock (edit authority, or the busy save). */
  lockedReason: string;
  /** Why the current local draft is not saved yet, when it is incomplete. */
  hold: string | null;
  renderEmailMeta?: (position: number) => ReactNode;
  onSelectEmail: (position: number) => void;
  onEdit: (edit: CanvasEdit) => CanvasEditOutcome;
}) {
  const locked = !canEdit || busy;
  const [editing, setEditing] = useState<{
    address: StepAddress;
    revision: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeGap, setActiveGap] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRef = useRef<string | null>(null);
  // Set while one of this canvas's own steps is being dragged. The drop effect
  // must match what the source allowed (palette tiles copy, steps move) or
  // the browser refuses the drop.
  const movingStepRef = useRef(false);
  const revisionRef = useRef(0);

  useEffect(() => {
    const key = pendingFocusRef.current;
    if (!key) return;
    pendingFocusRef.current = null;
    nodeRefs.current.get(key)?.focus();
  }, [steps]);

  const editingStep = editing ? stepAt(steps, editing.address) : null;

  const openEditor = (address: StepAddress) => {
    revisionRef.current += 1;
    setEditing({ address, revision: revisionRef.current });
  };

  const apply = (edit: CanvasEdit | null, refusal?: string): boolean => {
    if (!edit) {
      if (refusal) setAnnouncement(refusal);
      return false;
    }
    const outcome = onEdit(edit);
    if (outcome !== "applied") return false;
    setAnnouncement(edit.announcement);
    if (edit.focus) pendingFocusRef.current = addressKey(edit.focus);
    return true;
  };

  const addAt = (path: SlicePath, index: number, kind: StepKind) => {
    if (locked) return;
    const problem = insertionProblem(steps, path);
    if (problem) {
      setAnnouncement(problem);
      return;
    }
    const edit = insertStep(steps, path, index, newStep(kind));
    if (!apply(edit) || !edit?.focus) return;
    // A new top-level email opens in the page's main editor; exit has no
    // settings; every other new step opens here so it can be completed.
    if (kind === "exit" || (path.length === 0 && kind === "email")) return;
    pendingFocusRef.current = null;
    openEditor(edit.focus);
    setAnnouncement(`${edit.announcement} Its editor is open.`);
  };

  const onPaletteAdd = (kind: StepKind) => addAt([], steps.length, kind);

  const move = (address: StepAddress, toIndex: number) => {
    if (locked) return;
    apply(moveStep(steps, address, toIndex));
  };

  const remove = (address: StepAddress) => {
    if (locked) return;
    setEditing(null);
    apply(
      removeStep(steps, address),
      "A draft keeps at least one step, so the last one cannot be deleted.",
    );
  };

  const onDropPayload = (raw: string, path: SlicePath, gapIndex: number) => {
    if (locked) return;
    const payload: StepDragPayload | null = parseStepDragPayload(raw);
    if (!payload) return;
    if (payload.source === "palette") {
      addAt(path, gapIndex, payload.kind);
      return;
    }
    if (!sameSlice(payload.slice, path)) {
      setAnnouncement(
        "Steps move within their own list. Use the branch controls to add a step to another branch.",
      );
      return;
    }
    const slice = sliceAt(steps, path);
    if (!slice) return;
    const to = dropTargetIndex(payload.index, gapIndex, slice.length);
    if (to === null) return;
    move({ slice: path, index: payload.index }, to);
  };

  const dropGap = (path: SlicePath, gapIndex: number, isEnd: boolean) => {
    const key = `${addressKey({ slice: path, index: gapIndex })}:gap`;
    const active = activeGap === key;
    const accepts = (event: DragEvent<HTMLElement>) =>
      !locked &&
      Boolean(event.dataTransfer) &&
      Array.from(event.dataTransfer.types).includes(STEP_DRAG_MIME);
    return (
      <li
        key={key}
        aria-hidden="true"
        data-drop-gap={key}
        onDragOver={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = movingStepRef.current
            ? "move"
            : "copy";
          if (!active) setActiveGap(key);
        }}
        onDragLeave={() => {
          if (active) setActiveGap(null);
        }}
        onDrop={(event) => {
          if (locked) return;
          event.preventDefault();
          setActiveGap(null);
          movingStepRef.current = false;
          onDropPayload(
            event.dataTransfer.getData(STEP_DRAG_MIME),
            path,
            gapIndex,
          );
        }}
        className={cn(
          "rounded transition-colors",
          isEnd
            ? "my-1 border border-dashed px-2 py-1.5 text-center text-[11px] text-muted-foreground"
            : "h-1.5",
          active && "border-primary bg-primary/10",
          active && !isEnd && "h-4",
        )}
      >
        {isEnd && !locked ? "Drop a step here" : null}
      </li>
    );
  };

  const renderSlice = (
    slice: SequenceStoredStep[],
    path: SlicePath,
  ): ReactNode => (
    <ol className="space-y-0">
      {slice.map((step, index) => {
        const address: StepAddress = { slice: path, index };
        const key = addressKey(address);
        const topLevelEmail = path.length === 0 && step.type === "email";
        const lastTopLevel = path.length === 0 && slice.length <= 1;
        return (
          <Fragment key={`${key}:${step.type}`}>
            {dropGap(path, index, false)}
            <StepNode
              step={step}
              address={address}
              sliceLength={slice.length}
              selected={
                topLevelEmail && step.position === selectedEmailPosition
              }
              locked={locked}
              lockedReason={lockedReason}
              canDelete={!lastTopLevel}
              deleteBlockedReason="A draft keeps at least one step."
              meta={
                topLevelEmail ? renderEmailMeta?.(step.position) : undefined
              }
              registerRef={(element) => {
                if (element) nodeRefs.current.set(key, element);
                else nodeRefs.current.delete(key);
              }}
              onOpen={() =>
                topLevelEmail
                  ? onSelectEmail(step.position)
                  : openEditor(address)
              }
              onMove={(to) => move(address, to)}
              onDelete={() => remove(address)}
              onHandleDragStart={(event) => {
                if (locked) {
                  event.preventDefault();
                  return;
                }
                const payload: StepDragPayload = {
                  source: "canvas-step",
                  slice: [...path],
                  index,
                };
                event.dataTransfer.setData(
                  STEP_DRAG_MIME,
                  JSON.stringify(payload),
                );
                event.dataTransfer.effectAllowed = "move";
                movingStepRef.current = true;
              }}
              onHandleDragEnd={() => {
                movingStepRef.current = false;
                setActiveGap(null);
              }}
            >
              {step.type === "condition" ? renderBranches(step, address) : null}
            </StepNode>
          </Fragment>
        );
      })}
      {dropGap(path, slice.length, true)}
    </ol>
  );

  const renderBranches = (
    step: SequenceStoredStep,
    address: StepAddress,
  ): ReactNode => (
    <div className="mb-2 ml-5 mr-1 space-y-2 border-l pl-2">
      {(["yes", "no"] as const).map((branch) => {
        const path: SlicePath = [
          ...address.slice,
          { index: address.index, branch },
        ];
        const list = branchSteps(step, branch);
        const problem = insertionProblem(steps, path);
        return (
          <div
            key={branch}
            role="group"
            aria-label={`${branch === "yes" ? "Yes" : "No"} branch of ${describeAddress(address).toLowerCase()}`}
            className="space-y-0.5"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {branch === "yes" ? "Yes" : "No"}
              {list.length === 0 ? (
                <span className="ml-1 font-normal normal-case tracking-normal">
                  · no steps yet
                </span>
              ) : null}
            </p>
            {renderSlice(list, path)}
            <BranchStepInserter
              path={path}
              disabled={locked || problem !== null}
              disabledReason={locked ? lockedReason : (problem ?? undefined)}
              onAdd={(kind) => addAt(path, list.length, kind)}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col">
      {canEdit ? (
        <StepPalette
          disabled={busy}
          disabledReason={lockedReason}
          onAdd={onPaletteAdd}
        />
      ) : null}
      <section aria-label="Sequence steps" className="p-2">
        {renderSlice(steps, [])}
        {canEdit ? (
          <p className="mt-1 px-1 text-[11px] leading-snug text-muted-foreground">
            Reorder with the arrows, the drag handle, or Alt+↑ / Alt+↓ on a
            focused step.
          </p>
        ) : null}
        {hold ? (
          <p
            role="status"
            className="mt-2 rounded-md border border-warning-subtle bg-warning-subtle/40 px-2 py-1.5 text-[11px] leading-snug text-warning-emphasis"
          >
            Not saved yet — {hold}
          </p>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </section>
      {editing ? (
        <StepEditorSlideover
          key={editing.revision}
          step={editingStep}
          locationLabel={describeAddress(editing.address)}
          canEdit={!locked}
          lockedReason={lockedReason}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            const edit = replaceStep(steps, editing.address, next);
            if (apply(edit)) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
