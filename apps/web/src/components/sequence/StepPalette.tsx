// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Step palette for the sequence canvas (desktop parity automation-63; desktop
// reference apps/desktop/src/components/sequence/StepPalette.tsx). Every tile
// is a button — clicking it appends that step to the end of the sequence, the
// complete keyboard/switch alternative — and is also HTML5-draggable onto an
// exact gap of the canvas or of a condition branch.

import { useId, type DragEvent } from "react";
import {
  GitBranch,
  LogOut,
  Mail,
  Tag,
  Tags,
  Timer,
  type LucideIcon,
} from "lucide-react";

import {
  STEP_DRAG_MIME,
  STEP_KIND_LABEL,
  type StepDragPayload,
  type StepKind,
} from "@/lib/flow-canvas-model";
import { cn } from "@/lib/utils";

export const STEP_KIND_ICON: Record<StepKind, LucideIcon> = {
  email: Mail,
  delay: Timer,
  condition: GitBranch,
  tag_add: Tag,
  tag_remove: Tags,
  exit: LogOut,
};

const TILES: { kind: StepKind; blurb: string }[] = [
  { kind: "email", blurb: "Write a message" },
  { kind: "delay", blurb: "Wait before the next step" },
  { kind: "condition", blurb: "Branch on Yes / No" },
  { kind: "tag_add", blurb: "Tag the subscriber" },
  { kind: "tag_remove", blurb: "Remove a tag" },
  { kind: "exit", blurb: "End the journey" },
];

export function StepPalette({
  disabled,
  disabledReason,
  onAdd,
}: {
  disabled: boolean;
  /** Shown in place of the usage hint when the palette is unavailable. */
  disabledReason?: string;
  /** Append a step of `kind` to the end of the sequence. */
  onAdd: (kind: StepKind) => void;
}) {
  const helpId = useId();

  const onDragStart = (event: DragEvent<HTMLButtonElement>, kind: StepKind) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    const payload: StepDragPayload = { source: "palette", kind };
    event.dataTransfer.setData(STEP_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", `[postwave:step:${kind}]`);
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <section aria-label="Step palette" className="space-y-2 border-b p-2">
      <p
        id={helpId}
        className="px-1 text-[11px] leading-snug text-muted-foreground"
      >
        {disabled
          ? (disabledReason ?? "Adding steps is unavailable right now.")
          : "Click a step to add it at the end, or drag it to an exact spot."}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {TILES.map((tile) => {
          const Icon = STEP_KIND_ICON[tile.kind];
          const label = STEP_KIND_LABEL[tile.kind];
          return (
            <button
              key={tile.kind}
              type="button"
              draggable={!disabled}
              disabled={disabled}
              aria-label={`Add ${label} step at the end`}
              aria-describedby={helpId}
              title={disabled ? disabledReason : tile.blurb}
              data-step-kind={tile.kind}
              onDragStart={(event) => onDragStart(event, tile.kind)}
              onClick={() => {
                if (!disabled) onAdd(tile.kind);
              }}
              className={cn(
                "flex min-h-10 items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-grab hover:bg-muted active:cursor-grabbing",
              )}
            >
              <Icon
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
