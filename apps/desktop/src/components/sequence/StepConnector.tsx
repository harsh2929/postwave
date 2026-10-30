/**
 * StepConnector — vertical SVG line + arrowhead between two step nodes.
 *
 * The connector also acts as a drop target: dropping a palette tile on
 * the connector inserts a new step *between* the two surrounding nodes.
 */
import type { DragEvent, ReactElement } from "react";

import { STEP_DRAG_MIME } from "./types";

interface Props {
  /** When true, this connector is highlighted as the active drop target. */
  active?: boolean;
  onDropPayload?: (raw: string) => void;
  /** Disabled connectors don't accept drops (read-only mode). */
  disabled?: boolean;
  dropEffect?: "copy" | "move";
}

export function StepConnector({
  active,
  onDropPayload,
  disabled,
  dropEffect = "copy",
}: Props): ReactElement {
  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dropEffect;
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(STEP_DRAG_MIME);
    if (raw && onDropPayload) onDropPayload(raw);
  };

  return (
    <div
      className={
        "step-connector" +
        (active ? " is-active" : "") +
        (disabled ? " is-disabled" : "")
      }
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-hidden="true"
    >
      <svg width="20" height="32" viewBox="0 0 20 32" focusable="false">
        <line
          x1="10"
          y1="0"
          x2="10"
          y2="26"
          stroke="currentColor"
          strokeWidth="2"
        />
        <polygon points="6,24 14,24 10,30" fill="currentColor" />
      </svg>
    </div>
  );
}
