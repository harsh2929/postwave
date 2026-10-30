/**
 * StepNode — one card on the canvas. Shows type icon, label, one-line
 * summary, optional performance metrics, and Edit / Delete buttons.
 * Selectable, focusable, keyboard-navigable (parent owns focus state +
 * key handler).
 */
import type { DragEvent, KeyboardEvent, ReactElement } from "react";

import type { SequenceFunnelStep } from "../../lib/api-client";
import { Icon } from "../Icon";
import {
  type CanvasStep,
  stepSummary,
  stepTypeIcon,
  stepTypeLabel,
} from "./types";

/**
 * One A/B arm's slice of a step's funnel counts. The analytics backend
 * attaches this per step (analytics.go FunnelVariantBreakdown, wire key
 * `variants`), keyed off the stamped sequence_funnel_events.variant_key.
 * It is genuinely on the wire but not yet modelled on the shared
 * SequenceFunnelStep type, so StepNode reads it structurally.
 */
interface StepVariantBreakdown {
  variant_key: string;
  reached: number;
  opened: number;
  clicked: number;
}

interface Props {
  step: CanvasStep;
  index: number;
  total: number;
  selected: boolean;
  focused: boolean;
  disabled?: boolean;
  dragging?: boolean;
  draggable?: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart?: (e: DragEvent<HTMLButtonElement>, id: string) => void;
  onDragEnd?: () => void;
  onMoveEarlier?: () => void;
  onMoveLater?: () => void;
  /** Forwarded to the root so parent can manage roving tabindex. */
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, id: string) => void;
  registerNodeRef: (id: string, el: HTMLElement | null) => void;
  /** Optional analytics overlay, matched by 1-based position. */
  metrics?: SequenceFunnelStep;
}

export function StepNode({
  step,
  index,
  total,
  selected,
  focused,
  disabled,
  dragging,
  draggable,
  onSelect,
  onEdit,
  onDelete,
  onDragStart,
  onDragEnd,
  onMoveEarlier,
  onMoveLater,
  onKeyDown,
  registerNodeRef,
  metrics,
}: Props): ReactElement {
  const summary = stepSummary(step);
  const dropoff = metrics?.dropoff_pct ?? 0;
  const highDropoff = dropoff > 40;
  // A/B badge for email steps carrying a variant split. Assignment is
  // deterministic per subscriber; per-arm open/click stats DO exist now
  // (analytics funnel FunnelStep.variants, keyed off the stamped
  // variant_key) and render below when funnel data is loaded.
  const variantCount = step.type === "email" ? (step.variants?.length ?? 0) : 0;
  const variantBreakdown: StepVariantBreakdown[] =
    step.type === "email"
      ? ((metrics as { variants?: StepVariantBreakdown[] } | undefined)
          ?.variants ?? [])
      : [];
  return (
    <div
      className={
        "step-node" +
        (selected ? " is-selected" : "") +
        (focused ? " is-focused" : "") +
        (dragging ? " is-dragging" : "") +
        (disabled ? " is-disabled" : "")
      }
      role="group"
      aria-label={`Controls for step ${index + 1} of ${total}`}
      aria-disabled={disabled || undefined}
      data-step-type={step.type}
    >
      <button
        ref={(element) => registerNodeRef(step.id, element)}
        type="button"
        className="step-node-main"
        aria-label={`Step ${index + 1} of ${total}: ${stepTypeLabel(step.type)} — ${summary}`}
        aria-current={selected ? "step" : undefined}
        tabIndex={focused ? 0 : -1}
        onFocus={() => onSelect(step.id)}
        onClick={() => onSelect(step.id)}
        onDoubleClick={() => onEdit(step.id)}
        onKeyDown={(e) => onKeyDown(e, step.id)}
      >
        <div
          className={"step-node-icon step-icon-" + step.type}
          aria-hidden="true"
        >
          <Icon name={stepTypeIcon(step.type)} size={15} />
        </div>
        <div className="step-node-body">
          <div className="step-node-type">
            {stepTypeLabel(step.type)}
            {variantCount >= 2 ? (
              <span
                className="badge"
                style={{ marginLeft: 6, verticalAlign: "middle" }}
                aria-label={`A/B test with ${variantCount} variants. Each subscriber deterministically gets the same arm.${variantBreakdown.length >= 2 ? " Per-arm open and click results are shown below." : " Per-arm open and click results will appear when funnel data loads."}`}
              >
                A/B ×{variantCount}
              </span>
            ) : null}
          </div>
          <div className="step-node-summary">
            {summary}
          </div>
          {metrics ? (
            <div className="step-node-metrics" aria-label="Step performance">
              <span>
                Reached {metrics.reached.toLocaleString()}
              </span>
              <span>
                Opened {metrics.opened.toLocaleString()}
              </span>
              <span>
                Clicked {metrics.clicked.toLocaleString()}
              </span>
              <span
                className={highDropoff ? "step-node-warning-chip" : undefined}
                aria-label={`Drop-off from the previous step: ${dropoff.toFixed(dropoff >= 10 ? 0 : 1)} percent${highDropoff ? ". More than 40 percent of subscribers drop off here." : ""}`}
              >
                Drop-off {dropoff.toFixed(dropoff >= 10 ? 0 : 1)}%
              </span>
            </div>
          ) : null}
          {variantBreakdown.length >= 2 ? (
            <div
              className="step-node-metrics step-node-variant-metrics"
              aria-label="Per-variant performance"
            >
              {variantBreakdown.map((v) => (
                <span key={v.variant_key}>
                  {v.variant_key} · {v.reached.toLocaleString()} reached ·{" "}
                  {v.opened.toLocaleString()} opened ·{" "}
                  {v.clicked.toLocaleString()} clicked
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </button>
      <div className="step-node-actions">
        <button
          type="button"
          className="step-node-iconbtn"
          aria-label={`Move step ${index + 1} earlier`}
          disabled={disabled || !onMoveEarlier}
          onClick={(e) => {
            e.stopPropagation();
            onMoveEarlier?.();
          }}
        >
          <Icon name="chevron-up" size={13} />
        </button>
        <button
          type="button"
          className="step-node-iconbtn"
          aria-label={`Move step ${index + 1} later`}
          disabled={disabled || !onMoveLater}
          onClick={(e) => {
            e.stopPropagation();
            onMoveLater?.();
          }}
        >
          <Icon name="chevron-down" size={13} />
        </button>
        <button
          type="button"
          className="step-node-iconbtn step-node-drag-handle"
          aria-label={`Drag step ${index + 1} to reorder; Move earlier and Move later buttons are also available`}
          disabled={disabled || !draggable}
          draggable={!disabled && !!draggable}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(step.id);
          }}
          onDragStart={(e) => {
            e.stopPropagation();
            onDragStart?.(e, step.id);
          }}
          onDragEnd={(e) => {
            e.stopPropagation();
            onDragEnd?.();
          }}
        >
          <Icon name="grip-vertical" size={13} />
        </button>
        <button
          type="button"
          className="step-node-iconbtn"
          aria-label={`Edit step ${index + 1}`}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(step.id);
          }}
        >
          <Icon name="pencil" size={13} />
        </button>
        <button
          type="button"
          className="step-node-iconbtn step-node-iconbtn-danger"
          aria-label={`Delete step ${index + 1}`}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(step.id);
          }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  );
}
