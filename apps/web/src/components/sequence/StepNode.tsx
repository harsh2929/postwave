// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// One node on the sequence canvas plus its reorder controls (desktop parity
// automation-64; desktop reference apps/desktop/src/components/sequence/
// StepNode.tsx:172-208 and StepCanvas.tsx:1058-1100). A step moves within its
// own list three ways: the drag handle, the Move earlier / Move later
// buttons, and Alt+ArrowUp / Alt+ArrowDown on the focused node.

import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import {
  STEP_KIND_LABEL,
  countSteps,
  describeAddress,
  branchSteps,
  stepSummary,
  type StepAddress,
} from "@/lib/flow-canvas-model";
import type { SequenceStoredStep } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

import { STEP_KIND_ICON } from "./StepPalette";

export function StepReorderControls({
  label,
  index,
  sliceLength,
  disabled,
  disabledReason,
  onMove,
}: {
  label: string;
  index: number;
  sliceLength: number;
  disabled: boolean;
  disabledReason?: string;
  onMove: (toIndex: number) => void;
}) {
  return (
    <>
      <IconButton
        size="sm"
        aria-label={`Move ${label} earlier`}
        title={disabled ? disabledReason : "Move earlier (Alt+↑)"}
        disabled={disabled || index === 0}
        onClick={() => onMove(index - 1)}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={`Move ${label} later`}
        title={disabled ? disabledReason : "Move later (Alt+↓)"}
        disabled={disabled || index >= sliceLength - 1}
        onClick={() => onMove(index + 1)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </IconButton>
    </>
  );
}

function deleteConsequence(step: SequenceStoredStep): string {
  const summary = stepSummary(step);
  if (step.type === "condition") {
    const nested =
      countSteps(branchSteps(step, "yes")) +
      countSteps(branchSteps(step, "no"));
    return nested > 0
      ? `“${summary}” and the ${nested} step${nested === 1 ? "" : "s"} inside its Yes and No branches are removed from this draft. There is no undo.`
      : `“${summary}” and its empty Yes and No branches are removed from this draft. There is no undo.`;
  }
  return `“${summary}” is removed from this draft and every later step moves up one place. There is no undo.`;
}

export function StepNode({
  step,
  address,
  sliceLength,
  selected,
  locked,
  lockedReason,
  canDelete,
  deleteBlockedReason,
  meta,
  children,
  registerRef,
  onOpen,
  onMove,
  onDelete,
  onHandleDragStart,
  onHandleDragEnd,
}: {
  step: SequenceStoredStep;
  address: StepAddress;
  sliceLength: number;
  /** The top-level email currently open in the main editor. */
  selected: boolean;
  /** Structure edits unavailable (role, draft state, or a save in flight). */
  locked: boolean;
  lockedReason?: string;
  canDelete: boolean;
  deleteBlockedReason?: string;
  /** Extra chips rendered on the node (fidelity for top-level emails). */
  meta?: ReactNode;
  /** Condition branches. */
  children?: ReactNode;
  registerRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onMove: (toIndex: number) => void;
  onDelete: () => void;
  onHandleDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onHandleDragEnd: () => void;
}) {
  const Icon = STEP_KIND_ICON[step.type];
  const label = describeAddress(address);
  const kindLabel = STEP_KIND_LABEL[step.type];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      !event.altKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return;
    }
    event.preventDefault();
    if (locked) return;
    const to = event.key === "ArrowUp" ? address.index - 1 : address.index + 1;
    if (to < 0 || to >= sliceLength) return;
    onMove(to);
  };

  return (
    <li
      data-step-address={label}
      className={cn(
        "rounded-md border bg-background",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex items-stretch gap-1">
        <span
          aria-hidden
          draggable={!locked}
          title={locked ? lockedReason : "Drag to reorder"}
          onDragStart={onHandleDragStart}
          onDragEnd={onHandleDragEnd}
          className={cn(
            "flex w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            locked
              ? "cursor-not-allowed opacity-40"
              : "cursor-grab hover:bg-muted",
          )}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <button
          ref={registerRef}
          type="button"
          onClick={onOpen}
          onKeyDown={onKeyDown}
          aria-current={selected ? "step" : undefined}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          className="min-w-0 flex-1 space-y-0.5 rounded-md px-1.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {label} · {kindLabel}
              </span>
            </span>
            {meta}
          </span>
          <span className="line-clamp-2 block text-[13px] leading-snug">
            {stepSummary(step)}
          </span>
        </button>
        <div className="flex flex-col justify-center gap-0.5 pr-1">
          <StepReorderControls
            label={label}
            index={address.index}
            sliceLength={sliceLength}
            disabled={locked}
            disabledReason={lockedReason}
            onMove={onMove}
          />
          <ConfirmDialog
            trigger={
              <IconButton
                size="sm"
                aria-label={`Delete ${label}`}
                title={
                  locked
                    ? lockedReason
                    : canDelete
                      ? `Delete this ${kindLabel.toLowerCase()} step`
                      : deleteBlockedReason
                }
                disabled={locked || !canDelete}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </IconButton>
            }
            title={`Delete ${kindLabel.toLowerCase()} step?`}
            description={deleteConsequence(step)}
            confirmLabel="Delete step"
            confirmVariant="destructive"
            onConfirm={onDelete}
          />
        </div>
      </div>
      {children}
    </li>
  );
}
