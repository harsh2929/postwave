/**
 * StepPalette — left-rail picker. Each tile is HTML5-draggable; on
 * dragstart it stamps the step type into `dataTransfer` under
 * STEP_DRAG_MIME for the canvas / connector / branch drop targets to
 * read.
 */
import { useId, type DragEvent, type ReactElement } from "react";

import { Icon } from "../Icon";
import {
  STEP_DRAG_MIME,
  type PaletteDragPayload,
  type StepType,
  stepTypeIcon,
} from "./types";

interface Props {
  /** When true, all tiles are disabled (read-only mode). */
  disabled?: boolean;
  /** Visible explanation for the exact reason the palette is unavailable. */
  disabledReason?: string | null;
  /**
   * Historical flag: with the v0.3 backend it is a no-op because every
   * step type now round-trips through the Voice service. Kept for
   * back-compat with callers that still pass it; the StepCanvas no
   * longer sets it. Only `disabled` and `highlightEmail` matter today.
   */
  emailOnly?: boolean;
  /** Drives the pulse animation on the email tile when canvas is empty. */
  highlightEmail?: boolean;
  /** Complete keyboard/switch alternative to drag: add at canvas end. */
  onAdd: (type: StepType) => void;
}

interface Tile {
  type: StepType;
  label: string;
  blurb: string;
}

const TILES: Tile[] = [
  { type: "email", label: "Email", blurb: "Draft a message" },
  { type: "delay", label: "Delay", blurb: "Plan the next interval" },
  { type: "condition", label: "Condition", blurb: "Draft a rule branch" },
  { type: "tag_add", label: "Add tag", blurb: "Plan a tag action" },
  { type: "tag_remove", label: "Remove tag", blurb: "Plan tag removal" },
  { type: "exit", label: "Exit", blurb: "Mark a draft endpoint" },
];

export function StepPalette({
  disabled,
  disabledReason,
  emailOnly: _emailOnly,
  highlightEmail,
  onAdd,
}: Props): ReactElement {
  const helpId = useId();
  // `emailOnly` is intentionally ignored — see Props for context.
  const tileDisabled = (_t: StepType): boolean => {
    // Every type is now backend-persistable; the only reason to
    // disable a tile is the global read-only flag.
    if (disabled) return true;
    return false;
  };

  const handleDragStart = (
    e: DragEvent<HTMLButtonElement>,
    type: StepType,
  ): void => {
    if (tileDisabled(type)) {
      e.preventDefault();
      return;
    }
    const payload: PaletteDragPayload = { source: "palette", type };
    e.dataTransfer.setData(STEP_DRAG_MIME, JSON.stringify(payload));
    // Also set text/plain so dragging into a text input doesn't blow up.
    e.dataTransfer.setData("text/plain", `[postwave:step:${type}]`);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside className="step-palette" aria-label="Step palette">
      <div className="step-palette-title">Steps</div>
      <div id={helpId} className="step-palette-help">
        {disabled
          ? (disabledReason ??
            "Read-only mode: editor access is required to add or drag steps")
          : "Choose to add at the end, or drag to an exact position"}
      </div>
      <div className="step-palette-tiles">
        {TILES.map((tile) => {
          const isDisabled = tileDisabled(tile.type);
          return (
            <button
              type="button"
              key={tile.type}
              className={
                "step-palette-tile" +
                (isDisabled ? " is-disabled" : "") +
                (highlightEmail && tile.type === "email" && !isDisabled
                  ? " is-pulse"
                  : "")
              }
              draggable={!isDisabled}
              onDragStart={(e) => handleDragStart(e, tile.type)}
              onClick={() => {
                if (!isDisabled) onAdd(tile.type);
              }}
              aria-label={`Add ${tile.label} step at the end`}
              aria-disabled={isDisabled || undefined}
              aria-describedby={helpId}
              data-step-type={tile.type}
            >
              <div className={"step-palette-icon step-icon-" + tile.type}>
                <Icon name={stepTypeIcon(tile.type)} size={15} />
              </div>
              <div className="step-palette-meta">
                <div className="step-palette-label">{tile.label}</div>
                <div className="step-palette-blurb">
                  {isDisabled ? "Unavailable in this state" : tile.blurb}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
